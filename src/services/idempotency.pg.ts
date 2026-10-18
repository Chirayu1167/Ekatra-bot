import { query } from '../db/pg';
import type { PgDb } from '../db/pg';
import type { IdempotencyStore } from './idempotency';

/**
 * Persistent idempotency store: the MessageSid is the primary key of `processed_messages`, so
 * a duplicate webhook is detected even after a restart. `claim` is a single atomic
 * INSERT .. ON CONFLICT DO NOTHING (row count decides), never read-then-insert, so
 * concurrent instances cannot double-claim.
 *
 * Reduces duplicate processing; it is NOT exactly-once delivery. If the process dies after a
 * claim but before the reply is sent, that retry is skipped. Progress is only committed after a
 * successful send, so the cost is a missing reply (the learner re-sends NEXT), never a skipped
 * lesson.
 */
export class PgIdempotencyStore implements IdempotencyStore {
  constructor(private readonly db: PgDb) {}

  async claim(key: string): Promise<boolean> {
    const { rowCount } = await query(
      this.db,
      'INSERT INTO processed_messages (message_sid) VALUES ($1) ON CONFLICT DO NOTHING',
      [key],
    );
    return rowCount === 1;
  }

  async release(key: string): Promise<void> {
    await query(this.db, 'DELETE FROM processed_messages WHERE message_sid = $1', [key]);
  }

  /** Delete claims older than `olderThanDays`. Twilio retries happen within minutes, not weeks. */
  async prune(olderThanDays: number): Promise<number> {
    const { rowCount } = await query(
      this.db,
      'DELETE FROM processed_messages WHERE claimed_at < now() - make_interval(days => $1)',
      [Math.max(1, Math.floor(olderThanDays))],
    );
    return rowCount;
  }
}
