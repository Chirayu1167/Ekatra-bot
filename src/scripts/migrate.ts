import dotenv from 'dotenv';
import { Pool } from 'pg';
import { migratePostgres } from '../db/migratePg';
import { createLogger } from '../logger';
import { OptOutService } from '../services/optout.service';

dotenv.config({ quiet: true });

async function main(): Promise<void> {
  const connectionString =
    process.env['MIGRATION_DATABASE_URL'] || process.env['DATABASE_URL'];
  if (!connectionString) {
    throw new Error('MIGRATION_DATABASE_URL or DATABASE_URL is required');
  }

  const sslMode = process.env['DATABASE_SSL'] || 'off';
  if (sslMode !== 'off' && sslMode !== 'require') {
    throw new Error('DATABASE_SSL must be "off" or "require"');
  }
  const nodeEnv = process.env['NODE_ENV'] || 'development';
  const optOutSecret = process.env['OPTOUT_HASH_SECRET'] || undefined;
  const optOutSecretPrevious = process.env['OPTOUT_HASH_SECRET_PREVIOUS'] || undefined;
  if (nodeEnv === 'production' && (!optOutSecret || optOutSecret.length < 32)) {
    throw new Error('OPTOUT_HASH_SECRET is required in production and must be at least 32 characters');
  }

  const logger = createLogger();
  const pool = new Pool({
    connectionString,
    max: 1,
    statement_timeout: 0,
    ...(sslMode === 'require' ? { ssl: { rejectUnauthorized: true } } : {}),
  });
  try {
    await migratePostgres(pool, undefined, logger);
    const optOuts = new OptOutService(pool, optOutSecret, optOutSecretPrevious);
    await optOuts.backfillHashes();
    await optOuts.migrateToHmac();
    logger.info('db.migration_job.completed');
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  const message =
    error instanceof Error && /^(MIGRATION_DATABASE_URL|DATABASE_SSL|OPTOUT_HASH_SECRET)/.test(error.message)
      ? error.message
      : 'Migration job failed; verify direct database connectivity and schema permissions.';
  console.error(message);
  process.exitCode = 1;
});
