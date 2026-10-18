import { query } from '../db/pg';
import type { PgDb } from '../db/pg';
import { backoffMs } from './retry';

export type JobKind = 'inbound_process' | 'outbound_send';
export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed';

export interface Job {
  id: number;
  kind: JobKind;
  dedupeKey: string;
  refType: string;
  refId: number | null;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  runAt: string;
}

/**
 * Postgres work queue. Enqueue is idempotent on (kind, dedupe_key): the same
 * logical work can be enqueued any number of times and still yields one row.
 * Workers claim with SELECT ... FOR UPDATE SKIP LOCKED so two workers never
 * take the same job; stuck rows are reclaimed after the visibility timeout.
 * Retry uses exponential backoff + jitter (see retry.ts). All SQL lives here.
 */
export class JobService {
  constructor(private readonly db: PgDb) {}

  /** Idempotent enqueue. Returns true when the row was newly created. */
  async enqueue(job: {
    kind: JobKind;
    dedupeKey: string;
    refType?: string;
    refId?: number | null;
    payload?: Record<string, unknown>;
    maxAttempts?: number;
    runAt?: Date | null;
  }, db: PgDb = this.db): Promise<boolean> {
    const { rowCount } = await query(
      db,
      `INSERT INTO jobs (kind, dedupe_key, ref_type, ref_id, payload, max_attempts, run_at, visible_at)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, now()), COALESCE($7, now()))
       ON CONFLICT (kind, dedupe_key) DO NOTHING`,
      [
        job.kind,
        job.dedupeKey,
        job.refType ?? '',
        job.refId ?? null,
        JSON.stringify(job.payload ?? {}),
        job.maxAttempts ?? 6,
        job.runAt ? job.runAt.toISOString() : null,
      ],
    );
    return rowCount === 1;
  }

  /** Claim the next due job of the given kinds. Undefined when none is due. */
  async claimDue(kinds: JobKind[], visibilityTimeoutSecs: number, workerId: string): Promise<Job | undefined> {
    const { rows } = await query<Record<string, unknown>>(
      this.db,
      `UPDATE jobs
       SET status = 'processing', attempts = attempts + 1, locked_by = $2,
           visible_at = now() + make_interval(secs => $3), updated_at = now()
       WHERE id = (
         SELECT id FROM jobs
         WHERE status = 'queued' AND kind = ANY($1) AND run_at <= now() AND visible_at <= now()
         ORDER BY run_at, id
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [kinds, workerId, visibilityTimeoutSecs],
    );
    return rows[0] ? mapRow(rows[0]) : undefined;
  }

  async complete(id: number): Promise<void> {
    await query(
      this.db,
      `UPDATE jobs SET status = 'completed', visible_at = now(), updated_at = now() WHERE id = $1`,
      [id],
    );
  }

  /** Put a claimed job back to queued with a future run_at (deferral, not a failure). */
  async requeue(id: number, runAt: Date): Promise<void> {
    await query(
      this.db,
      `UPDATE jobs SET status = 'queued', run_at = $2, visible_at = $2, locked_by = NULL, updated_at = now() WHERE id = $1`,
      [id, runAt.toISOString()],
    );
  }

  /** Terminal failure without consuming the retry budget (e.g. poison message). */
  async failTerminal(id: number, error: string, code?: string): Promise<void> {
    await query(
      this.db,
      `UPDATE jobs SET status = 'failed', last_error = $2, last_error_code = $3, visible_at = now(), updated_at = now() WHERE id = $1`,
      [id, error.slice(0, 1000), code ?? null],
    );
  }

  async findByDedupe(kind: JobKind, dedupeKey: string): Promise<Job | undefined> {
    const { rows } = await query<Record<string, unknown>>(
      this.db,
      'SELECT * FROM jobs WHERE kind = $1 AND dedupe_key = $2',
      [kind, dedupeKey],
    );
    const row = rows[0];
    return row ? mapRow(row) : undefined;
  }

  /**
   * Schedule a retry with backoff+jitter, or mark terminally failed when the cap
   * is reached (the caller then moves the work to dead letters). Returns true
   * when another attempt was scheduled.
   */
  async retryOrFail(id: number, error: string, code?: string): Promise<boolean> {
    const { rows } = await query<{ attempts: number; max_attempts: number }>(
      this.db,
      'SELECT attempts, max_attempts FROM jobs WHERE id = $1',
      [id],
    );
    const row = rows[0];
    if (!row) return false;
    if (Number(row.attempts) >= Number(row.max_attempts)) {
      await query(
        this.db,
        `UPDATE jobs SET status = 'failed', last_error = $2, last_error_code = $3, visible_at = now(), updated_at = now() WHERE id = $1`,
        [id, error.slice(0, 1000), code ?? null],
      );
      return false;
    }
    const delay = backoffMs(Number(row.attempts));
    await query(
      this.db,
      `UPDATE jobs SET status = 'queued', last_error = $2, last_error_code = $3,
         run_at = now() + make_interval(secs => $4), visible_at = now() + make_interval(secs => $4),
         updated_at = now() WHERE id = $1`,
      [id, error.slice(0, 1000), code ?? null, Math.max(1, Math.round(delay / 1000))],
    );
    return true;
  }

  /** Crash recovery: stuck 'processing' rows become claimable again. Returns count. */
  async reclaimStuck(): Promise<number> {
    const { rowCount } = await query(
      this.db,
      `UPDATE jobs SET status = 'queued', updated_at = now()
       WHERE status = 'processing' AND visible_at < now()`,
    );
    return rowCount;
  }

  async countByStatus(kind: JobKind, status: JobStatus): Promise<number> {
    const { rows } = await query<{ n: number }>(
      this.db,
      'SELECT COUNT(*) AS n FROM jobs WHERE kind = $1 AND status = $2',
      [kind, status],
    );
    return Number(rows[0]?.n ?? 0);
  }
}

function mapRow(row: Record<string, unknown>): Job {
  return {
    id: Number(row['id']),
    kind: row['kind'] as JobKind,
    dedupeKey: String(row['dedupe_key']),
    refType: String(row['ref_type'] ?? ''),
    refId: row['ref_id'] == null ? null : Number(row['ref_id']),
    payload: (row['payload'] as Record<string, unknown>) ?? {},
    status: row['status'] as JobStatus,
    attempts: Number(row['attempts'] ?? 0),
    maxAttempts: Number(row['max_attempts'] ?? 6),
    runAt: String(row['run_at']),
  };
}
