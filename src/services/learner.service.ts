import { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { iso, query } from '../db/pg';
import type { PgDb } from '../db/pg';
import { LOCK_CLASS } from './lockNamespaces';

/** Learner profile captured at web registration (display name for the certificate + consent). */
export class LearnerService {
  constructor(private readonly db: PgDb) {}

  /** Anon token used to replace a phone number when the raw value must be erased but a stable placeholder helps correlation. */
  private anonToken(userId: string): string {
    return `anon:${createHash('sha256').update(userId).digest('hex').slice(0, 16)}`;
  }

  /**
   * Session-level per-learner advisory lock (class 3). Runs `fn` on a dedicated client so the
   * lock is held for the whole delete/masking operation and always released.
   */
  private async withLearnerLock<T>(userId: string, fn: (client: PgDb) => Promise<T>): Promise<T> {
    if (!(this.db instanceof Pool)) return fn(this.db);
    const client = await this.db.connect();
    try {
      await client.query(`SELECT pg_advisory_lock($1, hashtext($2))`, [LOCK_CLASS.learner, `learner:${userId}`]);
      return await fn(client);
    } finally {
      try {
        await client.query(`SELECT pg_advisory_unlock($1, hashtext($2))`, [LOCK_CLASS.learner, `learner:${userId}`]);
      } catch {
        // session end releases the lock anyway
      }
      client.release();
    }
  }

  /**
   * Anonymise every identifying trace of a learner across the durable-delivery tables, run under
   * the per-learner lock. Cancels not-yet-delivered work first, then irreversibly masks phone
   * numbers and message bodies. Keeps delivery-history shape (status/kind) but redacts content.
   * The hashed opt-out block is NOT touched here (OptOutService.forgetPhone keeps it).
   */
  async anonymiseForDeletion(userId: string): Promise<void> {
    const token = this.anonToken(userId);
    await this.withLearnerLock(userId, async (client) => {
      // 1. Cancel pending work tied to this learner's outbound messages (queued/failed jobs).
      await query(
        client,
        `DELETE FROM jobs
         WHERE ref_type = 'outbound_messages'
           AND ref_id IN (SELECT id FROM outbound_messages WHERE user_id = $1)`,
        [userId],
      );
      // Jobs whose payload carries the learner id directly (scheduled-lesson intents).
      await query(
        client,
        `DELETE FROM jobs WHERE payload->>'userId' = $1`,
        [userId],
      );
      await query(
        client,
        `DELETE FROM jobs
         WHERE ref_type = 'inbound_events'
           AND ref_id IN (
             SELECT id FROM inbound_events WHERE from_user = $1 OR to_user = $1
           )`,
        [userId],
      );
      // 2. Cancel not-yet-delivered outbound rows for the learner.
      await query(
        client,
        `DELETE FROM outbound_messages
         WHERE user_id = $1 AND status NOT IN ('sent', 'delivered', 'read')`,
        [userId],
      );
      // 3. Redact delivered message rows: keep status/shape, drop content and identifiers.
      await query(
        client,
        `UPDATE outbound_messages
          SET user_id = $2, messages = '[]', twilio_sid = NULL, error_message = NULL, error_code = NULL
         WHERE user_id = $1 AND status IN ('sent', 'delivered', 'read')`,
        [userId, token],
      );
      // 4. Redact inbound events: phone, body and raw payload.
      await query(
        client,
        `UPDATE inbound_events
          SET from_user = $2, to_user = $2, body = '[redacted]', raw = '{}'
         WHERE from_user = $1 OR to_user = $1`,
        [userId, token],
      );
      // 5. Redact attempt chain (provider sids / error text).
      await query(
        client,
        `UPDATE outbound_attempts
          SET twilio_sid = NULL, error_message = NULL
         WHERE message_id IN (SELECT id FROM outbound_messages WHERE user_id = $1)`,
        [userId],
      );
      // 6. Redact dead letters for this learner's messages.
      await query(
        client,
        `UPDATE dead_letters
          SET reason = '[redacted]', payload = '{}'
         WHERE kind = 'outbound' AND ref_id IN (SELECT id FROM outbound_messages WHERE user_id = $1)`,
        [userId],
      );
    });
  }

  /**
   * Redact only one organisation's learner history when the same phone remains enrolled
   * elsewhere. Inbound events are attributable only when org_id is unambiguous.
   */
  async anonymiseForOrgDeletion(userId: string, orgId: number): Promise<void> {
    const token = this.anonToken(userId);
    await this.withLearnerLock(userId, async (client) => {
      await query(
        client,
        `DELETE FROM jobs
         WHERE ref_type = 'outbound_messages'
           AND ref_id IN (
             SELECT id FROM outbound_messages WHERE org_id = $2 AND user_id = $1
           )`,
        [userId, orgId],
      );
      await query(
        client,
        `DELETE FROM jobs
         WHERE ref_type = 'inbound_events'
           AND ref_id IN (
             SELECT id FROM inbound_events WHERE org_id = $2 AND from_user = $1
           )`,
        [userId, orgId],
      );
      await query(
        client,
        `DELETE FROM jobs
         WHERE payload->>'userId' = $1 AND payload->>'orgId' = $2::text`,
        [userId, orgId],
      );
      await query(
        client,
        `DELETE FROM outbound_messages
         WHERE org_id = $2 AND user_id = $1 AND status NOT IN ('sent', 'delivered', 'read')`,
        [userId, orgId],
      );
      await query(
        client,
        `UPDATE outbound_attempts
         SET twilio_sid = NULL, error_message = NULL
         WHERE message_id IN (
           SELECT id FROM outbound_messages WHERE org_id = $2 AND user_id = $1
         )`,
        [userId, orgId],
      );
      await query(
        client,
        `UPDATE dead_letters
         SET reason = '[redacted]', payload = '{}'
         WHERE kind = 'outbound' AND ref_id IN (
           SELECT id FROM outbound_messages WHERE org_id = $2 AND user_id = $1
         )`,
        [userId, orgId],
      );
      await query(
        client,
        `UPDATE outbound_messages
         SET user_id = $3, messages = '[]', twilio_sid = NULL,
             error_message = NULL, error_code = NULL
         WHERE org_id = $2 AND user_id = $1 AND status IN ('sent', 'delivered', 'read')`,
        [userId, orgId, token],
      );
      await query(
        client,
        `UPDATE inbound_events
         SET from_user = $3, to_user = $3, body = '[redacted]', raw = '{}'
         WHERE org_id = $2 AND (from_user = $1 OR to_user = $1)`,
        [userId, orgId, token],
      );
      await query(
        client,
        `UPDATE dead_letters
         SET reason = '[redacted]', payload = '{}'
         WHERE kind = 'inbound' AND ref_id IN (
           SELECT id FROM inbound_events WHERE org_id = $1 AND from_user = $2
         )`,
        [orgId, token],
      );
    });
  }

  /** Insert or update the learner's name. `consented_at` is set on first registration only. */
  async upsert(userId: string, name: string): Promise<void> {
    await query(
      this.db,
      `INSERT INTO learners (user_id, name) VALUES ($1, $2)
       ON CONFLICT(user_id) DO UPDATE SET name = excluded.name, updated_at = now()`,
      [userId, name],
    );
  }

  async getName(userId: string): Promise<string> {
    const { rows } = await query<{ name: string }>(
      this.db,
      'SELECT name FROM learners WHERE user_id = $1',
      [userId],
    );
    return rows[0]?.name ?? '';
  }

  /** Erase the learner profile row. Returns false when there was no row. */
  async remove(userId: string): Promise<boolean> {
    const { rowCount } = await query(this.db, 'DELETE FROM learners WHERE user_id = $1', [userId]);
    return rowCount === 1;
  }

  /** Profile creation time (ISO), or undefined when the learner is unknown. */
  async consentedAt(userId: string): Promise<string | undefined> {
    const { rows } = await query<{ consented_at: Date | string }>(
      this.db,
      'SELECT consented_at FROM learners WHERE user_id = $1',
      [userId],
    );
    const row = rows[0];
    return row ? iso(row.consented_at) : undefined;
  }
}
