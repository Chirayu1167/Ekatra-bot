import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { buildSqliteV7File } from './sqlite.fixture';
import { query } from '../src/db/pg';
import { importSqliteToPostgres } from '../src/scripts/import-sqlite';
import { pgFileContext, resetDb } from './pg.helpers';

const pgx = pgFileContext('import');

/** Fixture built by the REAL Phase 2 SQLite migrations + realistic rows. */
function buildFixture(file: string): void {
  const db = buildSqliteV7File(file);
  try {
    db.exec(`INSERT INTO organisations (slug, name) VALUES ('acme', 'Acme')`);
    const orgId = Number(
      (db.prepare(`SELECT id FROM organisations WHERE slug = 'acme'`).get() as { id: number }).id,
    );
    db.prepare(
      `INSERT INTO courses (org_id, slug, title, description, status) VALUES (?, 'imp-1', 'Import 101', '', 'published')`,
    ).run(orgId);
    const cid = Number(
      (db.prepare(`SELECT id FROM courses WHERE slug = 'imp-1'`).get() as { id: number }).id,
    );
    const lessonId = Number(
      db.prepare(`INSERT INTO lessons (course_id, position, title) VALUES (?, 1, 'L1')`).run(cid)
        .lastInsertRowid,
    );
    db.prepare(`INSERT INTO lesson_items (lesson_id, position, kind, text) VALUES (?, 1, 'text', 'hi')`).run(
      lessonId,
    );
    const learner = 'whatsapp:+919000000007';
    db.prepare(`INSERT INTO learners (user_id, name) VALUES (?, 'Imp Learner')`).run(learner);
    db.prepare(
      `INSERT INTO enrollments (org_id, user_id, course_id, status, last_delivered_position, completed_at)
       VALUES (?, ?, ?, 'completed', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    ).run(orgId, learner, cid);
    const enrId = Number(
      (db.prepare(`SELECT id FROM enrollments WHERE user_id = ?`).get(learner) as { id: number }).id,
    );
    db.prepare(
      `INSERT INTO certificates (enrollment_id, code, learner_name, course_title) VALUES (?, '1-AAAAAAAAAAAAAAAA', 'Imp Learner', 'Import 101')`,
    ).run(enrId);
    db.prepare(`INSERT INTO quiz_answers (enrollment_id, position, chosen, correct) VALUES (?, 1, 0, 1)`).run(
      enrId,
    );
    // Opted-out learner, then deleted (hash-only row must survive the import).
    const gone = 'whatsapp:+919000000008';
    db.prepare(`INSERT INTO learners (user_id, name) VALUES (?, 'Gone')`).run(gone);
    db.prepare(`INSERT INTO opt_outs (user_id, phone_hash) VALUES (?, ?)`,).run(gone, 'hash-of-gone');
    db.prepare(`DELETE FROM learners WHERE user_id = ?`).run(gone);
    db.prepare(`UPDATE opt_outs SET user_id = 'anon:hash-of-gone' WHERE user_id = ?`).run(gone);
    // Admin user + key hash + audit rows.
    const adminId = Number(
      db.prepare(`INSERT INTO admin_users (org_id, name, role) VALUES (?, 'Root', 'org_admin')`).run(orgId)
        .lastInsertRowid,
    );
    db.prepare(`INSERT INTO admin_api_keys (user_id, key_hash, prefix) VALUES (?, 'deadbeef', 'ek_live_')`).run(
      adminId,
    );
    db.prepare(`INSERT INTO audit_log (actor_user_id, org_id, action, target) VALUES (?, ?, 'course.publish', 'course:1')`).run(
      adminId,
      orgId,
    );
    db.prepare(`INSERT INTO processed_messages (message_sid) VALUES ('SMfixture1')`).run();
  } finally {
    db.close();
  }
}

describe('sqlite to postgres import', () => {
  it('dry-run reports counts without writing', async () => {
    await resetDb(pgx.pool);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ekatra-imp-'));
    try {
      const file = path.join(dir, 'src.db');
      buildFixture(file);
      const output: string[] = [];
      const report = await importSqliteToPostgres({
        sqlitePath: file,
        pool: pgx.pool,
        dryRun: true,
        logger: {
          info: (message, fields) => output.push(JSON.stringify({ message, fields })),
          warn: (message, fields) => output.push(JSON.stringify({ message, fields })),
          error: (message, fields) => output.push(JSON.stringify({ message, fields })),
        },
      });
      expect(report.dryRun).toBe(true);
      expect(report.tables.courses).toBe(1);
      expect(report.tables.enrollments).toBe(1);
      const { rows } = await query<{ n: number }>(pgx.pool, 'SELECT COUNT(*) AS n FROM courses');
      expect(Number(rows[0]?.n ?? 0)).toBe(0);
      expect(JSON.stringify({ report, output })).not.toMatch(
        /Imp Learner|919000000007|Gone|deadbeef|SMfixture1|Acme|Import 101/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a non-empty target unless --force', async () => {
    await resetDb(pgx.pool);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ekatra-imp-'));
    try {
      const file = path.join(dir, 'src.db');
      buildFixture(file);
      await query(pgx.pool, `INSERT INTO processed_messages (message_sid) VALUES ('SMpre')`);
      await expect(importSqliteToPostgres({ sqlitePath: file, pool: pgx.pool })).rejects.toThrow(
        /non-empty|force/i,
      );
      const report = await importSqliteToPostgres({ sqlitePath: file, pool: pgx.pool, force: true });
      expect(report.tables.organisations).toBe(2); // default + acme (source rows)
      expect(report.tables.processed_messages).toBe(1); // SMfixture1 (SMpre was already there)
      const { rows } = await query<{ n: number }>(
        pgx.pool,
        'SELECT COUNT(*) AS n FROM processed_messages',
      );
      expect(Number(rows[0]?.n ?? 0)).toBe(2); // pre-existing row kept, fixture added
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('imports everything: counts match, integrity holds, spot checks pass, report is clean', async () => {
    await resetDb(pgx.pool);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ekatra-imp-'));
    try {
      const file = path.join(dir, 'src.db');
      buildFixture(file);
      const report = await importSqliteToPostgres({ sqlitePath: file, pool: pgx.pool });
      expect(report.tables.courses).toBe(1);
      expect(report.tables.lessons).toBe(1);
      expect(report.tables.lesson_items).toBe(1);
      expect(report.tables.enrollments).toBe(1);
      expect(report.tables.learners).toBe(1);
      expect(report.tables.certificates).toBe(1);
      expect(report.tables.quiz_answers).toBe(1);
      expect(report.tables.opt_outs).toBe(1);
      expect(report.tables.admin_users).toBe(1);
      expect(report.tables.admin_api_keys).toBe(1);
      expect(report.tables.audit_log).toBe(1);
      expect(report.tables.processed_messages).toBe(1);
      expect(report.integrity.orphans).toBe(0);
      expect(report.spots.completedEnrollment).toBe(true);
      expect(report.spots.optOutHash).toBe(true);
      expect(report.spots.certificate).toBe(true);
      expect(report.spots.adminKeyHash).toBe(true);
      // Report carries counts and booleans only: no phone numbers, names, keys or hashes.
      const dump = JSON.stringify(report);
      expect(dump).not.toContain('919000000007');
      expect(dump).not.toContain('Imp Learner');
      expect(dump).not.toContain('deadbeef');
      expect(dump).not.toContain('hash-of-gone');
      // Sequences continue after the imported max id.
      const { rows } = await query<{ id: number }>(
        pgx.pool,
        `INSERT INTO organisations (slug, name) VALUES ('after', 'After') RETURNING id`,
      );
      expect(Number(rows[0]?.id ?? 0)).toBeGreaterThan(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('imports optional quiz explanations when the SQLite source has them', async () => {
    await resetDb(pgx.pool);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ekatra-imp-'));
    try {
      const file = path.join(dir, 'src.db');
      buildFixture(file);
      const source = new DatabaseSync(file);
      try {
        source.exec('ALTER TABLE lesson_items ADD COLUMN explanation TEXT');
        source
          .prepare(
            `UPDATE lesson_items
             SET kind = 'quiz', options = ?, explanation = ?
             WHERE position = 1`,
          )
          .run(JSON.stringify([{ label: 'A' }, { label: 'B', correct: true }]), 'Why B is correct.');
      } finally {
        source.close();
      }

      await importSqliteToPostgres({ sqlitePath: file, pool: pgx.pool });
      const { rows } = await query<{ kind: string; explanation: string | null }>(
        pgx.pool,
        `SELECT kind, explanation FROM lesson_items
         WHERE kind = 'quiz'`,
      );
      expect(rows).toEqual([{ kind: 'quiz', explanation: 'Why B is correct.' }]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('warns for each unsupported course field without logging its values', async () => {
    await resetDb(pgx.pool);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ekatra-imp-'));
    const warnings: Array<{ message: string; fields?: Record<string, unknown> }> = [];
    try {
      const file = path.join(dir, 'src.db');
      buildFixture(file);
      const source = new DatabaseSync(file);
      try {
        source.exec(`
          ALTER TABLE courses ADD COLUMN whatsappLessonIntro TEXT;
          ALTER TABLE courses ADD COLUMN whatsappCompletionMessage TEXT;
          ALTER TABLE courses ADD COLUMN price INTEGER;
          ALTER TABLE courses ADD COLUMN category TEXT;
          ALTER TABLE courses ADD COLUMN stripeProductId TEXT;
          ALTER TABLE courses ADD COLUMN stripePriceId TEXT;
          ALTER TABLE courses ADD COLUMN telegramEnabled INTEGER;
          ALTER TABLE courses ADD COLUMN webEnrollmentMode TEXT;
          ALTER TABLE courses ADD COLUMN pauseReminderMessage TEXT;
          ALTER TABLE courses ADD COLUMN instructor TEXT;
          ALTER TABLE courses ADD COLUMN language TEXT;
          ALTER TABLE courses ADD COLUMN enrollmentCount INTEGER;
          ALTER TABLE courses ADD COLUMN completionCount INTEGER;
        `);
        source
          .prepare(
            `UPDATE courses
             SET whatsappLessonIntro = ?, whatsappCompletionMessage = ?, price = ?,
                 category = ?, stripeProductId = ?, stripePriceId = ?, telegramEnabled = ?,
                 webEnrollmentMode = ?, pauseReminderMessage = ?, instructor = ?, language = ?,
                 enrollmentCount = ?, completionCount = ?
             WHERE slug = 'imp-1'`,
          )
          .run(
            'A private lesson welcome.',
            'A private completion message.',
            150,
            'wellness',
            'prod_private',
            'price_private',
            1,
            'public',
            'Private reminder',
            'Private instructor',
            'en',
            4,
            3,
          );
      } finally {
        source.close();
      }

      await importSqliteToPostgres({
        sqlitePath: file,
        pool: pgx.pool,
        logger: {
          info: () => {},
          warn: (message, fields) => warnings.push({ message, fields }),
          error: () => {},
        },
      });
      const fields = [
        'whatsappLessonIntro',
        'whatsappCompletionMessage',
        'price',
        'category',
        'stripeProductId',
        'stripePriceId',
        'telegramEnabled',
        'webEnrollmentMode',
        'pauseReminderMessage',
        'instructor',
        'language',
        'enrollmentCount',
        'completionCount',
      ];
      expect(warnings.map((warning) => warning.fields?.field).sort()).toEqual(fields.sort());
      expect(warnings.every((warning) => warning.message === 'import.unsupported_course_content')).toBe(true);
      expect(warnings.every((warning) => warning.fields?.courseCount === 1 && warning.fields.action === 'excluded')).toBe(true);
      expect(JSON.stringify(warnings)).not.toMatch(/A private|prod_private|price_private|wellness|Private instructor/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
