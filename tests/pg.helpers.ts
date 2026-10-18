import fs from 'node:fs';
import { afterAll, beforeAll } from 'vitest';
import { Pool } from 'pg';
import { createPool, query, registerInt8Parser } from '../src/db/pg';
import { migratePostgres } from '../src/db/migratePg';
import { silentLogger } from '../src/logger';
import { portFile } from './pg.global-setup';

/**
 * Reset a test database to a pristine migrated state: truncate every app table
 * (identity sequences restart, so ids start at 1 again) and re-seed the default org.
 * The schema_migrations ledger is never touched.
 */
export async function resetDb(pool: Pool): Promise<void> {
  await query(
    pool,
    `TRUNCATE organisations, courses, lessons, lesson_items, enrollments, processed_messages,
      opt_outs, learners, certificates, quiz_answers, admin_users, admin_api_keys, audit_log,
      inbound_events, jobs, outbound_messages, outbound_attempts, dead_letters,
      course_schedules, enrollment_schedules, worker_heartbeat
     RESTART IDENTITY CASCADE`,
  );
  await query(pool, `INSERT INTO organisations (slug, name) VALUES ('default', 'Default')`);
}

/**
 * Real PostgreSQL per test file. One suite-wide cluster (tests/pg.global-setup.ts) shared
 * by every file; each file gets an isolated DATABASE created before and dropped after.
 * Set EKATRA_TEST_DATABASE_URL to use an external server instead (CI service container) —
 * never the app's DATABASE_URL, so tests can never touch real data.
 */
export interface PgFile {
  pool: Pool;
  dbName: string;
  stop: () => Promise<void>;
}

function suiteConnection(): { host: string; port: number; user: string; password: string } {
  const external = process.env['EKATRA_TEST_DATABASE_URL'];
  if (external) {
    const url = new URL(external);
    return {
      host: url.hostname,
      port: Number(url.port || 5432),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    };
  }
  const fromEnv = Number(process.env['EKATRA_PG_PORT'] ?? '');
  let port = Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 0;
  if (!port) {
    try {
      const filePort = Number(fs.readFileSync(portFile(), 'utf-8').trim());
      if (Number.isFinite(filePort) && filePort > 0) port = filePort;
    } catch {
      // No suite cluster running: start the suite through vitest (global setup owns it).
    }
  }
  if (!port) throw new Error('no test Postgres available: run via npm test (global setup starts it)');
  return { host: '127.0.0.1', port, user: 'postgres', password: 'postgres' };
}

const fileUrl = (dbName: string): string => {
  const external = process.env['EKATRA_TEST_DATABASE_URL'];
  if (external) return `${external.replace(/\/[^/]*$/, '')}/${dbName}`;
  const c = suiteConnection();
  return `postgres://${c.user}:${c.password}@${c.host}:${c.port}/${dbName}`;
};

export function pgFileContext(fileTag: string) {
  let pool: Pool | undefined;
  const dbName = `t_${fileTag.replace(/[^a-z0-9]/gi, '_').toLowerCase().slice(0, 40)}`;

  const adminPool = (): Pool => {
    const external = process.env['EKATRA_TEST_DATABASE_URL'];
    if (external) return new Pool({ connectionString: external });
    const c = suiteConnection();
    return new Pool({ host: c.host, port: c.port, user: c.user, password: c.password, database: 'postgres' });
  };
  const filePool = () =>
    createPool(
      {
        connectionString: fileUrl(dbName),
        max: 5,
        ssl: false,
        statementTimeoutMs: 10000,
        idleTimeoutMs: 10000,
      },
      silentLogger,
    );

  beforeAll(async () => {
    registerInt8Parser();
    const admin = adminPool();
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.query(`CREATE DATABASE "${dbName}"`);
    } finally {
      await admin.end();
    }
    pool = filePool();
    await migratePostgres(pool);
  }, 240000);

  afterAll(async () => {
    await pool?.end();
    pool = undefined;
    const admin = adminPool();
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  }, 120000);

  return {
    get pool(): Pool {
      if (!pool) throw new Error('pg pool not started');
      return pool;
    },
    dbName,
    /** TCP port of the suite server (for pools built directly in tests). */
    get port(): number {
      return suiteConnection().port;
    },
    /** Fresh pool to the SAME database (simulates a process restart: new connections, same data). */
    freshPool(): Pool {
      if (!pool) throw new Error('pg pool not started');
      return filePool();
    },
  };
}

export type PgFileContext = ReturnType<typeof pgFileContext>;
