import { isUniqueViolation, iso, query, transactional } from '../db/pg';
import type { PgDb } from '../db/pg';
import { ConflictError, NotFoundError, UnprocessableError } from '../errors';
import {
  LIMITS,
  type Course,
  type CourseCreateInput,
  type CourseDetail,
  type CourseStatus,
  type CourseUpdateInput,
  type Lesson,
  type LessonCreateInput,
  type LessonItem,
  type LessonUpdateInput,
} from '../types/course';

interface CourseRow {
  id: number;
  org_id: number;
  slug: string;
  title: string;
  description: string;
  status: CourseStatus;
  lesson_count: number;
  created_at: Date | string;
  updated_at: Date | string;
}

interface LessonRow {
  id: number;
  course_id: number;
  position: number;
  title: string;
}

interface ItemRow {
  lesson_id: number;
  kind: LessonItem['kind'];
  text: string | null;
  url: string | null;
  options: unknown; // JSONB: parsed object, array, or null
  explanation: string | null;
}

const COURSE_SELECT = `
  SELECT c.id, c.org_id, c.slug, c.title, c.description, c.status, c.created_at, c.updated_at,
         (SELECT COUNT(*) FROM lessons l WHERE l.course_id = c.id) AS lesson_count
  FROM courses c`;

function toCourse(row: CourseRow): Course {
  return {
    id: row.id,
    orgId: row.org_id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    status: row.status,
    lessonCount: Number(row.lesson_count),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function toItem(row: ItemRow): LessonItem {
  const options =
    row.options == null || typeof row.options === 'string'
      ? (row.options ? JSON.parse(row.options) : [])
      : row.options;
  switch (row.kind) {
    case 'text':
      return { kind: 'text', text: row.text ?? '' };
    case 'link':
      return { kind: 'link', url: row.url ?? '', ...(row.text ? { label: row.text } : {}) };
    case 'quiz':
      return {
        kind: 'quiz',
        caption: row.text ?? '',
        explanation: row.explanation,
        options: Array.isArray(options) ? options : [],
      };
    default:
      return { kind: row.kind, url: row.url ?? '', ...(row.text ? { caption: row.text } : {}) };
  }
}

function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, LIMITS.slugMax)
    .replace(/-+$/g, '');
  // A slug must contain a letter so it can't be confused with a numeric course id.
  return /[a-z]/.test(base) ? base : `course-${base || 'new'}`.slice(0, LIMITS.slugMax);
}

export class CourseService {
  constructor(private readonly db: PgDb) {}

  // ---- Courses ------------------------------------------------------------------------
  // Every method takes the org scope as a required first argument: a course from another
  // org is invisible (undefined / NotFoundError, mapped to 404 by callers).

  async listCourses(orgId: number, filter: { status?: CourseStatus } = {}): Promise<Course[]> {
    const { rows } = filter.status
      ? await query<CourseRow>(
          this.db,
          `${COURSE_SELECT} WHERE c.org_id = $1 AND c.status = $2 ORDER BY c.id`,
          [orgId, filter.status],
        )
      : await query<CourseRow>(this.db, `${COURSE_SELECT} WHERE c.org_id = $1 ORDER BY c.id`, [
          orgId,
        ]);
    return rows.map(toCourse);
  }

  async getCourse(orgId: number, id: number): Promise<Course | undefined> {
    const { rows } = await query<CourseRow>(this.db, `${COURSE_SELECT} WHERE c.org_id = $1 AND c.id = $2`, [
      orgId,
      id,
    ]);
    const row = rows[0];
    return row && toCourse(row);
  }

  async getCourseBySlug(orgId: number, slug: string): Promise<Course | undefined> {
    const { rows } = await query<CourseRow>(
      this.db,
      `${COURSE_SELECT} WHERE c.org_id = $1 AND c.slug = $2`,
      [orgId, slug],
    );
    const row = rows[0];
    return row && toCourse(row);
  }

  /** Resolve what a learner typed after START: a numeric id, a slug, or an exact title. */
  async findCourseByRef(orgId: number, ref: string): Promise<Course | undefined> {
    const value = ref.trim();
    if (!value) return undefined;
    if (/^\d+$/.test(value)) return this.getCourse(orgId, Number(value));
    const { rows } = await query<CourseRow>(
      this.db,
      `${COURSE_SELECT} WHERE c.org_id = $1 AND (c.slug = lower($2) OR lower(c.title) = lower($3)) ORDER BY c.id LIMIT 1`,
      [orgId, value, value],
    );
    const row = rows[0];
    return row && toCourse(row);
  }

  async getCourseDetail(orgId: number, id: number): Promise<CourseDetail | undefined> {
    const course = await this.getCourse(orgId, id);
    if (!course) return undefined;
    const { rows: lessonRows } = await query<LessonRow>(
      this.db,
      'SELECT id, course_id, position, title FROM lessons WHERE course_id = $1 ORDER BY position',
      [id],
    );
    const { rows: itemRows } = await query<ItemRow>(
      this.db,
      `      SELECT i.lesson_id, i.kind, i.text, i.url, i.options, i.explanation
       FROM lesson_items i JOIN lessons l ON l.id = i.lesson_id
       WHERE l.course_id = $1 ORDER BY i.lesson_id, i.position`,
      [id],
    );
    const lessons: Lesson[] = lessonRows.map((l) => ({
      id: l.id,
      courseId: l.course_id,
      position: l.position,
      title: l.title,
      items: itemRows.filter((i) => i.lesson_id === l.id).map(toItem),
    }));
    return { ...course, lessons };
  }

  /** Create a draft course, optionally with its lessons, atomically. */
  async createCourse(orgId: number, input: CourseCreateInput): Promise<CourseDetail> {
    const id = await transactional(this.db, async (tx) => {
      const slug = input.slug ?? (await this.uniqueSlug(slugify(input.title)));
      if (await this.getCourseBySlugTx(tx, orgId, slug)) {
        throw new ConflictError(`Slug "${slug}" is already in use`);
      }
      try {
        const { rows } = await query<{ id: number }>(
          tx,
          'INSERT INTO courses (org_id, slug, title, description) VALUES ($1, $2, $3, $4) RETURNING id',
          [orgId, slug, input.title, input.description],
        );
        const courseId = (rows[0] as { id: number }).id;
        for (const [index, lesson] of input.lessons.entries()) {
          await this.insertLessonTx(tx, courseId, index + 1, lesson);
        }
        return courseId;
      } catch (err) {
        // Slugs are globally unique: a racing insert loses here instead of duplicating.
        if (isUniqueViolation(err)) throw new ConflictError(`Slug "${slug}" is already in use`);
        throw err;
      }
    });
    return this.mustGetDetail(orgId, id);
  }

  async updateCourse(orgId: number, id: number, patch: CourseUpdateInput): Promise<CourseDetail> {
    const existing = await this.mustGetCourse(orgId, id);
    await query(
      this.db,
      'UPDATE courses SET title = $1, description = $2, updated_at = now() WHERE id = $3 AND org_id = $4',
      [patch.title ?? existing.title, patch.description ?? existing.description, id, orgId],
    );
    return this.mustGetDetail(orgId, id);
  }

  /** Idempotent. A course needs at least one lesson before learners can see it. */
  async publish(orgId: number, id: number): Promise<CourseDetail> {
    const course = await this.mustGetCourse(orgId, id);
    if (course.lessonCount < 1) {
      throw new UnprocessableError('Add at least one lesson before publishing');
    }
    await this.setStatus(id, 'published');
    return this.mustGetDetail(orgId, id);
  }

  /** Idempotent. Hides the course from new learners; existing learners can finish it. */
  async unpublish(orgId: number, id: number): Promise<CourseDetail> {
    await this.mustGetCourse(orgId, id);
    await this.setStatus(id, 'draft');
    return this.mustGetDetail(orgId, id);
  }

  async deleteCourse(orgId: number, id: number): Promise<void> {
    await this.mustGetCourse(orgId, id);
    if (await this.hasEnrollments(id)) {
      throw new ConflictError(
        'Learners are enrolled in this course; unpublish it instead of deleting',
      );
    }
    await query(this.db, 'DELETE FROM courses WHERE id = $1 AND org_id = $2', [id, orgId]);
  }

  // ---- Lessons ------------------------------------------------------------------------

  /** Lessons are always appended; reordering is not supported (it would corrupt progress). */
  async addLesson(orgId: number, courseId: number, input: LessonCreateInput): Promise<CourseDetail> {
    const course = await this.mustGetCourse(orgId, courseId);
    if (course.lessonCount >= LIMITS.lessonsPerCourseMax) {
      throw new UnprocessableError(
        `A course can have at most ${LIMITS.lessonsPerCourseMax} lessons`,
      );
    }
    await transactional(this.db, async (tx) => {
      // Row-lock the course so concurrent appends allocate distinct positions. The position
      // UNIQUE is DEFERRABLE, so ON CONFLICT must never target it — the lock is the arbiter.
      await query(tx, 'SELECT id FROM courses WHERE id = $1 AND org_id = $2 FOR UPDATE', [
        courseId,
        orgId,
      ]);
      const { rows } = await query<{ m: number }>(
        tx,
        'SELECT COALESCE(MAX(position), 0) AS m FROM lessons WHERE course_id = $1',
        [courseId],
      );
      await this.insertLessonTx(tx, courseId, Number(rows[0]?.m ?? 0) + 1, input);
      await query(tx, 'UPDATE courses SET updated_at = now() WHERE id = $1', [courseId]);
    });
    return this.mustGetDetail(orgId, courseId);
  }

  async updateLesson(
    orgId: number,
    courseId: number,
    lessonId: number,
    patch: LessonUpdateInput,
  ): Promise<CourseDetail> {
    await this.mustGetCourse(orgId, courseId);
    await this.mustGetLessonRow(courseId, lessonId);
    await transactional(this.db, async (tx) => {
      if (patch.title !== undefined) {
        await query(tx, 'UPDATE lessons SET title = $1, updated_at = now() WHERE id = $2', [
          patch.title,
          lessonId,
        ]);
      }
      if (patch.items !== undefined) {
        await query(tx, 'DELETE FROM lesson_items WHERE lesson_id = $1', [lessonId]);
        await this.insertItemsTx(tx, lessonId, patch.items);
        await query(tx, 'UPDATE lessons SET updated_at = now() WHERE id = $1', [lessonId]);
      }
      await query(tx, 'UPDATE courses SET updated_at = now() WHERE id = $1', [courseId]);
    });
    return this.mustGetDetail(orgId, courseId);
  }

  /**
   * Deleting renumbers later lessons, which would make stored learner positions point at the
   * wrong lesson. So it is refused once anyone is enrolled. The renumber is a single ordered
   * UPDATE under the deferrable UNIQUE — no negative-position trick.
   */
  async deleteLesson(orgId: number, courseId: number, lessonId: number): Promise<CourseDetail> {
    const course = await this.mustGetCourse(orgId, courseId);
    const lesson = await this.mustGetLessonRow(courseId, lessonId);
    if (await this.hasEnrollments(courseId)) {
      throw new ConflictError(
        'Learners are enrolled in this course; lessons can no longer be deleted',
      );
    }
    if (course.status === 'published' && course.lessonCount <= 1) {
      throw new ConflictError('Unpublish the course before deleting its only lesson');
    }
    await transactional(this.db, async (tx) => {
      await query(tx, 'DELETE FROM lessons WHERE id = $1', [lessonId]);
      await query(
        tx,
        'UPDATE lessons SET position = position - 1 WHERE course_id = $1 AND position > $2',
        [courseId, lesson.position],
      );
      await query(tx, 'UPDATE courses SET updated_at = now() WHERE id = $1', [courseId]);
    });
    return this.mustGetDetail(orgId, courseId);
  }

  /** The lesson at a 1-based position, with its items, or undefined if there is none. */
  async getLessonAt(orgId: number, courseId: number, position: number): Promise<Lesson | undefined> {
    if (!(await this.getCourse(orgId, courseId))) return undefined;
    const { rows } = await query<LessonRow>(
      this.db,
      'SELECT id, course_id, position, title FROM lessons WHERE course_id = $1 AND position = $2',
      [courseId, position],
    );
    const row = rows[0];
    if (!row) return undefined;
    const { rows: items } = await query<ItemRow>(
      this.db,
      'SELECT lesson_id, kind, text, url, options, explanation FROM lesson_items WHERE lesson_id = $1 ORDER BY position',
      [row.id],
    );
    return {
      id: row.id,
      courseId: row.course_id,
      position: row.position,
      title: row.title,
      items: items.map(toItem),
    };
  }

  /** Every lesson of a course in order, with items. Used for course-scoped Q&A. */
  async getAllLessons(orgId: number, courseId: number): Promise<Lesson[]> {
    return (await this.getCourseDetail(orgId, courseId))?.lessons ?? [];
  }

  // ---- internals ----------------------------------------------------------------------

  /** Same-org slug lookup inside a transaction. */
  private async getCourseBySlugTx(
    tx: PgDb,
    orgId: number,
    slug: string,
  ): Promise<Course | undefined> {
    const { rows } = await query<CourseRow>(
      tx,
      `${COURSE_SELECT} WHERE c.org_id = $1 AND c.slug = $2`,
      [orgId, slug],
    );
    const row = rows[0];
    return row && toCourse(row);
  }

  private async mustGetCourse(orgId: number, id: number): Promise<Course> {
    const course = await this.getCourse(orgId, id);
    if (!course) throw new NotFoundError('Course not found');
    return course;
  }

  private async mustGetDetail(orgId: number, id: number): Promise<CourseDetail> {
    const detail = await this.getCourseDetail(orgId, id);
    if (!detail) throw new NotFoundError('Course not found');
    return detail;
  }

  private async mustGetLessonRow(courseId: number, lessonId: number): Promise<LessonRow> {
    const { rows } = await query<LessonRow>(
      this.db,
      'SELECT id, course_id, position, title FROM lessons WHERE id = $1 AND course_id = $2',
      [lessonId, courseId],
    );
    const row = rows[0];
    if (!row) throw new NotFoundError('Lesson not found');
    return row;
  }

  private async setStatus(id: number, status: CourseStatus): Promise<void> {
    await query(this.db, 'UPDATE courses SET status = $1, updated_at = now() WHERE id = $2', [
      status,
      id,
    ]);
  }

  private async hasEnrollments(courseId: number): Promise<boolean> {
    const { rows } = await query<{ one: number }>(
      this.db,
      'SELECT 1 AS one FROM enrollments WHERE course_id = $1 LIMIT 1',
      [courseId],
    );
    return rows.length > 0;
  }

  private async uniqueSlug(base: string): Promise<string> {
    // Slugs are globally unique (UNIQUE constraint), so the check is deliberately org-agnostic.
    let candidate = base;
    for (let n = 2; ; n++) {
      const { rows } = await query<{ one: number }>(
        this.db,
        'SELECT 1 AS one FROM courses WHERE slug = $1',
        [candidate],
      );
      if (rows.length === 0) return candidate;
      const suffix = `-${n}`;
      candidate = `${base.slice(0, LIMITS.slugMax - suffix.length)}${suffix}`;
    }
  }

  private async insertLessonTx(
    tx: PgDb,
    courseId: number,
    position: number,
    lesson: LessonCreateInput,
  ): Promise<void> {
    const { rows } = await query<{ id: number }>(
      tx,
      'INSERT INTO lessons (course_id, position, title) VALUES ($1, $2, $3) RETURNING id',
      [courseId, position, lesson.title],
    );
    await this.insertItemsTx(tx, (rows[0] as { id: number }).id, lesson.items);
  }

  private async insertItemsTx(tx: PgDb, lessonId: number, items: LessonItem[]): Promise<void> {
    let position = 0;
    for (const item of items) {
      position += 1;
      switch (item.kind) {
        case 'text':
          await query(tx, 'INSERT INTO lesson_items (lesson_id, position, kind, text) VALUES ($1, $2, $3, $4)', [
            lessonId,
            position,
            'text',
            item.text,
          ]);
          break;
        case 'link':
          await query(tx, 'INSERT INTO lesson_items (lesson_id, position, kind, text, url) VALUES ($1, $2, $3, $4, $5)', [
            lessonId,
            position,
            'link',
            item.label ?? null,
            item.url,
          ]);
          break;
        case 'quiz':
          await query(tx, 'INSERT INTO lesson_items (lesson_id, position, kind, text, options, explanation) VALUES ($1, $2, $3, $4, $5, $6)', [
            lessonId,
            position,
            'quiz',
            item.caption ?? null,
            JSON.stringify(item.options),
            item.explanation ?? null,
          ]);
          break;
        default:
          await query(tx, 'INSERT INTO lesson_items (lesson_id, position, kind, text, url) VALUES ($1, $2, $3, $4, $5)', [
            lessonId,
            position,
            item.kind,
            item.caption ?? null,
            item.url,
          ]);
      }
    }
  }
}
