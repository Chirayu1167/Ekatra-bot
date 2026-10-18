import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../src/db/migrations';
import { query } from '../src/db/pg';
import { applySqliteMigrations, buildSqliteV5, sqliteUserVersion } from './sqlite.fixture';
import { OrganisationsService } from '../src/services/organisations.service';
import { CourseService } from '../src/services/course.service';
import { EnrollmentService } from '../src/services/enrollment.service';
import { NotFoundError } from '../src/errors';
import { pgFileContext, resetDb } from './pg.helpers';

const pgx = pgFileContext('orgs-isolation');

const USER_A = 'whatsapp:+919000000001';

function tinyCourse(title: string) {
  return {
    title,
    description: '',
    lessons: [{ title: 'Only', items: [{ kind: 'text', text: 'hi' } as const] }],
  };
}

describe('organisations and tenant isolation', () => {
  it('seeds a default organisation on fresh databases', async () => {
    await resetDb(pgx.pool);
    const orgs = new OrganisationsService(pgx.pool);
    const def = await orgs.getBySlug('default');
    expect(def).toBeDefined();
    expect(def?.slug).toBe('default');
    expect(await orgs.getDefaultId()).toBe(def?.id);
  });

  it('courses are invisible outside their org (service returns undefined, mutations throw 404)', async () => {
    await resetDb(pgx.pool);
    const db = pgx.pool;
    const orgs = new OrganisationsService(db);
    const courses = new CourseService(db);
    const orgB = await orgs.create({ slug: 'org-b', name: 'Org B' });
    const defId = await orgs.getDefaultId();

    const created = await courses.createCourse(defId, tinyCourse('Scoped'));
    const id = created.id;

    expect(await courses.getCourse(orgB.id, id)).toBeUndefined();
    expect(await courses.getCourseDetail(orgB.id, id)).toBeUndefined();
    expect(await courses.listCourses(orgB.id)).toHaveLength(0);
    expect(await courses.listCourses(defId)).toHaveLength(1);
    await expect(courses.updateCourse(orgB.id, id, { title: 'x' })).rejects.toThrow(NotFoundError);
    await expect(courses.publish(orgB.id, id)).rejects.toThrow(NotFoundError);
    await expect(courses.deleteCourse(orgB.id, id)).rejects.toThrow(NotFoundError);
    // And the owning org is unaffected by the failed cross-org attempts.
    expect((await courses.getCourse(defId, id))?.title).toBe('Scoped');
  });

  it('enrollments are scoped to the course org; cross-org reads miss', async () => {
    await resetDb(pgx.pool);
    const db = pgx.pool;
    const orgs = new OrganisationsService(db);
    const courses = new CourseService(db);
    const enrollments = new EnrollmentService(db);
    const defId = await orgs.getDefaultId();
    const orgB = await orgs.create({ slug: 'org-b', name: 'Org B' });

    const course = await courses.publish(defId, (await courses.createCourse(defId, tinyCourse('E'))).id);
    const pending = await enrollments.createPending(defId, USER_A, course.id);
    expect(pending.status).toBe('pending');

    expect(await enrollments.find(orgB.id, USER_A, course.id)).toBeUndefined();
    expect(await enrollments.findActive(orgB.id, USER_A)).toBeUndefined();
    expect((await enrollments.find(defId, USER_A, course.id))?.id).toBe(pending.id);
  });

  it('upgrades a Phase 1 SQLite database in place: default org backfill, data intact', () => {
    // The SQLite v1..v7 migration chain (kept as the import source) still upgrades cleanly
    // via the raw legacy chain. Service-level assertions moved to Postgres; the live
    // import path is tested in tests/import.test.ts.
    const db = buildSqliteV5();
    expect(sqliteUserVersion(db)).toBe(5);
    const courseId = Number(
      db.prepare("INSERT INTO courses (slug, title, description, status) VALUES (?, ?, ?, 'published')")
        .run('legacy', 'Legacy course', '').lastInsertRowid,
    );
    db.prepare('INSERT INTO lessons (course_id, position, title) VALUES (?, 1, ?)').run(
      courseId,
      'L1',
    );
    db.prepare(
      "INSERT INTO enrollments (user_id, course_id, status, last_delivered_position) VALUES (?, ?, 'active', 1)",
    ).run(USER_A, courseId);

    applySqliteMigrations(db, MIGRATIONS.slice(5));
    expect(sqliteUserVersion(db)).toBe(MIGRATIONS.length);
    const defId = Number(
      (db.prepare("SELECT id FROM organisations WHERE slug = 'default'").get() as { id: number }).id,
    );
    expect(defId).toBeGreaterThan(0);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM courses WHERE org_id IS NULL').get() as { n: number }).n,
    ).toBe(0);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM enrollments WHERE org_id IS NULL').get() as { n: number }).n,
    ).toBe(0);
    expect(
      (db.prepare('SELECT title FROM courses WHERE id = ?').get(courseId) as { title: string }).title,
    ).toBe('Legacy course');
    db.close();
  });

  it('organisation slugs are unique', async () => {
    await resetDb(pgx.pool);
    const orgs = new OrganisationsService(pgx.pool);
    await orgs.create({ slug: 'acme', name: 'Acme' });
    await expect(orgs.create({ slug: 'acme', name: 'Acme 2' })).rejects.toThrow();
    expect(await orgs.list()).toHaveLength(2); // default + acme
  });

  it('the Postgres ledger records the baseline migration', async () => {
    const rows = (
      await query<{ version: number; checksum: string }>(
        pgx.pool,
        'SELECT version, checksum FROM schema_migrations ORDER BY version',
      )
    ).rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });
});
