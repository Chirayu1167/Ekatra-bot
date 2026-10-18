import crypto from 'node:crypto';
import { Pool } from 'pg';
import type { Logger } from '../logger';
import { silentLogger } from '../logger';
import { PG_BASELINE_SQL } from './pgSchema';
import { PHASE3_DELIVERY_SQL, PHASE3_ITEM_SENT_SQL } from './phase3Schema';

export interface PgMigration {
  version: number;
  name: string;
  sql: string;
}

import { LOCK_CLASS } from '../services/lockNamespaces';

/**
 * Migration v4 (append-only): durable consent record on enrollments plus certificate resend
 * cooldown tracking. audit_log is pruned by retention, so consent is also stored on the
 * enrollment row itself and survives learner deletion (the row is removed with the enrollment).
 */
export const PHASE4_FOLLOWUP_SQL = `
ALTER TABLE enrollments ADD COLUMN consent_at TIMESTAMPTZ;
ALTER TABLE enrollments ADD COLUMN consent_source TEXT
  CHECK (consent_source IN ('web_registration', 'admin_attestation'));
ALTER TABLE enrollments ADD COLUMN consent_admin_id BIGINT REFERENCES admin_users(id);
-- Backfill existing enrollments from the learner's web-registration consent timestamp.
-- Only learners who actually consented (consented_at NOT NULL) are marked as consented;
-- enrollments without a consenting learner stay NULL (not consented).
UPDATE enrollments e
SET consent_at = l.consented_at, consent_source = 'web_registration'
FROM learners l
WHERE l.user_id = e.user_id
  AND l.consented_at IS NOT NULL
  AND e.consent_at IS NULL;
-- One idempotency key per certificate resend generation; last_resent_at enforces the
-- resend cooldown. resend_count advances on every successful resend so the idempotency
-- key changes per resend and a post-cooldown resend creates a NEW outbound message.
ALTER TABLE certificates ADD COLUMN last_resent_at TIMESTAMPTZ;
ALTER TABLE certificates ADD COLUMN resend_count INTEGER NOT NULL DEFAULT 0;
`;

/** Phase 4 quiz feedback; existing items remain NULL and answer/progress flow is unchanged. */
export const PHASE4_QUIZ_EXPLANATIONS_SQL = `
ALTER TABLE lesson_items ADD COLUMN explanation TEXT;
`;

/** Attribute inbound history only where the learner has an unambiguous organisation. */
export const LEARNER_EXPORT_ORG_SQL = `
ALTER TABLE inbound_events
  ADD COLUMN org_id BIGINT REFERENCES organisations(id) ON DELETE SET NULL;
UPDATE inbound_events ie
SET org_id = scoped.org_id
FROM (
  SELECT user_id, MIN(org_id) AS org_id
  FROM enrollments
  GROUP BY user_id
  HAVING COUNT(DISTINCT org_id) = 1
) scoped
WHERE ie.from_user = scoped.user_id;
CREATE INDEX inbound_events_by_org_user_created
  ON inbound_events (org_id, from_user, created_at DESC);
`;

/** Ordered Postgres migrations. Append only; checksums reject silent edits to shipped ones. */
export const PG_MIGRATIONS: readonly PgMigration[] = [
  { version: 1, name: 'baseline-v7-equivalent', sql: PG_BASELINE_SQL },
  { version: 2, name: 'phase3-durable-delivery', sql: PHASE3_DELIVERY_SQL },
  { version: 3, name: 'phase3-item-sent-markers', sql: PHASE3_ITEM_SENT_SQL },
  // 4 — Phase 4 Step 1 follow-up: durable consent record on enrollments (audit_log is pruned
  // by retention and cannot be the only consent proof) + certificate resend cooldown tracking.
  {
    version: 4,
    name: 'phase4-consent-and-cert-cooldown',
    sql: PHASE4_FOLLOWUP_SQL,
  },
  {
    version: 5,
    name: 'phase4-quiz-explanations',
    sql: PHASE4_QUIZ_EXPLANATIONS_SQL,
  },
  {
    version: 6,
    name: 'learner-export-organisation-scope',
    sql: LEARNER_EXPORT_ORG_SQL,
  },
];

export class MigrationChecksumError extends Error {
  constructor(version: number, name: string) {
    super(`Shipped Postgres migration v${version} (${name}) changed: checksum mismatch. Refusing to migrate.`);
    this.name = 'MigrationChecksumError';
  }
}

const checksumOf = (sql: string) => crypto.createHash('sha256').update(sql).digest('hex');

const LOCK_KEY_SQL = `SELECT pg_advisory_lock(${LOCK_CLASS.migration}, hashtext('ekatra_schema_migrations'))`;
const UNLOCK_KEY_SQL = `SELECT pg_advisory_unlock(${LOCK_CLASS.migration}, hashtext('ekatra_schema_migrations'))`;

export interface MigrateResult {
  applied: number[];
}

/**
 * Bring a Postgres database up to date. Safe to repeat (no-op) and safe to run
 * concurrently: a session-level advisory lock serialises migrators on ONE dedicated client,
 * taken and released (in a finally) on that same client. Each migration runs in its own
 * transaction with statement_timeout disabled (DDL/imports must not trip the app timeout);
 * a failure rolls that migration back, leaves the ledger version unchanged, and aborts
 * startup — it can never silently pass.
 */
export async function migratePostgres(
  pool: Pool,
  migrations: readonly PgMigration[] = PG_MIGRATIONS,
  logger: Logger = silentLogger,
): Promise<MigrateResult> {
  const client = await pool.connect();
  try {
    await client.query(LOCK_KEY_SQL);
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version    INTEGER PRIMARY KEY,
          name       TEXT NOT NULL,
          checksum   TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      const applied = await client.query<{ version: number; name: string; checksum: string }>(
        'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
      );
      const byVersion = new Map(applied.rows.map((r) => [r.version, r]));
      const done: number[] = [];
      for (const m of migrations) {
        const checksum = checksumOf(m.sql);
        const existing = byVersion.get(m.version);
        if (existing) {
          if (existing.checksum !== checksum || existing.name !== m.name) {
            throw new MigrationChecksumError(m.version, m.name);
          }
          continue;
        }
        await client.query('BEGIN');
        try {
          await client.query('SET LOCAL statement_timeout = 0');
          await client.query(m.sql);
          await client.query(
            'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
            [m.version, m.name, checksum],
          );
          await client.query('COMMIT');
          done.push(m.version);
          logger.info('db.migrated', { version: m.version, name: m.name });
        } catch (err) {
          try {
            await client.query('ROLLBACK');
          } catch {
            // Connection may be broken; release will clean it up.
          }
          throw err;
        }
      }
      return { applied: done };
    } finally {
      try {
        await client.query(UNLOCK_KEY_SQL);
      } catch {
        // Unlock is best-effort: session end releases the lock anyway.
      }
    }
  } finally {
    client.release();
  }
}
