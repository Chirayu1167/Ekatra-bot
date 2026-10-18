import { iso, query, transactional } from '../db/pg';
import type { PgDb } from '../db/pg';
import type { Enrollment, EnrollmentStatus, EnrollmentSummary } from '../types/course';
import { NotFoundError } from '../errors';

interface EnrollmentRow {
  id: number;
  org_id: number;
  user_id: string;
  course_id: number;
  status: EnrollmentStatus;
  last_delivered_position: number;
  started_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
  course_title?: string;
  lesson_count?: number;
  consent_at: Date | string | null;
  consent_source: string | null;
  consent_admin_id: number | null;
}

const SELECT = `
  SELECT e.*, c.title AS course_title,
         (SELECT COUNT(*) FROM lessons l WHERE l.course_id = e.course_id) AS lesson_count
  FROM enrollments e JOIN courses c ON c.id = e.course_id`;

function toEnrollment(row: EnrollmentRow): Enrollment {
  return {
    id: row.id,
    orgId: row.org_id,
    userId: row.user_id,
    courseId: row.course_id,
    status: row.status,
    lastDeliveredPosition: row.last_delivered_position,
    startedAt: iso(row.started_at),
    updatedAt: iso(row.updated_at),
    completedAt: row.completed_at == null ? null : iso(row.completed_at),
    consentAt: row.consent_at == null ? null : iso(row.consent_at),
    consentSource: row.consent_source as Enrollment['consentSource'],
    consentAdminId: row.consent_admin_id == null ? null : Number(row.consent_admin_id),
  };
}

function toSummary(row: EnrollmentRow): EnrollmentSummary {
  return {
    ...toEnrollment(row),
    courseTitle: row.course_title ?? '',
    lessonCount: Number(row.lesson_count ?? 0),
  };
}

/**
 * Learner progress. Every mutation that depends on a lesson having been *delivered* is a
 * compare-and-set (`advance`, `begin`), so a retried, duplicated or racing call can never skip
 * a lesson, move progress backwards, or complete a course twice. Progress writes take a row
 * lock first, so concurrent instances serialise instead of racing; the lock is always
 * released before any network call (sends happen in the controller, after commit).
 */
export class EnrollmentService {
  constructor(private readonly db: PgDb) {}

  // Reads take the org scope as a required first argument: another org's rows are invisible.

  async find(orgId: number, userId: string, courseId: number): Promise<EnrollmentSummary | undefined> {
    const { rows } = await query<EnrollmentRow>(
      this.db,
      `${SELECT} WHERE e.org_id = $1 AND e.user_id = $2 AND e.course_id = $3`,
      [orgId, userId, courseId],
    );
    const row = rows[0];
    return row && toSummary(row);
  }

  async findActive(orgId: number, userId: string): Promise<EnrollmentSummary | undefined> {
    const { rows } = await query<EnrollmentRow>(
      this.db,
      `${SELECT} WHERE e.org_id = $1 AND e.user_id = $2 AND e.status = 'active'`,
      [orgId, userId],
    );
    const row = rows[0];
    return row && toSummary(row);
  }

  /** The learner's most recently touched enrollment with the given status. */
  async findLatest(
    orgId: number,
    userId: string,
    status: EnrollmentStatus,
  ): Promise<EnrollmentSummary | undefined> {
    const { rows } = await query<EnrollmentRow>(
      this.db,
      `${SELECT} WHERE e.org_id = $1 AND e.user_id = $2 AND e.status = $3 ORDER BY e.updated_at DESC, e.id DESC LIMIT 1`,
      [orgId, userId, status],
    );
    const row = rows[0];
    return row && toSummary(row);
  }

  async listForUser(orgId: number, userId: string, limit = 5): Promise<EnrollmentSummary[]> {
    const { rows } = await query<EnrollmentRow>(
      this.db,
      `${SELECT} WHERE e.org_id = $1 AND e.user_id = $2 ORDER BY e.updated_at DESC, e.id DESC LIMIT $3`,
      [orgId, userId, limit],
    );
    return rows.map(toSummary);
  }

  /**
   * Org-agnostic routing helper for the WhatsApp bot (which has no auth principal): finds the
   * learner's enrollments across orgs so the bot can resolve which org's scope to use
   * (pending org, else active org, else default). Callers must then use scoped methods.
   */
  async locateUser(userId: string): Promise<EnrollmentSummary[]> {
    const { rows } = await query<EnrollmentRow>(
      this.db,
      `${SELECT} WHERE e.user_id = $1 ORDER BY e.updated_at DESC, e.id DESC LIMIT 10`,
      [userId],
    );
    return rows.map(toSummary);
  }

  /** Total enrollments of a phone across ALL orgs (used only for the delete decision). */
  async countEnrollments(userId: string): Promise<number> {
    const { rows } = await query<{ n: number }>(
      this.db,
      'SELECT COUNT(*) AS n FROM enrollments WHERE user_id = $1',
      [userId],
    );
    return Number(rows[0]?.n ?? 0);
  }

  /** Count enrollments outside an organisation without exposing their details. */
  async countEnrollmentsOutsideOrg(orgId: number, userId: string): Promise<number> {
    const { rows } = await query<{ n: number }>(
      this.db,
      'SELECT COUNT(*) AS n FROM enrollments WHERE user_id = $1 AND org_id <> $2',
      [userId, orgId],
    );
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * Delete every enrollment of a phone inside one org (quiz answers cascade).
   * Certificates reference enrollments with RESTRICT: delete those first via
   * CertificateService. Returns the deleted enrollment ids.
   */
  async deleteUserEnrollments(orgId: number, userId: string): Promise<number[]> {
    const { rows } = await query<{ id: number }>(
      this.db,
      'SELECT id FROM enrollments WHERE org_id = $1 AND user_id = $2',
      [orgId, userId],
    );
    for (const row of rows) {
      await query(this.db, 'DELETE FROM enrollments WHERE id = $1 AND org_id = $2', [
        row.id,
        orgId,
      ]);
    }
    return rows.map((r) => r.id);
  }

  /**
   * Enrol a learner after the first lesson was delivered. Returns false (and changes nothing)
   * if they already have an enrollment for this course, which makes retries harmless.
   */
  async begin(
    orgId: number,
    userId: string,
    courseId: number,
    deliveredPosition: number,
    isFinal: boolean,
  ): Promise<boolean> {
    const { rowCount } = await query(
      this.db,
      `INSERT INTO enrollments
         (org_id, user_id, course_id, status, last_delivered_position, completed_at)
       VALUES ($1, $2, $3, $4, $5, ${isFinal ? 'now()' : 'NULL'})
       ON CONFLICT (user_id, course_id) DO NOTHING`,
      [orgId, userId, courseId, isFinal ? 'completed' : 'active', deliveredPosition],
    );
    return rowCount === 1;
  }

  /**
   * Record that lesson `to` (which must be `from + 1`) was delivered, but only if progress is
   * still exactly `from` and the enrollment is active. Returns false when nothing changed (a stale or repeated call).
   * Completing is part of the same statement, so `completed_at` is written exactly once.
   * The row lock serialises racing instances; the WHERE clause keeps it a compare-and-set.
   */
  async advance(
    orgId: number,
    enrollmentId: number,
    from: number,
    to: number,
    isFinal: boolean,
  ): Promise<boolean> {
    // Progress moves one lesson at a time. Enforced here so no caller can skip ahead.
    if (to !== from + 1) return false;
    return transactional(this.db, async (tx) => {
      const { rows } = await query<EnrollmentRow>(
        tx,
        'SELECT * FROM enrollments WHERE id = $1 AND org_id = $2 FOR UPDATE',
        [enrollmentId, orgId],
      );
      const row = rows[0];
      if (!row || row.status !== 'active' || row.last_delivered_position !== from) return false;
      const { rowCount } = await query(
        tx,
        `UPDATE enrollments
         SET last_delivered_position = $1,
             status = CASE WHEN $2 THEN 'completed' ELSE status END,
             completed_at = CASE WHEN $2 THEN now() ELSE completed_at END,
             updated_at = now()
         WHERE id = $3 AND org_id = $4 AND status = 'active' AND last_delivered_position = $5`,
        [to, isFinal, enrollmentId, orgId, from],
      );
      return rowCount === 1;
    });
  }

  /** Mark an active enrollment complete (used only when it is found already fully delivered). */
  async complete(orgId: number, enrollmentId: number): Promise<boolean> {
    const { rowCount } = await query(
      this.db,
      `UPDATE enrollments SET status = 'completed', completed_at = now(), updated_at = now()
       WHERE id = $1 AND org_id = $2 AND status = 'active'`,
      [enrollmentId, orgId],
    );
    return rowCount === 1;
  }

  /** Fetch one enrollment by id within the caller's org. */
  async findById(orgId: number, enrollmentId: number): Promise<EnrollmentSummary | undefined> {
    const { rows } = await query<EnrollmentRow>(
      this.db,
      `${SELECT} WHERE e.id = $1 AND e.org_id = $2`,
      [enrollmentId, orgId],
    );
    const row = rows[0];
    return row && toSummary(row);
  }

  async pause(orgId: number, enrollmentId: number): Promise<boolean> {
    const { rowCount } = await query(
      this.db,
      `UPDATE enrollments SET status = 'paused', updated_at = now() WHERE id = $1 AND org_id = $2 AND status = 'active'`,
      [enrollmentId, orgId],
    );
    return rowCount === 1;
  }

  /**
   * Resume a paused enrollment. Returns false if it could not resume:
   * already active/completed, or the learner has another active course in the same org.
   */
  async resume(orgId: number, enrollmentId: number): Promise<boolean> {
    try {
      const { rowCount } = await query(
        this.db,
        `UPDATE enrollments SET status = 'active', updated_at = now() WHERE id = $1 AND org_id = $2 AND status = 'paused'`,
        [enrollmentId, orgId],
      );
      return rowCount === 1;
    } catch (err) {
      if (
        (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505') ||
        /UNIQUE constraint failed/i.test((err as Error).message)
      ) {
        return false;
      }
      throw err;
    }
  }

  /**
   * Create a pending enrollment for a learner (used by dashboard registration).
   * Returns the enrollment if created, or the existing one if already enrolled in this course.
   * Throws if the learner already has an active course (enforces one-active-course rule).
   */
  async createPending(orgId: number, userId: string, courseId: number): Promise<EnrollmentSummary> {
    const existing = await this.find(orgId, userId, courseId);
    if (existing) {
      return existing;
    }
    // Check if user already has an active course in this org (one active course per org).
    const active = await this.findActive(orgId, userId);
    if (active) {
      throw new NotFoundError('Learner already has an active course');
    }
    await query(
      this.db,
      `INSERT INTO enrollments (org_id, user_id, course_id, status, last_delivered_position)
       VALUES ($1, $2, $3, 'pending', 0)`,
      [orgId, userId, courseId],
    );
    const created = await this.find(orgId, userId, courseId);
    if (!created) throw new NotFoundError('Failed to create pending enrollment');
    return created;
  }

  /**
   * Durably record consent on an enrollment (admin attestation). audit_log is pruned by
   * retention, so consent is also stored on the enrollment row itself.
   */
  async recordConsent(
    orgId: number,
    enrollmentId: number,
    adminId: number | null,
  ): Promise<void> {
    await query(
      this.db,
      `UPDATE enrollments
        SET consent_at = now(), consent_source = 'admin_attestation', consent_admin_id = $1
       WHERE id = $2 AND org_id = $3`,
      [adminId, enrollmentId, orgId],
    );
  }

  /**
   * Start a pending enrollment (called when learner sends START or clicks Start Course button).
   * Updates status to 'active' and sets last_delivered_position to 0.
   */
  async startPending(orgId: number, enrollmentId: number): Promise<EnrollmentSummary | undefined> {
    const { rowCount } = await query(
      this.db,
      `UPDATE enrollments SET status = 'active', updated_at = now() WHERE id = $1 AND org_id = $2 AND status = 'pending'`,
      [enrollmentId, orgId],
    );
    if (rowCount !== 1) return undefined;
    const { rows } = await query<EnrollmentRow>(this.db, `${SELECT} WHERE e.id = $1 AND e.org_id = $2`, [
      enrollmentId,
      orgId,
    ]);
    const row = rows[0];
    return row && toSummary(row);
  }

  /** The enrollment only counts when it belongs to the caller's org. */
  private async mustOwn(orgId: number, enrollmentId: number): Promise<boolean> {
    const { rows } = await query<{ one: number }>(
      this.db,
      'SELECT 1 AS one FROM enrollments WHERE id = $1 AND org_id = $2',
      [enrollmentId, orgId],
    );
    return rows.length > 0;
  }

  /** Has the learner answered the quiz for this lesson position? First answer counts. */
  async hasQuizAnswer(orgId: number, enrollmentId: number, position: number): Promise<boolean> {
    if (!(await this.mustOwn(orgId, enrollmentId))) return false;
    const { rows } = await query<{ one: number }>(
      this.db,
      'SELECT 1 AS one FROM quiz_answers WHERE enrollment_id = $1 AND position = $2',
      [enrollmentId, position],
    );
    return rows.length > 0;
  }

  /** Record a quiz answer. Re-answers are ignored (first answer unlocks NEXT). */
  async recordQuizAnswer(
    orgId: number,
    enrollmentId: number,
    position: number,
    chosen: number,
    correct: boolean,
  ): Promise<void> {
    if (!(await this.mustOwn(orgId, enrollmentId))) return;
    await query(
      this.db,
      'INSERT INTO quiz_answers (enrollment_id, position, chosen, correct) VALUES ($1, $2, $3, $4) ON CONFLICT (enrollment_id, position) DO NOTHING',
      [enrollmentId, position, chosen, correct],
    );
  }
}
