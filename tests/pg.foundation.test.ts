import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { query, withTransaction } from '../src/db/pg';
import { migratePostgres, PG_MIGRATIONS } from '../src/db/migratePg';
import { pgFileContext } from './pg.helpers';

const ctx = pgFileContext('pg-foundation');
const pool = () => ctx.pool;

describe('postgres baseline migration', () => {
  it('migrates clean and records the ledger with a verifiable checksum', async () => {
    const applied = await migratePostgres(pool());
    expect(applied.applied).toEqual([]); // already applied by the fixture
    const rows = await query<{ version: number; name: string; checksum: string }>(
      pool(),
      'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
    );
    expect(rows.rows).toHaveLength(PG_MIGRATIONS.length);
    expect(rows.rows[0]).toMatchObject({ version: 1, name: 'baseline-v7-equivalent' });
    expect(rows.rows[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('seeds the default organisation and enforces foreign keys', async () => {
    const orgs = await query<{ slug: string }>(pool(), "SELECT slug FROM organisations WHERE slug = 'default'");
    expect(orgs.rows).toHaveLength(1);
    await expect(
      query(pool(), 'INSERT INTO courses (org_id, slug, title) VALUES (424242, $1, $2)', ['x', 'y']),
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it('stores quiz explanations in a nullable, checksummed append-only migration', async () => {
    const column = await query<{ is_nullable: string }>(
      pool(),
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'lesson_items' AND column_name = 'explanation'`,
    );
    expect(column.rows).toEqual([{ is_nullable: 'YES' }]);
    expect(PG_MIGRATIONS.find((migration) => migration.version === 5)).toMatchObject({
      version: 5,
      name: 'phase4-quiz-explanations',
    });
  });

  it('v6 scopes historical inbound events only when enrollment org is unambiguous', async () => {
    const db = pool();
    const org = await query<{ id: number }>(db, "SELECT id FROM organisations WHERE slug = 'default'");
    const defaultOrgId = org.rows[0]!.id;
    const secondOrg = await query<{ id: number }>(
      db,
      `INSERT INTO organisations (slug, name) VALUES ($1, $1) RETURNING id`,
      [`v6-org-${Date.now()}`],
    );
    const courseA = await query<{ id: number }>(
      db,
      'INSERT INTO courses (org_id, slug, title) VALUES ($1, $2, $2) RETURNING id',
      [defaultOrgId, `v6-course-a-${Date.now()}`],
    );
    const courseB = await query<{ id: number }>(
      db,
      'INSERT INTO courses (org_id, slug, title) VALUES ($1, $2, $2) RETURNING id',
      [secondOrg.rows[0]!.id, `v6-course-b-${Date.now()}`],
    );
    await query(
      db,
      `INSERT INTO enrollments (org_id, user_id, course_id, status) VALUES
       ($1, 'whatsapp:+910000000001', $2, 'pending'),
       ($1, 'whatsapp:+910000000002', $2, 'pending'),
       ($3, 'whatsapp:+910000000002', $4, 'pending')`,
      [defaultOrgId, courseA.rows[0]!.id, secondOrg.rows[0]!.id, courseB.rows[0]!.id],
    );
    await query(
      db,
      `INSERT INTO inbound_events (message_sid, from_user) VALUES
       ('SMv6-unambiguous', 'whatsapp:+910000000001'),
       ('SMv6-ambiguous', 'whatsapp:+910000000002')`,
    );
    await query(db, 'DROP INDEX inbound_events_by_org_user_created');
    await query(db, 'ALTER TABLE inbound_events DROP COLUMN org_id');
    await query(db, 'DELETE FROM schema_migrations WHERE version = 6');

    expect((await migratePostgres(db)).applied).toEqual([6]);
    const backfill = await query<{ message_sid: string; org_id: number | null }>(
      db,
      `SELECT message_sid, org_id FROM inbound_events
       WHERE message_sid LIKE 'SMv6-%' ORDER BY message_sid`,
    );
    expect(backfill.rows).toEqual([
      { message_sid: 'SMv6-ambiguous', org_id: null },
      { message_sid: 'SMv6-unambiguous', org_id: defaultOrgId },
    ]);
    expect(PG_MIGRATIONS.find((migration) => migration.version === 6)).toMatchObject({
      name: 'learner-export-organisation-scope',
    });
  });

  it('upgrades a v4 database without losing existing quiz items', async () => {
    const org = await query<{ id: number }>(
      pool(),
      "SELECT id FROM organisations WHERE slug = 'default'",
    );
    const course = await query<{ id: number }>(
      pool(),
      'INSERT INTO courses (org_id, slug, title) VALUES ($1, $2, $3) RETURNING id',
      [org.rows[0]?.id, `v4-upgrade-${Date.now()}`, 'Before migration'],
    );
    const lesson = await query<{ id: number }>(
      pool(),
      'INSERT INTO lessons (course_id, position, title) VALUES ($1, 1, $2) RETURNING id',
      [course.rows[0]?.id, 'Existing lesson'],
    );
    await query(
      pool(),
      'INSERT INTO lesson_items (lesson_id, position, kind, text, options) VALUES ($1, 1, $2, $3, $4)',
      [lesson.rows[0]?.id, 'quiz', 'Existing quiz', JSON.stringify([{ label: 'A' }, { label: 'B' }])],
    );

    await query(pool(), 'ALTER TABLE lesson_items DROP COLUMN explanation');
    await query(pool(), 'DELETE FROM schema_migrations WHERE version = 5');
    expect((await migratePostgres(pool())).applied).toEqual([5]);

    const row = await query<{ explanation: string | null }>(
      pool(),
      'SELECT explanation FROM lesson_items WHERE lesson_id = $1',
      [lesson.rows[0]?.id],
    );
    expect(row.rows).toEqual([{ explanation: null }]);
    expect(
      (await query<{ name: string }>(pool(), 'SELECT name FROM schema_migrations WHERE version = 5'))
        .rows,
    ).toEqual([{ name: 'phase4-quiz-explanations' }]);
  });

  it('ids and counts come back as numbers (int8 parser)', async () => {
    const def = await query<{ id: number }>(pool(), "SELECT id FROM organisations WHERE slug = 'default'");
    const orgId = def.rows[0]?.id;
    expect(typeof orgId).toBe('number');
    const created = await query<{ id: number }>(
      pool(),
      'INSERT INTO courses (org_id, slug, title) VALUES ($1, $2, $3) RETURNING id',
      [orgId, 'int8-test', 'T'],
    );
    expect(typeof created.rows[0]?.id).toBe('number');
    const count = await query<{ n: number }>(pool(), 'SELECT COUNT(*) AS n FROM courses');
    expect(typeof count.rows[0]?.n).toBe('number');
  });
});

describe('lesson positions without the negative-number trick', () => {
  async function makeCourse(db: Pool): Promise<{ orgId: number; courseId: number }> {
    const org = await query<{ id: number }>(db, "SELECT id FROM organisations WHERE slug = 'default'");
    const orgId = org.rows[0]?.id as number;
    const slug = `pos-${Math.random().toString(36).slice(2, 10)}`;
    const c = await query<{ id: number }>(db, 'INSERT INTO courses (org_id, slug, title) VALUES ($1, $2, $3) RETURNING id', [
      orgId,
      slug,
      'P',
    ]);
    return { orgId, courseId: c.rows[0]?.id as number };
  }

  /** Next-position allocation under a row lock: the ON CONFLICT-free append pattern. */
  async function appendLesson(db: Pool, courseId: number, title: string): Promise<number> {
    return withTransaction(db, async (client) => {
      await client.query('SELECT id FROM courses WHERE id = $1 FOR UPDATE', [courseId]);
      const cur = await client.query('SELECT COALESCE(MAX(position), 0) AS m FROM lessons WHERE course_id = $1', [
        courseId,
      ]);
      const next = Number((cur.rows[0] as { m: number }).m) + 1;
      const ins = await client.query('INSERT INTO lessons (course_id, position, title) VALUES ($1, $2, $3) RETURNING position', [
        courseId,
        next,
        title,
      ]);
      return Number((ins.rows[0] as { position: number }).position);
    });
  }

  it('concurrent appends land on distinct sequential positions', async () => {
    const { courseId } = await makeCourse(pool());
    const positions = await Promise.all(
      Array.from({ length: 5 }, (_, i) => appendLesson(pool(), courseId, `L${i}`)),
    );
    expect([...positions].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it('delete renumbers with a single ordered UPDATE (no temp negatives)', async () => {
    const { courseId } = await makeCourse(pool());
    for (const t of ['A', 'B', 'C']) await appendLesson(pool(), courseId, t);
    await withTransaction(pool(), async (client) => {
      await client.query('DELETE FROM lessons WHERE course_id = $1 AND position = $2', [courseId, 2]);
      await client.query('UPDATE lessons SET position = position - 1 WHERE course_id = $1 AND position > $2', [
        courseId,
        2,
      ]);
    });
    const rows = await query<{ position: number; title: string }>(
      pool(),
      'SELECT position, title FROM lessons WHERE course_id = $1 ORDER BY position',
      [courseId],
    );
    expect(rows.rows.map((r) => [r.position, r.title])).toEqual([
      [1, 'A'],
      [2, 'C'],
    ]);
  });

  it('a swap (reorder) commits atomically under the deferrable constraint', async () => {
    const { courseId } = await makeCourse(pool());
    for (const t of ['A', 'B']) await appendLesson(pool(), courseId, t);
    await withTransaction(pool(), async (client) => {
      // No intermediate temp values needed: the UNIQUE check defers to COMMIT.
      await client.query('UPDATE lessons SET position = CASE WHEN position = 1 THEN 2 ELSE 1 END WHERE course_id = $1', [
        courseId,
      ]);
    });
    const rows = await query<{ position: number; title: string }>(
      pool(),
      'SELECT position, title FROM lessons WHERE course_id = $1 ORDER BY position',
      [courseId],
    );
    expect(rows.rows.map((r) => [r.position, r.title])).toEqual([
      [1, 'B'],
      [2, 'A'],
    ]);
  });
});

describe('migration runner safety', () => {
  it('concurrent migrate runs apply once (advisory lock)', async () => {
    const results = await Promise.all([
      migratePostgres(pool()),
      migratePostgres(pool()),
      migratePostgres(pool()),
    ]);
    for (const r of results) expect(r.applied).toEqual([]);
    const n = await query<{ n: number }>(pool(), 'SELECT COUNT(*) AS n FROM schema_migrations');
    expect(n.rows[0]?.n).toBe(PG_MIGRATIONS.length);
  });

  it('a failed migration aborts and leaves the version unchanged', async () => {
    const bad = [
      ...PG_MIGRATIONS,
      { version: 999, name: 'broken', sql: 'THIS IS NOT SQL AT ALL' },
    ];
    await expect(migratePostgres(pool(), bad)).rejects.toThrow();
    const rows = await query<{ version: number }>(pool(), 'SELECT version FROM schema_migrations ORDER BY version');
    expect(rows.rows.map((r) => r.version)).toEqual(PG_MIGRATIONS.map((m) => m.version));
    // The advisory lock was released: a later run still works.
    await expect(migratePostgres(pool())).resolves.toMatchObject({ applied: [] });
  });

  it('a changed shipped migration is detected by checksum', async () => {
    const tampered = PG_MIGRATIONS.map((m, i) =>
      i === 0 ? { ...m, sql: `${m.sql}\n-- tampered` } : m,
    );
    await expect(migratePostgres(pool(), tampered)).rejects.toThrow(/checksum/i);
  });
});
