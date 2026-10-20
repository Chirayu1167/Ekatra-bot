import crypto from 'node:crypto';
import { query } from '../db/pg';
import type { PgDb } from '../db/pg';

/**
 * Opt-out phone hash: keyed HMAC-SHA-256 when OPTOUT_HASH_SECRET is configured,
 * plain SHA-256 otherwise (dev/test default or pre-migration legacy rows).
 *
 * Secret rotation: when OPTOUT_HASH_SECRET_PREVIOUS is also set, both the current
 * and previous secrets are accepted when checking opt-out status. New opt-outs are
 * written only with the current secret. This enables zero-downtime secret rotation:
 *   1. Set OPTOUT_HASH_SECRET_PREVIOUS to the old secret, deploy with the new
 *      OPTOUT_HASH_SECRET. Both old and new hashes match.
 *   2. Run `migrateToCurrentSecret()` to re-hash all rows with the current secret.
 *   3. Clear OPTOUT_HASH_SECRET_PREVIOUS and redeploy.
 */
export function hashPhone(userId: string, secret?: string): string {
  const message = `optout:${userId}`;
  if (secret) {
    return crypto.createHmac('sha256', secret).update(message).digest('hex');
  }
  return crypto.createHash('sha256').update(message).digest('hex');
}

/** Plain SHA-256 hash, used to match legacy opt-out rows during the transition period. */
export function hashPhonePlain(userId: string): string {
  return crypto.createHash('sha256').update(`optout:${userId}`).digest('hex');
}

/**
 * Learners who sent STOP. Anything that sends to a learner (course delivery now, reminders
 * later) must go through the central `OptOutGuardSender`, which checks `isOptedOut` first.
 * Opt-out is GLOBAL across orgs (one WhatsApp sender) and persistent (survives restarts and
 * learner deletion via `phone_hash`).
 */
export class OptOutService {
  constructor(
    private readonly db: PgDb,
    private readonly currentSecret?: string,
    private readonly previousSecret?: string,
  ) {}

  hmacHash(userId: string): string {
    return hashPhone(userId, this.currentSecret);
  }

  private previousHmac(userId: string): string {
    return this.previousSecret ? hashPhone(userId, this.previousSecret) : '';
  }

  private plainHash(userId: string): string {
    return hashPhonePlain(userId);
  }

  /** All hash values that could match an opt-out row for this user. */
  private allHashes(userId: string): string[] {
    const hashes = new Set<string>();
    const current = this.hmacHash(userId);
    if (current) hashes.add(current);
    const previous = this.previousHmac(userId);
    if (previous) hashes.add(previous);
    const plain = this.plainHash(userId);
    if (plain) hashes.add(plain);
    return [...hashes];
  }

  async isOptedOut(userId: string): Promise<boolean> {
    const hashes = this.allHashes(userId);
    const params: unknown[] = [userId, ...hashes];
    const placeholders = hashes.map((_, i) => `$${i + 2}`).join(', ');
    const { rows } = await query<{ one: number }>(
      this.db,
      `SELECT 1 AS one FROM opt_outs WHERE user_id = $1 OR phone_hash IN (${placeholders}) LIMIT 1`,
      params,
    );
    return rows.length > 0;
  }

  /** Returns false if they were already opted out. */
  async optOut(userId: string): Promise<boolean> {
    const hmac = this.hmacHash(userId);
    const { rowCount } = await query(
      this.db,
      'INSERT INTO opt_outs (user_id, phone_hash) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING',
      [userId, hmac],
    );
    if (rowCount === 1) return true;
    // Already present: upgrade any previous/plain-hash row to the current HMAC.
    await query(this.db, 'UPDATE opt_outs SET phone_hash = $1 WHERE user_id = $2 AND phone_hash <> $1', [
      hmac,
      userId,
    ]);
    return false;
  }

  /** Returns false if they were not opted out. */
  async optIn(userId: string): Promise<boolean> {
    const hashes = this.allHashes(userId);
    const params: unknown[] = [userId, ...hashes];
    const placeholders = hashes.map((_, i) => `$${i + 2}`).join(', ');
    const { rowCount } = await query(
      this.db,
      `DELETE FROM opt_outs WHERE user_id = $1 OR phone_hash IN (${placeholders})`,
      params,
    );
    return rowCount === 1;
  }

  /**
   * Erase the raw phone number while keeping the block: used by learner-data deletion.
   * After this, `isOptedOut(phone)` still matches via `phone_hash`, but the number itself
   * is gone from the table.
   */
  async forgetPhone(userId: string): Promise<void> {
    const current = this.hmacHash(userId);
    const previous = this.previousHmac(userId);
    const plain = this.plainHash(userId);
    const hashes = new Set<string>();
    if (current) hashes.add(current);
    if (previous) hashes.add(previous);
    if (plain) hashes.add(plain);
    const hashList = [...hashes];
    const params: unknown[] = [`anon:${current.slice(0, 16)}`, current, userId, ...hashList];
    const placeholders = hashList.map((_, i) => `$${i + 4}`).join(', ');
    await query(
      this.db,
      `UPDATE opt_outs SET user_id = $1, phone_hash = $2 WHERE user_id = $3 OR phone_hash IN (${placeholders})`,
      params,
    );
  }

  /** One-time backfill for rows written before `phone_hash` existed. Idempotent. */
  async backfillHashes(): Promise<number> {
    const { rows } = await query<{ user_id: string }>(
      this.db,
      "SELECT user_id FROM opt_outs WHERE phone_hash IS NULL AND user_id NOT LIKE 'anon:%'",
    );
    const hmac = this.hmacHash;
    for (const row of rows) {
      await query(this.db, 'UPDATE opt_outs SET phone_hash = $1 WHERE user_id = $2', [
        hmac(row.user_id),
        row.user_id,
      ]);
    }
    return rows.length;
  }

  /**
   * Upgrade legacy plain-SHA-256 opt-out rows to HMAC for numbers still present in
   * enrollments or learners. Rows for deleted learners (anon: user_id) keep their legacy
   * plain hash until the number is seen again, at which point `optOut`/`forgetPhone` rewrite
   * them to HMAC. Idempotent.
   */
  async migrateToHmac(): Promise<number> {
    if (!this.currentSecret) return 0;
    const { rows } = await query<{ user_id: string; phone_hash: string }>(
      this.db,
      `SELECT o.user_id, o.phone_hash
        FROM opt_outs o
        WHERE o.user_id NOT LIKE 'anon:%'
          AND (EXISTS (SELECT 1 FROM enrollments e WHERE e.user_id = o.user_id)
            OR EXISTS (SELECT 1 FROM learners l WHERE l.user_id = o.user_id))`,
    );
    let upgraded = 0;
    for (const row of rows) {
      const expectedPlain = this.plainHash(row.user_id);
      if (row.phone_hash === expectedPlain) {
        await query(this.db, 'UPDATE opt_outs SET phone_hash = $1 WHERE user_id = $2', [
          this.hmacHash(row.user_id),
          row.user_id,
        ]);
        upgraded++;
      }
    }
    return upgraded;
  }

  /**
   * Re-hash all opt-out rows from the previous secret to the current secret. Used during
   * secret rotation after OPTOUT_HASH_SECRET_PREVIOUS has been accepted alongside the
   * current secret. Safe to run multiple times.
   */
  async migrateToCurrentSecret(): Promise<number> {
    if (!this.currentSecret || !this.previousSecret) return 0;
    const previous = this.previousHmac;
    const { rows } = await query<{ user_id: string; phone_hash: string }>(
      this.db,
      "SELECT user_id, phone_hash FROM opt_outs WHERE user_id NOT LIKE 'anon:%'",
    );
    let upgraded = 0;
    for (const row of rows) {
      if (row.phone_hash === previous(row.user_id)) {
        await query(this.db, 'UPDATE opt_outs SET phone_hash = $1 WHERE user_id = $2', [
          this.hmacHash(row.user_id),
          row.user_id,
        ]);
        upgraded++;
      }
    }
    return upgraded;
  }
}
