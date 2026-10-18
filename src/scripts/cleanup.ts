import dotenv from 'dotenv';
import { loadEnv } from '../config/env';
import { createPool, query } from '../db/pg';
import type { Pool } from 'pg';
import { createLogger } from '../logger';

export interface CleanupOptions {
  processedDays: number;
  auditDays: number;
  /** Durable-delivery retention (days). Only expired rows are pruned. */
  jobDays?: number;
  attemptDays?: number;
  inboundDays?: number;
  deadLetterDays?: number;
}

export interface CleanupResult {
  processedMessages: number;
  auditLog: number;
  jobs: number;
  attempts: number;
  inboundEvents: number;
  deadLetters: number;
}

/**
 * Safe retention cleanup. Deletes ONLY:
 * - processed webhook ids older than `processedDays` (Twilio retries in minutes, not weeks), and
 * - audit-log rows older than `auditDays`.
 * NEVER touches opt_outs (the block must survive), enrollments, certificates or learners.
 *
 * Durable-delivery pruning (Phase 3 closeout):
 * - jobs: completed/failed rows older than `jobDays`.
 * - outbound_attempts: rows older than `attemptDays`.
 * - inbound_events: completed/failed events older than `inboundDays`.
 * - dead_letters: completed/discarded rows older than `deadLetterDays`.
 * Open/in-flight rows are never pruned.
 */
export async function runCleanup(db: Pool, opts: CleanupOptions): Promise<CleanupResult> {
  const processed = await query(
    db,
    'DELETE FROM processed_messages WHERE claimed_at < now() - make_interval(days => $1)',
    [Math.max(1, Math.floor(opts.processedDays))],
  );
  const audit = await query(
    db,
    'DELETE FROM audit_log WHERE created_at < now() - make_interval(days => $1)',
    [Math.max(1, Math.floor(opts.auditDays))],
  );

  const jobs = opts.jobDays
    ? await query(
        db,
        `DELETE FROM jobs
         WHERE status IN ('completed','failed')
           AND updated_at < now() - make_interval(days => $1)`,
        [Math.max(1, Math.floor(opts.jobDays))],
      )
    : { rowCount: 0 };
  const attempts = opts.attemptDays
    ? await query(
        db,
        `DELETE FROM outbound_attempts
         WHERE created_at < now() - make_interval(days => $1)`,
        [Math.max(1, Math.floor(opts.attemptDays))],
      )
    : { rowCount: 0 };
  const inbound = opts.inboundDays
    ? await query(
        db,
        `DELETE FROM inbound_events
         WHERE status IN ('completed','failed')
           AND updated_at < now() - make_interval(days => $1)`,
        [Math.max(1, Math.floor(opts.inboundDays))],
      )
    : { rowCount: 0 };
  const deadLetters = opts.deadLetterDays
    ? await query(
        db,
        `DELETE FROM dead_letters
         WHERE status IN ('completed','discarded')
           AND created_at < now() - make_interval(days => $1)`,
        [Math.max(1, Math.floor(opts.deadLetterDays))],
      )
    : { rowCount: 0 };

  return {
    processedMessages: processed.rowCount,
    auditLog: audit.rowCount,
    jobs: jobs.rowCount,
    attempts: attempts.rowCount,
    inboundEvents: inbound.rowCount,
    deadLetters: deadLetters.rowCount,
  };
}

async function main(): Promise<void> {
  dotenv.config({ quiet: true });
  const logger = createLogger();
  const env = loadEnv();
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = createPool(
    {
      connectionString: env.DATABASE_URL,
      max: 2,
      ssl: env.DATABASE_SSL === 'require',
      statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
      idleTimeoutMs: env.DATABASE_IDLE_TIMEOUT_MS,
    },
    logger,
  );
  try {
    const result = await runCleanup(pool, {
      processedDays: env.PROCESSED_MESSAGE_RETENTION_DAYS,
      auditDays: env.AUDIT_LOG_RETENTION_DAYS,
      jobDays: env.JOB_RETENTION_DAYS,
      attemptDays: env.ATTEMPT_RETENTION_DAYS,
      inboundDays: env.INBOUND_EVENT_RETENTION_DAYS,
      deadLetterDays: env.DEAD_LETTER_RETENTION_DAYS,
    });
    logger.info('cleanup.done', {
      processedMessages: result.processedMessages,
      auditLog: result.auditLog,
      jobs: result.jobs,
      attempts: result.attempts,
      inboundEvents: result.inboundEvents,
      deadLetters: result.deadLetters,
    });
  } finally {
    await pool.end();
  }
}

// Run only when executed directly (`npm run cleanup`), not when imported by tests.
if (process.argv[1]?.endsWith('cleanup.ts') || process.argv[1]?.endsWith('cleanup.js')) {
  void main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
