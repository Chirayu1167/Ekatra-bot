import crypto from 'node:crypto';
import { iso, query } from '../db/pg';
import type { PgDb } from '../db/pg';
import type { LearnerService } from './learner.service';

export interface Certificate {
  id: number;
  enrollmentId: number;
  code: string;
  learnerName: string;
  courseTitle: string;
  issuedAt: string;
}

interface CertRow {
  id: number;
  enrollment_id: number;
  code: string;
  learner_name: string;
  course_title: string;
  issued_at: Date | string;
}

const toCert = (r: CertRow): Certificate => ({
  id: r.id,
  enrollmentId: r.enrollment_id,
  code: r.code,
  learnerName: r.learner_name,
  courseTitle: r.course_title,
  issuedAt: iso(r.issued_at),
});

/**
 * Completion certificates. There is exactly one per enrollment (UNIQUE enrollment_id +
 * INSERT .. ON CONFLICT DO NOTHING), so duplicate callbacks, retries or a learner
 * re-requesting it can never create a second record.
 *
 * The public code is `<enrollmentId>-<HMAC>`: it can be computed before the row exists (so the
 * final lesson can carry the link) and cannot be guessed to read someone else's certificate.
 * A certificate records completion only; it makes no mastery or accreditation claim.
 */
export class CertificateService {
  constructor(
    private readonly db: PgDb,
    private readonly learners: LearnerService,
    private readonly secret: string,
  ) {}

  codeFor(enrollmentId: number): string {
    const mac = crypto
      .createHmac('sha256', this.secret)
      .update(`certificate:${enrollmentId}`)
      .digest('base64url')
      .slice(0, 16);
    return `${enrollmentId}-${mac}`;
  }

  /** Returns the enrollment id if the code's signature is valid, else null. */
  private verify(code: string): number | null {
    const m = /^(\d{1,12})-([A-Za-z0-9_-]{16})$/.exec(code);
    if (!m) return null;
    const id = Number(m[1]);
    const expected = Buffer.from(this.codeFor(id));
    const given = Buffer.from(code);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
    return id;
  }

  /** Create the certificate for a COMPLETED enrollment (idempotent). Undefined if not completed. */
  async issue(orgId: number, enrollmentId: number): Promise<Certificate | undefined> {
    const { rows } = await query<{ id: number; user_id: string; title: string }>(
      this.db,
      `SELECT e.id, e.user_id, c.title FROM enrollments e JOIN courses c ON c.id = e.course_id
       WHERE e.id = $1 AND e.org_id = $2 AND e.status = 'completed'`,
      [enrollmentId, orgId],
    );
    const enr = rows[0];
    if (!enr) return undefined;
    await query(
      this.db,
      `INSERT INTO certificates (enrollment_id, code, learner_name, course_title)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (enrollment_id) DO NOTHING`,
      [enr.id, this.codeFor(enr.id), (await this.learners.getName(enr.user_id)) || 'Learner', enr.title],
    );
    return this.getByEnrollment(orgId, enr.id);
  }

  async getByEnrollment(orgId: number, enrollmentId: number): Promise<Certificate | undefined> {
    const { rows } = await query<CertRow>(
      this.db,
      `SELECT cert.* FROM certificates cert
       JOIN enrollments e ON e.id = cert.enrollment_id
       WHERE cert.enrollment_id = $1 AND e.org_id = $2`,
      [enrollmentId, orgId],
    );
    const row = rows[0];
    return row && toCert(row);
  }

  /**
   * Public lookup by signed code. Deliberately org-agnostic: the unguessable HMAC code IS the
   * credential (like a password), so no org context is needed or accepted. Verifies the
   * signature first, then lazily issues for completed enrollments.
   */
  async getByCode(code: string): Promise<Certificate | undefined> {
    const id = this.verify(code);
    if (id === null) return undefined;
    const { rows } = await query<CertRow>(
      this.db,
      'SELECT * FROM certificates WHERE enrollment_id = $1',
      [id],
    );
    const row = rows[0];
    if (row) return toCert(row);
    const { rows: enrRows } = await query<{ id: number; user_id: string; title: string }>(
      this.db,
      `SELECT e.id, e.user_id, c.title FROM enrollments e JOIN courses c ON c.id = e.course_id
       WHERE e.id = $1 AND e.status = 'completed'`,
      [id],
    );
    const enr = enrRows[0];
    if (!enr) return undefined;
    await query(
      this.db,
      `INSERT INTO certificates (enrollment_id, code, learner_name, course_title)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (enrollment_id) DO NOTHING`,
      [enr.id, this.codeFor(enr.id), (await this.learners.getName(enr.user_id)) || 'Learner', enr.title],
    );
    const { rows: created } = await query<CertRow>(
      this.db,
      'SELECT * FROM certificates WHERE enrollment_id = $1',
      [id],
    );
    const cert = created[0];
    return cert && toCert(cert);
  }

  /** Erase the certificate of one enrollment (learner-data deletion). Scoped to the org. */
  async deleteForEnrollment(orgId: number, enrollmentId: number): Promise<boolean> {
    const { rowCount } = await query(
      this.db,
      `DELETE FROM certificates WHERE enrollment_id = $1
       AND EXISTS (SELECT 1 FROM enrollments e WHERE e.id = $1 AND e.org_id = $2)`,
      [enrollmentId, orgId],
    );
    return rowCount === 1;
  }

  async count(orgId: number): Promise<number> {
    const { rows } = await query<{ n: number }>(
      this.db,
      `SELECT COUNT(*) AS n FROM certificates cert
       JOIN enrollments e ON e.id = cert.enrollment_id WHERE e.org_id = $1`,
      [orgId],
    );
    return Number(rows[0]?.n ?? 0);
  }
}
