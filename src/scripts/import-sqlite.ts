import dotenv from 'dotenv';
import { DatabaseSync } from 'node:sqlite';
import type { Pool } from 'pg';
import { loadEnv } from '../config/env';
import { createPool, query } from '../db/pg';
import { createLogger, silentLogger, type Logger } from '../logger';
import { LIMITS } from '../types/course';

export interface ImportOptions {
  sqlitePath: string;
  pool: Pool;
  force?: boolean;
  dryRun?: boolean;
  logger?: Logger;
}

export interface ImportReport {
  dryRun: boolean;
  /** Rows per table (planned in dry-run, written delta otherwise). */
  tables: Record<string, number>;
  integrity: { orphans: number };
  spots: {
    completedEnrollment: boolean;
    optOutHash: boolean;
    certificate: boolean;
    adminKeyHash: boolean;
  };
}

interface TableSpec {
  name: string;
  columns: string[];
  orderBy: string;
  convert?: (row: Record<string, unknown>) => Record<string, unknown>;
}

const toBool = (v: unknown): boolean | null =>
  v === null || v === undefined ? null : v === 1 || v === true || v === '1' || v === 't';

const TABLES: TableSpec[] = [
  { name: 'organisations', columns: ['id', 'slug', 'name', 'created_at'], orderBy: 'id' },
  {
    name: 'courses',
    columns: ['id', 'org_id', 'slug', 'title', 'description', 'status', 'created_at', 'updated_at'],
    orderBy: 'id',
  },
  {
    name: 'lessons',
    columns: ['id', 'course_id', 'position', 'title', 'created_at', 'updated_at'],
    orderBy: 'id',
  },
  {
    name: 'lesson_items',
    columns: ['id', 'lesson_id', 'position', 'kind', 'text', 'url', 'options', 'explanation'],
    orderBy: 'id',
    convert: (r) => {
      const explanation =
        r['explanation'] == null ? null : String(r['explanation']).trim();
      if (explanation && explanation.length > LIMITS.quizExplanationMax) {
        throw new Error(
          `Import failed: quiz explanation must be at most ${LIMITS.quizExplanationMax} characters`,
        );
      }
      return {
        ...r,
        options: r['options'] == null ? null : String(r['options']),
        explanation,
      };
    },
  },
  {
    name: 'enrollments',
    columns: ['id', 'org_id', 'user_id', 'course_id', 'status', 'last_delivered_position', 'started_at', 'updated_at', 'completed_at'],
    orderBy: 'id',
  },
  { name: 'processed_messages', columns: ['message_sid', 'claimed_at'], orderBy: 'message_sid' },
  { name: 'opt_outs', columns: ['user_id', 'phone_hash', 'opted_out_at'], orderBy: 'user_id' },
  { name: 'learners', columns: ['user_id', 'name', 'consented_at', 'updated_at'], orderBy: 'user_id' },
  {
    name: 'certificates',
    columns: ['id', 'enrollment_id', 'code', 'learner_name', 'course_title', 'issued_at'],
    orderBy: 'id',
  },
  {
    name: 'quiz_answers',
    columns: ['id', 'enrollment_id', 'position', 'chosen', 'correct', 'answered_at'],
    orderBy: 'id',
    convert: (r) => ({ ...r, correct: toBool(r['correct']) }),
  },
  {
    name: 'admin_users',
    columns: ['id', 'org_id', 'name', 'role', 'created_at'],
    orderBy: 'id',
  },
  {
    name: 'admin_api_keys',
    columns: ['id', 'user_id', 'key_hash', 'prefix', 'created_at', 'last_used_at', 'revoked_at', 'expires_at'],
    orderBy: 'id',
  },
  {
    name: 'audit_log',
    columns: ['id', 'actor_user_id', 'org_id', 'action', 'target', 'created_at'],
    orderBy: 'id',
  },
];

const IDENTITY_TABLES = [
  'organisations',
  'courses',
  'lessons',
  'lesson_items',
  'enrollments',
  'certificates',
  'quiz_answers',
  'admin_users',
  'admin_api_keys',
  'audit_log',
];

const ORPHAN_CHECKS: [string, string][] = [
  ['lessons', `SELECT COUNT(*) AS n FROM lessons l LEFT JOIN courses c ON c.id = l.course_id WHERE c.id IS NULL`],
  ['lesson_items', `SELECT COUNT(*) AS n FROM lesson_items i LEFT JOIN lessons l ON l.id = i.lesson_id WHERE l.id IS NULL`],
  ['enrollments_course', `SELECT COUNT(*) AS n FROM enrollments e LEFT JOIN courses c ON c.id = e.course_id WHERE c.id IS NULL`],
  ['enrollments_org', `SELECT COUNT(*) AS n FROM enrollments e LEFT JOIN organisations o ON o.id = e.org_id WHERE o.id IS NULL`],
  ['certificates', `SELECT COUNT(*) AS n FROM certificates c LEFT JOIN enrollments e ON e.id = c.enrollment_id WHERE e.id IS NULL`],
  ['quiz_answers', `SELECT COUNT(*) AS n FROM quiz_answers q LEFT JOIN enrollments e ON e.id = q.enrollment_id WHERE e.id IS NULL`],
  ['admin_api_keys', `SELECT COUNT(*) AS n FROM admin_api_keys k LEFT JOIN admin_users u ON u.id = k.user_id WHERE u.id IS NULL`],
];

async function tableCount(
  pool: Pool,
  table: string,
): Promise<number> {
  const { rows } = await query<{ n: number }>(pool, `SELECT COUNT(*) AS n FROM ${table}`);
  return Number(rows[0]?.n ?? 0);
}

/**
 * A target is import-ready when it holds no user data: every table empty except
 * `organisations`, which may contain exactly the seeded default row of a fresh migrate.
 */
async function targetIsEmpty(pool: Pool): Promise<boolean> {
  for (const t of TABLES) {
    const n = await tableCount(pool, t.name);
    if (t.name === 'organisations') {
      if (n === 0) continue;
      if (n !== 1) return false;
      const { rows } = await query<{ slug: string }>(pool, 'SELECT slug FROM organisations');
      if (rows[0]?.slug !== 'default') return false;
      continue;
    }
    if (n !== 0) return false;
  }
  return true;
}

/**
 * Import a SQLite file (read-only) into Postgres. The SQLite schema (v1..v7, never edited)
 * is the source of truth for the mapping. Report carries counts and booleans only —
 * never phone numbers, names, keys or hashes.
 */
export async function importSqliteToPostgres(options: ImportOptions): Promise<ImportReport> {
  const logger = options.logger ?? silentLogger;
  const src = new DatabaseSync(options.sqlitePath, { readOnly: true });
  try {
    const sourceRows = new Map<string, Record<string, unknown>[]>();
    for (const t of TABLES) {
      const rows = src.prepare(`SELECT * FROM ${t.name} ORDER BY ${t.orderBy}`).all() as unknown as Record<
        string,
        unknown
      >[];
      sourceRows.set(t.name, rows);
    }
    const importedCourseFields = new Set(TABLES.find((table) => table.name === 'courses')?.columns);
    const courseRows = sourceRows.get('courses') ?? [];
    const sourceCourseFields = new Set(courseRows.flatMap((row) => Object.keys(row)));
    for (const field of sourceCourseFields) {
      if (importedCourseFields.has(field)) continue;
      const courseCount = (sourceRows.get('courses') ?? []).filter((row) => {
        const value = row[field];
        return value !== null && value !== undefined && (typeof value !== 'string' || value.trim().length > 0);
      }).length;
      if (courseCount > 0) {
        logger.warn('import.unsupported_course_content', {
          field,
          courseCount,
          action: 'excluded',
        });
      }
    }
    const tables: Record<string, number> = {};
    for (const [name, rows] of sourceRows) tables[name] = rows.length;

    if (options.dryRun) {
      logger.info('import.dry_run', { tables });
      return { dryRun: true, tables, integrity: { orphans: -1 }, spots: await spotChecks(options.pool) };
    }

    if (!(await targetIsEmpty(options.pool)) && !options.force) {
      throw new Error(
        'Postgres target is non-empty: refusing to import without --force (data would mix)',
      );
    }

    const before = new Map<string, number>();
    for (const t of TABLES) before.set(t.name, await tableCount(options.pool, t.name));

    // Organisations are slug-matched, not id-matched: both sides seed the same `default`
    // row, so a blind id insert would collide. Map source org ids to target org ids and
    // rewrite dependent foreign keys through the map (identity in the normal cutover).
    const orgRemap = new Map<number, number>();
    {
      const srcOrgs = sourceRows.get('organisations') ?? [];
      const client = await options.pool.connect();
      try {
        await client.query('BEGIN');
        try {
          await client.query('SET LOCAL statement_timeout = 0');
          for (const raw of srcOrgs) {
            const { rows } = await client.query<{ id: number }>(
              `INSERT INTO organisations (slug, name, created_at) VALUES ($1, $2, $3)
               ON CONFLICT (slug) DO UPDATE SET name = excluded.name
               RETURNING id`,
              [raw['slug'], raw['name'], raw['created_at'] ?? null],
            );
            orgRemap.set(Number(raw['id']), Number((rows[0] as { id: number }).id));
          }
          await client.query('COMMIT');
        } catch (err) {
          try {
            await client.query('ROLLBACK');
          } catch {
            // Connection may be broken; release will clean it up.
          }
          throw err;
        }
      } finally {
        client.release();
      }
      logger.info('import.table', { table: 'organisations', rows: srcOrgs.length });
    }
    const mapOrg = (id: unknown): unknown => {
      if (id === null || id === undefined) return id;
      const mapped = orgRemap.get(Number(id));
      if (mapped === undefined) throw new Error(`Import failed: unknown organisation id ${id}`);
      return mapped;
    };

    // One transaction per table (resumable checkpoints); source order respects FKs.
    for (const t of TABLES) {
      if (t.name === 'organisations') continue;
      const rows = sourceRows.get(t.name) ?? [];
      if (rows.length === 0) continue;
      const client = await options.pool.connect();
      try {
        await client.query('BEGIN');
        try {
          await client.query('SET LOCAL statement_timeout = 0');
          for (const raw of rows) {
            const row = t.convert ? t.convert(raw) : raw;
            const values = t.columns.map((c) => {
              const v = row[c] === undefined ? null : row[c];
              return c === 'org_id' ? mapOrg(v) : v;
            });
            const placeholders = t.columns.map((_, i) => `$${i + 1}`).join(', ');
            await client.query(
              `INSERT INTO ${t.name} (${t.columns.join(', ')}) VALUES (${placeholders})`,
              values,
            );
          }
          await client.query('COMMIT');
        } catch (err) {
          try {
            await client.query('ROLLBACK');
          } catch {
            // Connection may be broken; release will clean it up.
          }
          throw err;
        }
      } finally {
        client.release();
      }
      logger.info('import.table', { table: t.name, rows: rows.length });
    }

    // Identity sequences continue after the imported max id (empty tables keep next id 1).
    for (const table of IDENTITY_TABLES) {
      await query(
        options.pool,
        `SELECT setval(pg_get_serial_sequence($1, 'id'), (SELECT MAX(id) FROM ${table})) WHERE EXISTS (SELECT 1 FROM ${table})`,
        [`public.${table}`],
      );
    }

    // Verify the delta, not the absolute count (--force may stack onto existing rows).
    // Organisations are slug-matched (default exists on both sides), so verify by slug set.
    for (const t of TABLES) {
      if (t.name === 'organisations') {
        const srcSlugs = new Set((sourceRows.get('organisations') ?? []).map((r) => String(r['slug'])));
        const { rows } = await query<{ slug: string }>(options.pool, 'SELECT slug FROM organisations');
        const missing = [...srcSlugs].filter((s) => !rows.some((r) => r.slug === s));
        if (missing.length > 0) throw new Error(`Verification failed for organisations: missing ${missing.length}`);
        continue;
      }
      const after = await tableCount(options.pool, t.name);
      const delta = after - (before.get(t.name) ?? 0);
      if (delta !== (tables[t.name] ?? 0)) {
        throw new Error(`Verification failed for ${t.name}: wrote ${tables[t.name]}, delta ${delta}`);
      }
    }

    let orphans = 0;
    for (const [label, sql] of ORPHAN_CHECKS) {
      const { rows } = await query<{ n: number }>(options.pool, sql);
      const n = Number(rows[0]?.n ?? 0);
      if (n !== 0) logger.error('import.orphans', { check: label, count: n });
      orphans += n;
    }
    if (orphans !== 0) throw new Error(`Referential integrity failed: ${orphans} orphan rows`);

    const spots = await spotChecks(options.pool);
    const report: ImportReport = { dryRun: false, tables, integrity: { orphans }, spots };
    logger.info('import.done', { tables, orphans });
    return report;
  } finally {
    src.close();
  }
}

async function spotChecks(pool: Pool): Promise<ImportReport['spots']> {
  const exists = async (sql: string): Promise<boolean> => {
    const { rows } = await query<{ one: number }>(pool, sql);
    return rows.length > 0;
  };
  return {
    completedEnrollment: await exists(
      `SELECT 1 FROM enrollments e JOIN certificates c ON c.enrollment_id = e.id WHERE e.status = 'completed' LIMIT 1`,
    ),
    optOutHash: await exists(`SELECT 1 FROM opt_outs WHERE phone_hash IS NOT NULL LIMIT 1`),
    certificate: await exists(`SELECT 1 FROM certificates LIMIT 1`),
    adminKeyHash: await exists(`SELECT 1 FROM admin_api_keys LIMIT 1`),
  };
}

function usage(): string {
  return [
    'Usage: npm run import:sqlite -- --sqlite <path-to-.db> [--force] [--dry-run]',
    '',
    '  --sqlite <path>  SQLite file to read (opened read-only, never modified).',
    '  --force          Allow a non-empty Postgres target (default: refuse).',
    '  --dry-run        Report planned row counts only; write nothing.',
    '',
    'DATABASE_URL comes from the environment (.env). The report prints counts and',
    'booleans only — never personal data or secrets.',
  ].join('\n');
}

async function main(): Promise<void> {
  dotenv.config({ quiet: true });
  const logger = createLogger();
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const eq = args.find((a) => a.startsWith(`${flag}=`));
    if (eq) return eq.slice(flag.length + 1) || undefined;
    const i = args.indexOf(flag);
    if (i === -1) return undefined;
    const next = args[i + 1];
    return next && !next.startsWith('--') ? next : undefined;
  };
  const sqlitePath = get('--sqlite');
  const force = args.includes('--force');
  const dryRun = args.includes('--dry-run');
  if (!sqlitePath || args.includes('--help') || args.includes('-h')) {
    console.log(usage());
    process.exit(sqlitePath ? 0 : 1);
  }
  const env = loadEnv();
  const pool = createPool(
    {
      connectionString: env.DATABASE_URL,
      max: 2,
      ssl: env.DATABASE_SSL === 'require',
      // Import batches must not trip the app statement timeout.
      statementTimeoutMs: 0,
      idleTimeoutMs: env.DATABASE_IDLE_TIMEOUT_MS,
    },
    logger,
  );
  try {
    const report = await importSqliteToPostgres({ sqlitePath, pool, force, dryRun, logger });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await pool.end();
  }
}

// Run only when executed directly, not when imported by tests.
if (process.argv[1]?.endsWith('import-sqlite.ts') || process.argv[1]?.endsWith('import-sqlite.js')) {
  void main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
