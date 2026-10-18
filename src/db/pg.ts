import { Pool, types, type PoolClient } from 'pg';
import type { Logger } from '../logger';
import { silentLogger } from '../logger';

/**
 * Transactional helper for services holding a PgDb: pools check out a client, an already
 * checked-out client runs inline (supports nesting without savepoints).
 */
export async function transactional<T>(db: PgDb, fn: (tx: PgDb) => Promise<T>): Promise<T> {
  if (db instanceof Pool) return withTransaction(db, (client) => fn(client));
  return fn(db);
}

/** Either a pool (auto-checkout per query) or a checked-out client (inside a transaction). */
export type PgDb = Pool | PoolClient;

export interface PoolConfig {
  connectionString: string;
  max: number;
  ssl: boolean;
  statementTimeoutMs: number;
  idleTimeoutMs: number;
}

let int8ParserRegistered = false;

/**
 * node-pg returns BIGINT (and COUNT(*)) as strings. Parse to number inside the safe integer
 * range; outside it keep the raw string rather than silently corrupting the value.
 * Registered once per process (pg type parsers are global).
 */
export function registerInt8Parser(): void {
  if (int8ParserRegistered) return;
  int8ParserRegistered = true;
  types.setTypeParser(types.builtins.INT8, (value: string) => {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : value;
  });
}

export function createPool(config: PoolConfig, logger: Logger = silentLogger): Pool {
  registerInt8Parser();
  const pool = new Pool({
    connectionString: config.connectionString,
    max: config.max,
    statement_timeout: config.statementTimeoutMs,
    idleTimeoutMillis: config.idleTimeoutMs,
    ...(config.ssl ? { ssl: { rejectUnauthorized: true } } : {}),
  });
  // Idle-client errors (e.g. the server closed a connection) must be logged, never crash.
  pool.on('error', (err) => {
    logger.error('db.pool.error', { error: err instanceof Error ? err.message : String(err) });
  });
  return pool;
}

/** Typed thin wrapper over Pool/PoolClient.query. All SQL stays in the service classes. */
export async function query<T>(
  db: PgDb,
  text: string,
  params: unknown[] = [],
): Promise<{ rows: T[]; rowCount: number }> {
  const result = await db.query(text, params);
  return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
}

/**
 * Row mappers: TIMESTAMPTZ columns arrive as Date; the app speaks ISO strings.
 * Accepts strings too so unit-built rows keep working.
 */
export function iso(value: Date | string): string {
  return typeof value === 'string' ? value : value.toISOString();
}

/** True when a node-pg error is a unique-violation (replaces SQLite's message matching). */
export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === '23505'
  );
}

/**
 * Run `fn` inside a transaction on a dedicated client. Commits on success, rolls back on
 * error, always releases. Never hold the client across network calls: lock, update, commit,
 * then send (enforced by review, not by this helper — keep transaction bodies DB-only).
 */
export async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The connection may already be broken; release will clean it up.
      }
      throw err;
    }
  } finally {
    client.release();
  }
}
