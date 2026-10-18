import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { query } from '../src/db/pg';
import { migratePostgres } from '../src/db/migratePg';
import { CourseService } from '../src/services/course.service';
import { EnrollmentService } from '../src/services/enrollment.service';
import { OrganisationsService } from '../src/services/organisations.service';
import { OptOutService } from '../src/services/optout.service';
import { pgFileContext, resetDb } from './pg.helpers';

const pgx = pgFileContext('backup');

/**
 * pg_dump/pg_restore from PATH (CI runners and database hosts ship them; the embedded
 * bundle carries server binaries only). Undefined when absent — the proof then skips
 * explicitly instead of pretending.
 */
function clientBin(name: string): string | undefined {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  for (const dir of (process.env['PATH'] ?? '').split(path.delimiter)) {
    try {
      const full = path.join(dir, exe);
      if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
    } catch {
      // Ignore unreadable PATH entries.
    }
  }
  return undefined;
}

const pgDump = clientBin('pg_dump');
const pgRestore = clientBin('pg_restore');
const haveTools = Boolean(pgDump && pgRestore);

function run(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    // Arguments (including any URL with credentials) are passed, never printed.
    execFile(bin, args, (err) => (err ? reject(err) : resolve()));
  });
}

const ORPHAN_SQL = [
  'SELECT COUNT(*) AS n FROM lessons l LEFT JOIN courses c ON c.id = l.course_id WHERE c.id IS NULL',
  'SELECT COUNT(*) AS n FROM enrollments e LEFT JOIN courses c ON c.id = e.course_id WHERE c.id IS NULL',
  'SELECT COUNT(*) AS n FROM certificates c LEFT JOIN enrollments e ON e.id = c.enrollment_id WHERE e.id IS NULL',
];

describe.runIf(haveTools)('pg_dump backup and pg_restore proof', () => {
  it('backs up, restores into an isolated empty database, and the data verifies', async () => {
    await resetDb(pgx.pool);
    const orgId = await new OrganisationsService(pgx.pool).getDefaultId();
    const courses = new CourseService(pgx.pool);
    const enrollments = new EnrollmentService(pgx.pool);
    const course = await courses.createCourse(orgId, {
      title: 'Backup 101',
      description: '',
      lessons: [{ title: 'L1', items: [{ kind: 'text', text: 'backup me' }] }],
    });
    await courses.publish(orgId, course.id);
    const learner = 'whatsapp:+919000000009';
    await enrollments.createPending(orgId, learner, course.id);
    await new OptOutService(pgx.pool, undefined).optOut(learner);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ekatra-proof-'));
    try {
      const dumpFile = path.join(dir, 'proof.dump');
      const adminUrl = `postgres://postgres:postgres@127.0.0.1:${pgx.port}/postgres`;
      const started = Date.now();
      await run(pgDump as string, ['--format=custom', '--compress=9', `--file=${dumpFile}`, fileUrl()]);
      const backupMs = Date.now() - started;
      const backupBytes = fs.statSync(dumpFile).size;
      expect(backupBytes).toBeGreaterThan(0);

      // Restore into an isolated EMPTY database (never the source).
      const proofDb = `t_proof_${Date.now().toString(36)}`;
      const admin = new Pool({ connectionString: adminUrl });
      try {
        await admin.query(`CREATE DATABASE "${proofDb}"`);
      } finally {
        await admin.end();
      }
      const proofUrl = `postgres://postgres:postgres@127.0.0.1:${pgx.port}/${proofDb}`;
      const rStarted = Date.now();
      await run(pgRestore as string, ['--clean', '--if-exists', `--dbname=${proofUrl}`, dumpFile]);
      const restoreMs = Date.now() - rStarted;

      const proof = new Pool({ connectionString: proofUrl });
      try {
        // Migrations are a no-op on the restored schema; integrity holds; smoke reads work.
        await expect(migratePostgres(proof)).resolves.toMatchObject({ applied: [] });
        for (const sql of ORPHAN_SQL) {
          const { rows } = await query<{ n: number }>(proof, sql);
          expect(Number(rows[0]?.n ?? -1)).toBe(0);
        }
        const restored = new CourseService(proof);
        expect((await restored.getCourse(orgId, course.id))?.title).toBe('Backup 101');
        expect(await new OptOutService(proof, undefined).isOptedOut(learner)).toBe(true);
      } finally {
        await proof.end();
      }
      const cleanup = new Pool({ connectionString: adminUrl });
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS "${proofDb}" WITH (FORCE)`);
      } finally {
        await cleanup.end();
      }
      // Size/time for the report (counts and timings only — never credentials or data).
      console.log(`backup-proof bytes=${backupBytes} backupMs=${backupMs} restoreMs=${restoreMs}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

function fileUrl(): string {
  return `postgres://postgres:postgres@127.0.0.1:${pgx.port}/${pgx.dbName}`;
}

describe.skipIf(haveTools)('pg_dump backup and pg_restore proof', () => {
  it('notes that client tools are absent here (proof runs in CI)', () => {
    console.log('pg_dump/pg_restore not found: restore proof runs in CI (see VERIFY.md)');
    expect(true).toBe(true);
  });
});
