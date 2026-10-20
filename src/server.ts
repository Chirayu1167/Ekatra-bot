import dotenv from 'dotenv';
import { createApp } from './app';
import {
  assertProductionIngress,
  ConfigError,
  loadEnv,
  shouldRunMigrationsAtStartup,
  type Env,
} from './config/env';
import { createPool } from './db/pg';
import { migratePostgres } from './db/migratePg';
import { createLogger } from './logger';
import { AdminAuthService } from './services/adminAuth.service';
import { CertificateService } from './services/certificate.service';
import { CourseService } from './services/course.service';
import { OrganisationsService } from './services/organisations.service';
import { LearnerService } from './services/learner.service';
import { EnrollmentService } from './services/enrollment.service';
import crypto from 'node:crypto';
import { InboundEventService } from './services/inboundEvents.service';
import { JobService } from './services/jobs.service';
import { OutboundService } from './services/outbound.service';
import { SchedulerService } from './services/scheduler.service';
import { DeadLetterService } from './services/deadLetters.service';
import { OptOutService } from './services/optout.service';

dotenv.config({ quiet: true });

function loadEnvOrExit(): Env {
  try {
    return loadEnv();
  } catch (err) {
    // Fail fast with a clear, secret-free message.
    console.error(err instanceof ConfigError ? err.message : err);
    process.exit(1);
  }
}

const env = loadEnvOrExit();
try {
  assertProductionIngress(env);
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
}
const logger = createLogger();

const pool = createPool(
  {
    connectionString: env.DATABASE_URL,
    max: env.DATABASE_POOL_MAX,
    ssl: env.DATABASE_SSL === 'require',
    statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
    idleTimeoutMs: env.DATABASE_IDLE_TIMEOUT_MS,
  },
  logger,
);

const db = pool;
const orgs = new OrganisationsService(db);
const auth = new AdminAuthService(db);
const courses = new CourseService(db);
const enrollments = new EnrollmentService(db);
const inbound = new InboundEventService(db);
const jobs = new JobService(db);
const outbound = new OutboundService(db);
const schedules = new SchedulerService(db);
const learners = new LearnerService(db);
const optOuts = new OptOutService(db, env.OPTOUT_HASH_SECRET, env.OPTOUT_HASH_SECRET_PREVIOUS);
// Dead-letter scope needs the same stores the worker uses (no sending here).
const deadLetters = new DeadLetterService(db, outbound, jobs, optOuts, enrollments, courses);

// NOTE: the API process never sends WhatsApp messages and never runs the bot:
// the webhook only accepts inbound events durably (see whatsapp.controller) and
// the worker (src/worker.ts) owns the CourseBot + Twilio sender + scheduler.
const certificates = new CertificateService(
  db,
  learners,
  env.CERTIFICATE_SECRET ??
    crypto.createHash('sha256').update(`${env.TWILIO_AUTH_TOKEN}:certificates`).digest('hex'),
);

async function buildApp() {
  if (shouldRunMigrationsAtStartup(env)) {
    // Migrations run under an advisory lock; a failure aborts startup before listening.
    await migratePostgres(pool, undefined, logger);
    await optOuts.backfillHashes();
    await optOuts.migrateToHmac();
  } else {
    logger.info('db.migration_job.required_before_start');
  }
  // Admin API is on when the bootstrap key is set or any users exist; otherwise 404 (off).
  const adminOn = env.ADMIN_API_KEY ? true : await auth.hasUsers();
  return createApp({
  env,
  db: pool,
  inbound,
  jobs,
  statusCallback: {
    reconcile: { db, outbound, enrollments, certificates },
    logger,
  },
  logger,
  mediaDir: env.MEDIA_DIR,
  courses,
  enrollments,
  learners,
  optOuts,
  orgs,
  certificates,
  ...(adminOn && {
    admin: {
      db,
      courses,
      orgs,
      auth,
      enrollments,
      learners,
      optOuts,
      certificates,
      inbound,
      outbound,
      schedules,
      deadLetters,
      ...(env.ADMIN_API_KEY ? { bootstrapKey: env.ADMIN_API_KEY } : {}),
    },
  }),
  });
}

async function main(): Promise<void> {
  const app = await buildApp();

  if (!env.PUBLIC_BASE_URL) {
    logger.warn('certificates.no_public_url', {
      note: 'Set PUBLIC_BASE_URL so certificate links/PDFs can be sent to learners.',
    });
  }

  if (!env.ADMIN_API_KEY) {
    logger.warn('admin.disabled', { note: 'Set ADMIN_API_KEY to enable the /admin course API.' });
  }

  if (!env.TWILIO_WEBHOOK_VALIDATE) {
    logger.warn('twilio.signature.validation_disabled', {
      note: 'Incoming webhooks are NOT verified. Use only for local development.',
    });
  }

  const server = app.listen(env.PORT, () => {
    logger.info('server.started', {
      port: env.PORT,
      signatureValidation: env.TWILIO_WEBHOOK_VALIDATE,
    });
  });

  const shutdown = (signal: string): void => {
    logger.info('server.stopping', { signal });
    server.close(() => {
      void pool.end().finally(() => process.exit(0));
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

void main().catch((err: unknown) => {
  // Migration failure (or any boot error) aborts startup. Secret-free: never log env values.
  console.error(err instanceof Error ? err.message : err);
  void pool.end().finally(() => process.exit(1));
});
