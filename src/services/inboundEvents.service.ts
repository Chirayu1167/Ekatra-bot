import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { query, iso, withTransaction } from '../db/pg';
import type { PgDb } from '../db/pg';

export type InboundEventStatus = 'received' | 'processing' | 'completed' | 'failed';

export interface InboundEvent {
  id: number;
  messageSid: string;
  fromUser: string;
  toUser: string;
  body: string;
  raw: Record<string, unknown>;
  status: InboundEventStatus;
  attempts: number;
  correlationId: string;
}

/**
 * Durable inbound store. The webhook INSERTs the raw event idempotently
 * (ON CONFLICT DO NOTHING on message_sid) and enqueues work transactionally;
 * it never processes inline. Stuck jobs/events are reclaimed by the worker.
 * All SQL lives here.
 */
export class InboundEventService {
  constructor(private readonly db: PgDb) {}

  /** Run a callback on one transaction client when this service owns a pool. */
  async transaction<T>(fn: (tx: PgDb) => Promise<T>): Promise<T> {
    if (this.db instanceof Pool) return withTransaction(this.db, fn);
    return fn(this.db);
  }

  /** Idempotent accept: true = newly stored, false = duplicate. */
  async accept(event: {
    messageSid: string;
    fromUser: string;
    toUser: string;
    body: string;
    raw?: Record<string, unknown>;
  }, db: PgDb = this.db): Promise<{ isNew: boolean; correlationId: string }> {
    const correlationId = randomUUID();
    const { rowCount } = await query(
      db,
      `INSERT INTO inbound_events (org_id, message_sid, from_user, to_user, body, raw, correlation_id)
       VALUES (
         (SELECT MIN(org_id) FROM enrollments
          WHERE user_id = $2 GROUP BY user_id HAVING COUNT(DISTINCT org_id) = 1),
         $1, $2, $3, $4, $5, $6
       ) ON CONFLICT (message_sid) DO NOTHING`,
      [
        event.messageSid,
        event.fromUser,
        event.toUser,
        event.body,
        JSON.stringify(event.raw ?? {}),
        correlationId,
      ],
    );
    if (rowCount === 1) return { isNew: true, correlationId };
    const { rows } = await query<{ correlation_id: string }>(
      db,
      'SELECT correlation_id FROM inbound_events WHERE message_sid = $1',
      [event.messageSid],
    );
    return { isNew: false, correlationId: rows[0]?.correlation_id ?? '' };
  }

  /** Most recent inbound event time for a learner (ISO), or undefined when none exists. */
  async lastSeenAt(userId: string): Promise<string | undefined> {
    const { rows } = await query<{ last_seen: Date | string | null }>(
      this.db,
      'SELECT MAX(created_at) AS last_seen FROM inbound_events WHERE from_user = $1',
      [userId],
    );
    const row = rows[0];
    return row?.last_seen == null ? undefined : iso(row.last_seen);
  }

  async getBySid(messageSid: string): Promise<InboundEvent | undefined> {
    const { rows } = await query<Record<string, unknown>>(
      this.db,
      'SELECT * FROM inbound_events WHERE message_sid = $1',
      [messageSid],
    );
    const row = rows[0];
    return row ? mapRow(row) : undefined;
  }

  /** A learner's inbound events (most recent first), used by learner-data export. */
  async listByUser(userId: string, orgId: number, limit = 100): Promise<InboundEvent[]> {
    const { rows } = await query<Record<string, unknown>>(
      this.db,
      `SELECT * FROM inbound_events
       WHERE org_id = $1 AND (from_user = $2 OR to_user = $2)
       ORDER BY created_at DESC, id DESC LIMIT $3`,
      [orgId, userId, limit],
    );
    return rows.map(mapRow);
  }

  /**
   * Repair events accepted before their enqueue transaction was deployed or interrupted.
   * The idempotency constraint keeps concurrent worker sweeps safe.
   */
  async requeueOrphanedReceived(): Promise<number> {
    const { rowCount } = await query(
      this.db,
      `INSERT INTO jobs (kind, dedupe_key, ref_type, ref_id, payload)
       SELECT 'inbound_process', e.message_sid, 'inbound_events', e.id,
              jsonb_build_object('messageSid', e.message_sid)
       FROM inbound_events e
       WHERE e.status = 'received'
         AND e.created_at < now() - INTERVAL '60 seconds'
         AND NOT EXISTS (
           SELECT 1 FROM jobs j
           WHERE j.kind = 'inbound_process' AND j.dedupe_key = e.message_sid
         )
       ON CONFLICT (kind, dedupe_key) DO NOTHING`,
    );
    return rowCount;
  }

  /**
   * Cross-process per-learner serialisation: a transaction-scoped advisory lock on
   * the learner id. Held only for the DB part of processing (never across Twilio
   * or LLM calls — the caller must commit/release before any network call).
   */
  async lockLearner(userId: string): Promise<void> {
    const key = createHash('sha256').update(`ekatra:learner:${userId}`).digest('hex').slice(0, 15);
    await query(this.db, 'SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
  }

  async markCompleted(id: number): Promise<void> {
    await query(
      this.db,
      `UPDATE inbound_events SET status = 'completed', visible_at = now(), updated_at = now() WHERE id = $1`,
      [id],
    );
  }

  async markFailed(id: number, error: string): Promise<void> {
    await query(
      this.db,
      `UPDATE inbound_events SET status = 'failed', last_error = $2, visible_at = now(), updated_at = now() WHERE id = $1`,
      [id, error.slice(0, 1000)],
    );
  }

  /** Crash recovery: stuck 'processing' rows become claimable again. Returns count. */
  async reclaimStuck(): Promise<number> {
    const { rowCount } = await query(
      this.db,
      `UPDATE inbound_events SET status = 'received', updated_at = now()
       WHERE status = 'processing' AND visible_at < now()`,
    );
    return rowCount;
  }
}

function mapRow(row: Record<string, unknown>): InboundEvent {
  return {
    id: Number(row['id']),
    messageSid: String(row['message_sid']),
    fromUser: String(row['from_user']),
    toUser: String(row['to_user'] ?? ''),
    body: String(row['body'] ?? ''),
    raw: (row['raw'] as Record<string, unknown>) ?? {},
    status: row['status'] as InboundEventStatus,
    attempts: Number(row['attempts'] ?? 0),
    correlationId: String(row['correlation_id'] ?? ''),
  };
}
