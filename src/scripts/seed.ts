import dotenv from 'dotenv';
import { loadEnv } from '../config/env';
import { createPool } from '../db/pg';
import { migratePostgres } from '../db/migratePg';
import { seedSampleCourses } from '../db/seed';
import { CourseService } from '../services/course.service';
import { OrganisationsService } from '../services/organisations.service';
import { createLogger } from '../logger';

dotenv.config({ quiet: true });

// Deliberately does not need Twilio credentials: it only touches the local database.
async function main(): Promise<void> {
  const env = loadEnv();
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const logger = createLogger();
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
    await migratePostgres(pool, undefined, logger);
    const orgs = new OrganisationsService(pool);
    const { created, skipped } = await seedSampleCourses(
      await orgs.getDefaultId(),
      new CourseService(pool),
      env.PUBLIC_BASE_URL,
    );
    console.log(`Created and published: ${created.length ? created.join(', ') : '(none)'}`);
    if (skipped.length) console.log(`Already present, left unchanged: ${skipped.join(', ')}`);
    if (!env.PUBLIC_BASE_URL) {
      console.log(
        'Note: PUBLIC_BASE_URL is not set, so the sample course has no image/PDF attachments.',
      );
    }
  } finally {
    await pool.end();
  }
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
