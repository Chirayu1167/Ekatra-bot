import { query, iso, transactional } from '../db/pg';
import type { PgDb } from '../db/pg';
import type { Request, RequestHandler } from 'express';
import { z } from 'zod';
import { BadRequestError, ConflictError, NotFoundError } from '../errors';
import { principal } from '../middleware/adminAuth';
import type { AdminAuthService, AdminRole } from '../services/adminAuth.service';
import type { CourseService } from '../services/course.service';
import type { EnrollmentService } from '../services/enrollment.service';
import type { OrganisationsService } from '../services/organisations.service';
import type { SchedulerService } from '../services/scheduler.service';
import { wallParts, zonedWallToUtcMs } from '../services/scheduler.service';
import {
  courseCreateSchema,
  courseUpdateSchema,
  lessonCreateSchema,
  lessonUpdateSchema,
} from '../types/course';
import { maskPhone } from '../logger';
import type { LearnerService } from '../services/learner.service';
import type { OptOutService } from '../services/optout.service';
import type { OutboundService } from '../services/outbound.service';
import type { CertificateService } from '../services/certificate.service';

/** Validate a request body, turning Zod issues into one readable 400. */
function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    const problems = result.error.issues
      .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
      .join('; ');
    throw new BadRequestError(`Invalid request: ${problems}`);
  }
  return result.data;
}

function idParam(req: Request, name: string): number {
  const raw = req.params[name];
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) throw new NotFoundError();
  return Number(raw);
}

/**
 * Tenant scope for this request, set by the admin router's org-resolution middleware
 * (Task 3 replaces the bootstrap resolver with principal-based auth). Missing scope is a
 * programmer error: fail closed rather than serve cross-org data.
 */
export function orgId(req: Request): number {
  const id = (req.res?.locals as { orgId?: unknown } | undefined)?.orgId;
  if (typeof id !== 'number' || !Number.isInteger(id) || id < 1) {
    throw new NotFoundError();
  }
  return id;
}

/** Audit recorder bound to a service: ids and slugs only, never key values. */
export function makeAuditor(auth: AdminAuthService) {
  return async (req: Request, action: string, target = ''): Promise<void> => {
    const p = principal(req);
    await auth.recordAudit(p.userId, orgId(req), action, target);
  };
}

const statusFilter = z.enum(['draft', 'published']);

const wallTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'must be wall-clock HH:MM (24h)');
const customSlot = z.object({
  dow: z.number().int().min(0).max(6),
  time: wallTime,
});
const courseScheduleSchema = z.object({
  kind: z.enum(['daily', 'custom']),
  dailyTime: wallTime.nullable().optional(),
  slots: z.array(customSlot).max(21).optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
});
const enrollmentScheduleSchema = z.object({
  timezone: z.string().trim().min(1).max(64).optional(),
  dailyTime: wallTime.nullable().optional(),
  slots: z.array(customSlot).max(21).optional(),
  enabled: z.boolean().optional(),
});
const orgDefaultsSchema = z.object({
  timezone: z.string().trim().min(1).max(64).optional(),
  dailyTime: wallTime.nullable().optional(),
  graceHours: z.number().int().min(1).max(72).optional(),
});

const consentSchema = z.object({
  phone: z.string().trim().min(1),
  courseId: z.coerce.number().int().positive(),
  consent: z.literal(true, { error: 'consent must be true' }),
});

const schedulePreviewSchema = z.object({
  enrollmentId: z.coerce.number().int().positive(),
  count: z.coerce.number().int().min(1).max(30).default(5),
});

const learnerQuerySchema = z.object({
  courseId: z.coerce.number().int().positive().optional(),
  status: z.enum(['pending', 'active', 'paused', 'completed']).optional(),
  optedOut: z.enum(['true', 'false']).optional(),
  search: z.string().trim().min(1).optional(),
  sort: z.enum(['name', 'lastActivity']).default('lastActivity'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const enrollmentQuerySchema = z.object({
  courseId: z.coerce.number().int().positive().optional(),
  status: z.enum(['pending', 'active', 'paused', 'completed']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const deliveryQuerySchema = z.object({
  status: z.enum(['queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'unknown', 'dead_letter']).optional(),
  courseId: z.coerce.number().int().positive().optional(),
  learnerId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export interface AdminControllerDeps {
  db: PgDb;
  courses: CourseService;
  orgs: OrganisationsService;
  auth: AdminAuthService;
  /** Schedule store. Omit to leave schedule routes unmounted (they return 404). */
  schedules?: SchedulerService;
  /** Learner-data services. Omit to leave learner routes unmounted. */
  enrollments?: EnrollmentService;
  learners?: LearnerService;
  optOuts?: OptOutService;
  outbound?: OutboundService;
  certificates?: CertificateService;
}

const orgBodySchema = z.object({
  slug: z.string().trim().min(1).max(64),
  name: z.string().trim().max(120).default(''),
});

const roleSchema = z.enum(['platform_admin', 'org_admin', 'instructor']);

const userBodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  role: roleSchema,
  /** Target org slug. Only platform_admin may set it; others are pinned to their own org. */
  org: z.string().trim().min(1).max(64).optional(),
});

export function createAdminController({
  db,
  courses,
  orgs,
  auth,
  schedules,
  enrollments,
  learners,
  optOuts,
  outbound,
  certificates,
}: AdminControllerDeps) {
  /** Target org for user/key management: platform_admin may name one, others are pinned. */
  const targetOrgId = async (req: Request): Promise<number | null> => {
    const p = principal(req);
    const raw = (req.body as { org?: unknown } | undefined)?.org ?? req.query['org'];
    if (p.role === 'platform_admin' && p.orgId === null) {
      if (raw === undefined) return await orgs.getDefaultId();
      if (typeof raw !== 'string') throw new NotFoundError('Organisation not found');
      const org = await orgs.getBySlug(raw.trim().toLowerCase());
      if (!org) throw new NotFoundError('Organisation not found');
      return org.id;
    }
    if (raw !== undefined) {
      const slug = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
      const org = slug ? await orgs.getBySlug(slug) : undefined;
      if (!org || org.id !== p.orgId) throw new NotFoundError('Organisation not found');
    }
    if (p.orgId === null) throw new NotFoundError('Organisation not found');
    return p.orgId;
  };

  /** Load a target user, visible only inside the caller's scope (else 404, never 403). */
  const scopedUser = async (req: Request, id: number) => {
    const p = principal(req);
    const user = await auth.getUser(id);
    if (!user) throw new NotFoundError('User not found');
    if (p.role !== 'platform_admin' && user.orgId !== p.orgId) {
      throw new NotFoundError('User not found');
    }
    return user;
  };

  const audit = async (req: Request, action: string, target = '') => {
    const p = principal(req);
    await auth.recordAudit(p.userId, orgId(req), action, target);
  };

  const getCourse: RequestHandler = async (req, res) => {
    const detail = await courses.getCourseDetail(orgId(req), idParam(req, 'id'));
    if (!detail) throw new NotFoundError('Course not found');
    res.json({ course: detail });
  };

  return {
    listCourses: (async (req, res) => {
      const raw = req.query['status'];
      let status: z.infer<typeof statusFilter> | undefined;
      if (raw !== undefined) {
        const parsed = statusFilter.safeParse(raw);
        if (!parsed.success) throw new BadRequestError('status must be "draft" or "published"');
        status = parsed.data;
      }
      res.json({ courses: await courses.listCourses(orgId(req), status ? { status } : {}) });
    }) satisfies RequestHandler,

    getCourse,

    createCourse: (async (req, res) => {
      const course = await courses.createCourse(orgId(req), parseBody(courseCreateSchema, req.body));
      res.status(201).location(`/admin/courses/${course.id}`).json({ course });
    }) satisfies RequestHandler,

    updateCourse: (async (req, res) => {
      const patch = parseBody(courseUpdateSchema, req.body);
      res.json({ course: await courses.updateCourse(orgId(req), idParam(req, 'id'), patch) });
    }) satisfies RequestHandler,

    publishCourse: (async (req, res) => {
      const id = idParam(req, 'id');
      const course = await courses.publish(orgId(req), id);
      await audit(req, 'course.publish', `course:${id}`);
      res.json({ course });
    }) satisfies RequestHandler,

    unpublishCourse: (async (req, res) => {
      const id = idParam(req, 'id');
      const course = await courses.unpublish(orgId(req), id);
      await audit(req, 'course.unpublish', `course:${id}`);
      res.json({ course });
    }) satisfies RequestHandler,

    deleteCourse: (async (req, res) => {
      await courses.deleteCourse(orgId(req), idParam(req, 'id'));
      res.status(204).end();
    }) satisfies RequestHandler,

    addLesson: (async (req, res) => {
      const lesson = parseBody(lessonCreateSchema, req.body);
      res.status(201).json({ course: await courses.addLesson(orgId(req), idParam(req, 'id'), lesson) });
    }) satisfies RequestHandler,

    updateLesson: (async (req, res) => {
      const patch = parseBody(lessonUpdateSchema, req.body);
      res.json({
        course: await courses.updateLesson(
          orgId(req),
          idParam(req, 'id'),
          idParam(req, 'lessonId'),
          patch,
        ),
      });
    }) satisfies RequestHandler,

    deleteLesson: (async (req, res) => {
      res.json({
        course: await courses.deleteLesson(orgId(req), idParam(req, 'id'), idParam(req, 'lessonId')),
      });
    }) satisfies RequestHandler,

    // ---- Schedules (Phase 3; mounted only when the schedule store is configured) --------

    getCourseSchedule: (async (req, res) => {
      if (!schedules) throw new NotFoundError();
      const id = idParam(req, 'id');
      if (!(await courses.getCourse(orgId(req), id))) throw new NotFoundError('Course not found');
      res.json({ schedule: (await schedules.getCourseSchedule(orgId(req), id)) ?? null });
    }) satisfies RequestHandler,

    setCourseSchedule: (async (req, res) => {
      if (!schedules) throw new NotFoundError();
      const id = idParam(req, 'id');
      if (!(await courses.getCourse(orgId(req), id))) throw new NotFoundError('Course not found');
      const body = parseBody(courseScheduleSchema, req.body);
      try {
        await schedules.setCourseSchedule(orgId(req), id, {
          kind: body.kind,
          ...(body.dailyTime !== undefined && { dailyTime: body.dailyTime }),
          ...(body.slots !== undefined && { slots: body.slots }),
          ...(body.timezone !== undefined && { timezone: body.timezone }),
        });
      } catch (err) {
        throw new BadRequestError(err instanceof Error ? err.message : 'Invalid schedule');
      }
      await audit(req, 'schedule.set', `course:${id}`);
      res.json({ schedule: await schedules.getCourseSchedule(orgId(req), id) });
    }) satisfies RequestHandler,

    deleteCourseSchedule: (async (req, res) => {
      if (!schedules) throw new NotFoundError();
      const id = idParam(req, 'id');
      if (!(await courses.getCourse(orgId(req), id))) throw new NotFoundError('Course not found');
      await schedules.deleteCourseSchedule(orgId(req), id);
      await audit(req, 'schedule.delete', `course:${id}`);
      res.status(204).end();
    }) satisfies RequestHandler,

    getEnrollmentSchedule: (async (req, res) => {
      if (!schedules) throw new NotFoundError();
      const id = idParam(req, 'id');
      // Org scoping: another org's enrollment is invisible (404, never 403).
      if (!(await schedules.ownsEnrollment(orgId(req), id))) throw new NotFoundError('Enrollment not found');
      res.json({ schedule: (await schedules.getEnrollmentSchedule(id)) ?? null });
    }) satisfies RequestHandler,

    setEnrollmentSchedule: (async (req, res) => {
      if (!schedules) throw new NotFoundError();
      const id = idParam(req, 'id');
      const body = parseBody(enrollmentScheduleSchema, req.body);
      try {
        const row = await schedules.setEnrollmentSchedule(orgId(req), id, {
          ...(body.timezone !== undefined && { timezone: body.timezone }),
          ...(body.dailyTime !== undefined && { dailyTime: body.dailyTime }),
          ...(body.slots !== undefined && { slots: body.slots }),
          ...(body.enabled !== undefined && { enabled: body.enabled }),
        });
        await audit(req, 'schedule.set', `enrollment:${id}`);
        res.json({ schedule: row });
      } catch (err) {
        if (err instanceof Error && err.message === 'enrollment not found') {
          throw new NotFoundError('Enrollment not found');
        }
        throw new BadRequestError(err instanceof Error ? err.message : 'Invalid schedule');
      }
    }) satisfies RequestHandler,

    getScheduleDefaults: (async (req, res) => {
      if (!schedules) throw new NotFoundError();
      res.json({ defaults: await schedules.getOrgDefaults(orgId(req)) });
    }) satisfies RequestHandler,

    setScheduleDefaults: (async (req, res) => {
      if (!schedules) throw new NotFoundError();
      const body = parseBody(orgDefaultsSchema, req.body);
      try {
        const defaults = await schedules.setOrgDefaults(orgId(req), {
          ...(body.timezone !== undefined && { timezone: body.timezone }),
          ...(body.dailyTime !== undefined && { dailyTime: body.dailyTime }),
          ...(body.graceHours !== undefined && { graceHours: body.graceHours }),
        });
        await audit(req, 'schedule.defaults.set', `org:${orgId(req)}`);
        res.json({ defaults });
      } catch (err) {
        throw new BadRequestError(err instanceof Error ? err.message : 'Invalid defaults');
      }
    }) satisfies RequestHandler,

    // ---- Organisations (platform_admin; enforced by route middleware) -------------------

    listOrgs: (async (_req, res) => {
      res.json({ organisations: await orgs.list() });
    }) satisfies RequestHandler,

    createOrg: (async (req, res) => {
      const body = parseBody(orgBodySchema, req.body);
      const org = await orgs.create({ slug: body.slug, name: body.name });
      await audit(req, 'org.create', `org:${org.slug}`);
      res.status(201).json({ organisation: org });
    }) satisfies RequestHandler,

    // ---- Users & keys (platform_admin + org_admin; enforced by route middleware) --------

    listUsers: (async (req, res) => {
      const p = principal(req);
      const scope: number | null =
        p.role === 'platform_admin' && p.orgId === null
          ? await (async (): Promise<number | null> => {
              const raw = req.query['org'];
              if (raw === undefined) return null;
              if (typeof raw !== 'string') throw new NotFoundError('Organisation not found');
              const org = await orgs.getBySlug(raw.trim().toLowerCase());
              if (!org) throw new NotFoundError('Organisation not found');
              return org.id;
            })()
          : orgId(req);
      res.json({ users: await auth.listUsers(scope) });
    }) satisfies RequestHandler,

    createUser: (async (req, res) => {
      const body = parseBody(userBodySchema, req.body);
      const p = principal(req);
      // platform_admin users live outside every org; everyone else needs a target org.
      const targetOrg =
        body.role === 'platform_admin'
          ? (() => {
              if (p.role !== 'platform_admin') throw new NotFoundError('Organisation not found');
              if (body.org !== undefined) throw new BadRequestError('platform_admin has no org');
              return null;
            })()
          : await targetOrgId(req);
      const user = await auth.createUser(targetOrg, body.name, body.role as AdminRole);
      const key = await auth.issueKey(user.id);
      await audit(req, 'user.create', `user:${user.id}`);
      await audit(req, 'key.issue', `user:${user.id} key:${key.id}`);
      // The plaintext key is shown exactly once, here. It is never stored or logged.
      res
        .status(201)
        .json({ user, apiKey: key.plaintext, keyId: key.id, prefix: key.prefix });
    }) satisfies RequestHandler,

    rotateUserKey: (async (req, res) => {
      const user = await scopedUser(req, idParam(req, 'id'));
      const revoked = await auth.revokeUserKeys(user.id);
      const key = await auth.issueKey(user.id);
      await audit(req, 'key.rotate', `user:${user.id} key:${key.id}`);
      res.status(201).json({ apiKey: key.plaintext, keyId: key.id, prefix: key.prefix, revoked });
    }) satisfies RequestHandler,

    revokeUserKey: (async (req, res) => {
      const user = await scopedUser(req, idParam(req, 'id'));
      const keyId = idParam(req, 'keyId');
      const key = await auth.getKey(keyId);
      if (!key || key.userId !== user.id || key.revoked) throw new NotFoundError('Key not found');
      await auth.revokeKey(keyId);
      await audit(req, 'key.revoke', `user:${user.id} key:${keyId}`);
      res.status(204).end();
    }) satisfies RequestHandler,

    recoverUserKey: (async (req, res) => {
      const user = await scopedUser(req, idParam(req, 'id'));
      const revoked = await auth.revokeUserKeys(user.id);
      const key = await auth.issueKey(user.id);
      await audit(req, 'key.recover', `user:${user.id} key:${key.id}`);
      res.status(200).json({ apiKey: key.plaintext, keyId: key.id, prefix: key.prefix, revoked });
    }) satisfies RequestHandler,

    // ---- Audit log ----------------------------------------------------------------------

    listAudit: (async (req, res) => {
      const p = principal(req);
      if (p.role === 'platform_admin' && p.orgId === null) {
        const raw = req.query['org'];
        if (raw === undefined) {
          res.json({ entries: await auth.listAudit(null) });
          return;
        }
        if (typeof raw !== 'string') throw new NotFoundError('Organisation not found');
        const org = await orgs.getBySlug(raw.trim().toLowerCase());
        if (!org) throw new NotFoundError('Organisation not found');
        res.json({ entries: await auth.listAudit(org.id) });
        return;
      }
      res.json({ entries: await auth.listAudit(orgId(req)) });
    }) satisfies RequestHandler,

    // ---- Session (any authenticated admin) ----------------------------------------------

    getSession: (async (req, res) => {
      const p = principal(req);
      let orgSlug: string | null = null;
      if (p.orgId !== null) {
        const org = await orgs.getById(p.orgId);
        orgSlug = org?.slug ?? null;
      }
      let name = '';
      if (p.userId !== null) {
        const user = await auth.getUser(p.userId);
        if (user) name = user.name;
      }
      res.json({ id: p.userId, name, role: p.role, orgId: p.orgId, orgSlug });
    }) satisfies RequestHandler,

    // ---- Learners (readable by instructors; management remains admin-only) --------------

    listLearners: (async (req, res) => {
      if (!enrollments || !learners || !optOuts) throw new NotFoundError();
      const q = parseBody(learnerQuerySchema, req.query);
      const org = orgId(req);
      const offset = (q.page - 1) * q.pageSize;

      const conditions: string[] = ['e.org_id = $1'];
      const params: unknown[] = [org];
      let paramIdx = 2;

      if (q.courseId !== undefined) {
        conditions.push(`e.course_id = $${paramIdx}`);
        params.push(q.courseId);
        paramIdx++;
      }
      if (q.status !== undefined) {
        conditions.push(`e.status = $${paramIdx}`);
        params.push(q.status);
        paramIdx++;
      }
      if (q.optedOut !== undefined) {
        const optedOut = q.optedOut === 'true';
        conditions.push(
          optedOut
            ? `EXISTS (SELECT 1 FROM opt_outs oo WHERE oo.user_id = e.user_id)`
            : `NOT EXISTS (SELECT 1 FROM opt_outs oo WHERE oo.user_id = e.user_id)`,
        );
      }
      if (q.search !== undefined) {
        const term = q.search.trim();
        const digitsOnly = term.replace(/\D/g, '');
        const last4 = digitsOnly.length >= 4 ? digitsOnly.slice(-4) : null;
        conditions.push(
          `(
            l.name ILIKE $${paramIdx}
            ${last4 ? `OR e.user_id LIKE '%' || $${paramIdx + 1}` : ''}
          )`,
        );
        params.push(`%${term}%`);
        paramIdx++;
        if (last4) {
          params.push(last4);
          paramIdx++;
        }
      }

      const whereSql = conditions.join(' AND ');
      const countSql = `SELECT COUNT(*) AS n FROM enrollments e LEFT JOIN learners l ON l.user_id = e.user_id WHERE ${whereSql}`;
      const countRows = await query<{ n: string }>(db, countSql, params);
      const total = Number(countRows.rows[0]?.n ?? 0);

      const dataSql = `
        SELECT e.id, e.user_id, e.course_id, e.status, e.last_delivered_position,
               e.started_at, e.updated_at, e.completed_at,
               c.title AS course_title,
               l.name AS learner_name,
               CASE WHEN oo.user_id IS NOT NULL THEN true ELSE false END AS opted_out
        FROM enrollments e
        JOIN courses c ON c.id = e.course_id
        LEFT JOIN learners l ON l.user_id = e.user_id
        LEFT JOIN opt_outs oo ON oo.user_id = e.user_id
        WHERE ${whereSql}
        ORDER BY ${q.sort === 'name' ? 'l.name' : 'e.updated_at'} DESC, e.id DESC
        LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
      `;
      params.push(q.pageSize, offset);
      const dataRows = await query<Record<string, unknown>>(db, dataSql, params);

      res.json({
        learners: dataRows.rows.map((r) => ({
          id: Number(r['id']),
          name: String(r['learner_name'] ?? ''),
          phone: maskPhone(String(r['user_id'])),
          course: String(r['course_title']),
          progress: Number(r['last_delivered_position']),
          status: String(r['status']),
          optedOut: Boolean(r['opted_out']),
        })),
        page: q.page,
        pageSize: q.pageSize,
        total,
      });
    }) satisfies RequestHandler,

    getLearner: (async (req, res) => {
      if (!enrollments || !learners || !optOuts) throw new NotFoundError();
      const eId = idParam(req, 'id');
      const org = orgId(req);
      // Verify enrollment belongs to this org
      const enr = await query<{ id: number; user_id: string }>(
        db,
        'SELECT id, user_id FROM enrollments WHERE id = $1 AND org_id = $2',
        [eId, org],
      );
      const row = enr.rows[0];
      if (!row) throw new NotFoundError('Learner not found');

      // Instructors can inspect progress but never receive the unmasked phone.
      const phone = String(row['user_id']);
      const role = principal(req).role;

      // All enrollments for this user in this org
      const allEnr = await query<Record<string, unknown>>(
        db,
        `SELECT e.id, e.course_id, c.title AS course_title, e.status, e.last_delivered_position,
                  e.started_at, e.updated_at, e.completed_at
         FROM enrollments e JOIN courses c ON c.id = e.course_id
         WHERE e.user_id = $1 AND e.org_id = $2
         ORDER BY e.updated_at DESC, e.id DESC`,
        [String(row['user_id']), org],
      );

      const name = await learners.getName(String(row['user_id']));
      const optedOut = await optOuts.isOptedOut(String(row['user_id']));

      res.json({
        id: eId,
        phone: role === 'instructor' ? maskPhone(phone) : phone,
        name,
        optedOut,
        enrollments: allEnr.rows.map((r) => ({
          id: Number(r['id']),
          courseId: Number(r['course_id']),
          courseTitle: String(r['course_title']),
          status: String(r['status']),
          progress: Number(r['last_delivered_position']),
          startedAt: iso(r['started_at'] as string | Date),
          updatedAt: iso(r['updated_at'] as string | Date),
          completedAt: r['completed_at'] == null ? null : iso(r['completed_at'] as string | Date),
        })),
      });
    }) satisfies RequestHandler,

    // ---- Enrollments (readable by instructors; management remains admin-only) -----------

    listEnrollments: (async (req, res) => {
      if (!enrollments) throw new NotFoundError();
      const q = parseBody(enrollmentQuerySchema, req.query);
      const org = orgId(req);
      const offset = (q.page - 1) * q.pageSize;

      const conditions: string[] = ['e.org_id = $1'];
      const params: unknown[] = [org];
      let paramIdx = 2;

      if (q.courseId !== undefined) {
        conditions.push(`e.course_id = $${paramIdx}`);
        params.push(q.courseId);
        paramIdx++;
      }
      if (q.status !== undefined) {
        conditions.push(`e.status = $${paramIdx}`);
        params.push(q.status);
        paramIdx++;
      }

      const whereSql = conditions.join(' AND ');
      const countRows = await query<{ n: string }>(
        db,
        `SELECT COUNT(*) AS n FROM enrollments e WHERE ${whereSql}`,
        params,
      );
      const total = Number(countRows.rows[0]?.n ?? 0);

      const dataRows = await query<Record<string, unknown>>(
        db,
        `SELECT e.id, e.user_id, e.course_id, c.title AS course_title, e.status,
                  e.last_delivered_position, e.started_at, e.updated_at, e.completed_at
         FROM enrollments e JOIN courses c ON c.id = e.course_id
         WHERE ${whereSql}
         ORDER BY e.updated_at DESC, e.id DESC
         LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
        [...params, q.pageSize, offset],
      );

      res.json({
        enrollments: dataRows.rows.map((r) => ({
          id: Number(r['id']),
          userId: maskPhone(String(r['user_id'])),
          courseId: Number(r['course_id']),
          courseTitle: String(r['course_title']),
          status: String(r['status']),
          progress: Number(r['last_delivered_position']),
          startedAt: iso(r['started_at'] as string | Date),
          updatedAt: iso(r['updated_at'] as string | Date),
          completedAt: r['completed_at'] == null ? null : iso(r['completed_at'] as string | Date),
        })),
        page: q.page,
        pageSize: q.pageSize,
        total,
      });
    }) satisfies RequestHandler,

    createEnrollment: (async (req, res) => {
      if (!enrollments || !optOuts) throw new NotFoundError();
      const body = parseBody(consentSchema, req.body);
      const org = orgId(req);
      // Verify course exists in this org
      const course = await courses.getCourse(org, body.courseId);
      if (!course) throw new NotFoundError('Course not found');

      // Check for existing enrollment in this course
      const existing = await enrollments.find(org, body.phone, body.courseId);
      if (existing) {
        res.json({ enrollment: existing, created: false });
        return;
      }
      // One active course per org
      const active = await enrollments.findActive(org, body.phone);
      if (active) {
        throw new ConflictError('Learner already has an active course in this organisation');
      }

      const created = await enrollments.createPending(org, body.phone, body.courseId);
      await enrollments.recordConsent(org, created.id, principal(req).userId);
      // Re-fetch so the response reflects the durably-written consent fields.
      const enrolled = await enrollments.findById(org, created.id);
      await audit(
        req,
        'enrollment.create',
        `enrollment:${created.id} phone:***${body.phone.slice(-4)} consent:true`,
      );
      res.status(201).json({ enrollment: enrolled ?? created, created: true });
    }) satisfies RequestHandler,

    pauseEnrollment: (async (req, res) => {
      if (!enrollments) throw new NotFoundError();
      const eId = idParam(req, 'id');
      const org = orgId(req);
      // Verify enrollment belongs to this org
      const owned = await query<{ one: number }>(
        db,
        'SELECT 1 AS one FROM enrollments WHERE id = $1 AND org_id = $2',
        [eId, org],
      );
      if (owned.rows.length === 0) throw new NotFoundError('Enrollment not found');

      const ok = await enrollments.pause(org, eId);
      if (!ok) {
        // Check why: already paused, completed, or opted out
        const row = await query<{ status: string; user_id: string }>(
          db,
          'SELECT status, user_id FROM enrollments WHERE id = $1 AND org_id = $2',
          [eId, org],
        );
        const r = row.rows[0];
        if (!r) throw new NotFoundError('Enrollment not found');
        if (r.status === 'completed') throw new ConflictError('Cannot pause a completed enrollment');
        if (r.status === 'paused') throw new ConflictError('Enrollment is already paused');
        const optedOut = optOuts ? await optOuts.isOptedOut(r.user_id) : false;
        if (optedOut) throw new ConflictError('Cannot pause an opted-out learner');
        throw new ConflictError('Cannot pause enrollment');
      }
      await audit(req, 'enrollment.pause', `enrollment:${eId}`);
      res.json({ ok: true, status: 'paused' });
    }) satisfies RequestHandler,

    resumeEnrollment: (async (req, res) => {
      if (!enrollments) throw new NotFoundError();
      const eId = idParam(req, 'id');
      const org = orgId(req);
      // Verify enrollment belongs to this org
      const owned = await query<{ one: number }>(
        db,
        'SELECT 1 AS one FROM enrollments WHERE id = $1 AND org_id = $2',
        [eId, org],
      );
      if (owned.rows.length === 0) throw new NotFoundError('Enrollment not found');

      const ok = await enrollments.resume(org, eId);
      if (!ok) {
        const row = await query<{ status: string }>(
          db,
          'SELECT status FROM enrollments WHERE id = $1 AND org_id = $2',
          [eId, org],
        );
        const r = row.rows[0];
        if (!r) throw new NotFoundError('Enrollment not found');
        if (r.status === 'completed') throw new ConflictError('Cannot resume a completed enrollment');
        if (r.status === 'active') throw new ConflictError('Enrollment is already active');
        throw new ConflictError('Cannot resume enrollment');
      }
      await audit(req, 'enrollment.resume', `enrollment:${eId}`);
      res.json({ ok: true, status: 'active' });
    }) satisfies RequestHandler,

    // ---- Delivery (org_admin + platform_admin) ------------------------------------------

    listDelivery: (async (req, res) => {
      if (!outbound) throw new NotFoundError();
      const q = parseBody(deliveryQuerySchema, req.query);
      const org = orgId(req);
      const offset = (q.page - 1) * q.pageSize;

      const conditions: string[] = ['om.org_id = $1'];
      const params: unknown[] = [org];
      let paramIdx = 2;

      if (q.status !== undefined) {
        conditions.push(`om.status = $${paramIdx}`);
        params.push(q.status);
        paramIdx++;
      }
      if (q.courseId !== undefined) {
        conditions.push(`om.course_id = $${paramIdx}`);
        params.push(q.courseId);
        paramIdx++;
      }
      if (q.learnerId !== undefined) {
        conditions.push(`om.enrollment_id = $${paramIdx}`);
        params.push(q.learnerId);
        paramIdx++;
      }

      const whereSql = conditions.join(' AND ');
      const countRows = await query<{ n: string }>(
        db,
        `SELECT COUNT(*) AS n FROM outbound_messages om WHERE ${whereSql}`,
        params,
      );
      const total = Number(countRows.rows[0]?.n ?? 0);

      const dataRows = await query<Record<string, unknown>>(
        db,
        `SELECT om.id, om.status, om.kind, om.twilio_sid, om.attempts,
                  om.created_at, om.updated_at, om.next_retry_at,
                  om.enrollment_id, om.user_id
         FROM outbound_messages om
         WHERE ${whereSql}
         ORDER BY om.created_at DESC, om.id DESC
         LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
        [...params, q.pageSize, offset],
      );

      res.json({
        messages: dataRows.rows.map((r) => ({
          id: Number(r['id']),
          status: String(r['status']),
          kind: String(r['kind']),
          providerMessageId: r['twilio_sid'] ?? null,
          attempts: Number(r['attempts']),
          createdAt: iso(r['created_at'] as string | Date),
          updatedAt: iso(r['updated_at'] as string | Date),
          nextRetryAt: r['next_retry_at'] == null ? null : iso(r['next_retry_at'] as string | Date),
          learnerId: r['enrollment_id'] == null ? null : Number(r['enrollment_id']),
        })),
        page: q.page,
        pageSize: q.pageSize,
        total,
      });
    }) satisfies RequestHandler,

    getDelivery: (async (req, res) => {
      if (!outbound) throw new NotFoundError();
      const msgId = idParam(req, 'id');
      const org = orgId(req);
      const p = principal(req);
      const canSeeText = p.role === 'org_admin' || p.role === 'platform_admin';

      const row = await query<Record<string, unknown>>(
        db,
        'SELECT * FROM outbound_messages WHERE id = $1 AND org_id = $2',
        [msgId, org],
      );
      const message = row.rows[0];
      if (!message) throw new NotFoundError('Message not found');

      const attempts = await outbound.listAttempts(msgId);

      const result: Record<string, unknown> = {
        id: Number(message.id),
        status: String(message.status),
        kind: String(message.kind),
        providerMessageId: message.twilio_sid ?? null,
        attemptCount: Number(message.attempts),
        createdAt: iso(message.created_at as string | Date),
        updatedAt: iso(message.updated_at as string | Date),
        learnerId: message.enrollment_id == null ? null : Number(message.enrollment_id),
        attempts: attempts.map((a) => ({
          attemptNo: Number(a.attemptNo),
          status: String(a.status),
          providerMessageId: a.twilioSid ?? null,
          errorCode: a.errorCode ?? null,
        })),
      };

      if (canSeeText) {
        result.messages = message.messages;
      } else {
        result.messages = undefined;
      }

      res.json(result);
    }) satisfies RequestHandler,

    // ---- Certificates (org_admin + platform_admin) --------------------------------------

    listCertificates: (async (req, res) => {
      if (!certificates || !enrollments) throw new NotFoundError();
      const org = orgId(req);
      const q = parseBody(enrollmentQuerySchema, req.query);
      const offset = (q.page - 1) * q.pageSize;

      const conditions: string[] = ['e.org_id = $1'];
      const params: unknown[] = [org];
      let paramIdx = 2;

      if (q.courseId !== undefined) {
        conditions.push(`e.course_id = $${paramIdx}`);
        params.push(q.courseId);
        paramIdx++;
      }
      if (q.status !== undefined) {
        conditions.push(`e.status = $${paramIdx}`);
        params.push(q.status);
        paramIdx++;
      }

      const whereSql = conditions.join(' AND ');
      const countRows = await query<{ n: string }>(
        db,
        `SELECT COUNT(*) AS n FROM certificates cert JOIN enrollments e ON e.id = cert.enrollment_id WHERE ${whereSql}`,
        params,
      );
      const total = Number(countRows.rows[0]?.n ?? 0);

      const dataRows = await query<Record<string, unknown>>(
        db,
        `SELECT cert.id, cert.code, cert.learner_name, cert.course_title, cert.issued_at,
                  cert.enrollment_id, e.course_id
         FROM certificates cert
         JOIN enrollments e ON e.id = cert.enrollment_id
         WHERE ${whereSql}
         ORDER BY cert.issued_at DESC, cert.id DESC
         LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
        [...params, q.pageSize, offset],
      );

      res.json({
        certificates: dataRows.rows.map((r) => ({
          id: Number(r['id']),
          code: String(r['code']),
          learnerName: String(r['learner_name']),
          courseTitle: String(r['course_title']),
          issuedAt: iso(r['issued_at'] as string | Date),
          enrollmentId: Number(r['enrollment_id']),
        })),
        page: q.page,
        pageSize: q.pageSize,
        total,
      });
    }) satisfies RequestHandler,

    resendCertificate: (async (req, res) => {
      if (!certificates || !outbound || !learners) throw new NotFoundError();
      const eId = idParam(req, 'id');
      const org = orgId(req);

      const cert = await certificates.getByEnrollment(org, eId);
      if (!cert) throw new NotFoundError('Certificate not found');

      // Get enrollment details for the resend
      const enrRow = await query<{ user_id: string }>(
        db,
        'SELECT user_id FROM enrollments WHERE id = $1 AND org_id = $2',
        [eId, org],
      );
      const enr = enrRow.rows[0];
      if (!enr) throw new NotFoundError('Enrollment not found');

      const cooldownMs = Number(process.env.CERT_RESEND_COOLDOWN_MINUTES ?? 10) * 60 * 1000;

      // Cooldown check, outbound insert and cooldown mark commit atomically under a row lock:
      // if the insert fails the cooldown is not consumed. The idempotency key includes
      // resend_count so a post-cooldown resend creates a NEW outbound message (new send),
      // while a rapid double call inside the window is rejected with 409 before any insert.
      await transactional(db, async (tx) => {
        const row = await query<{ last_resent_at: Date | null; resend_count: number | null }>(
          tx,
          'SELECT last_resent_at, resend_count FROM certificates WHERE enrollment_id = $1 FOR UPDATE',
          [eId],
        );
        const last = row.rows[0]?.last_resent_at ?? null;
        if (last) {
          const elapsed = Date.now() - new Date(last).getTime();
          if (elapsed < cooldownMs) {
            const remaining = Math.ceil((cooldownMs - elapsed) / 1000 / 60);
            throw new ConflictError(
              `Certificate already resent recently. Try again in ${remaining} minute(s).`,
            );
          }
        }
        const resendCount = Number(row.rows[0]?.resend_count ?? 0);
        const idempotencyKey = `cert-resend:${eId}:${resendCount}`;
        await outbound.createInTransaction(tx, {
          idempotencyKey,
          orgId: org,
          userId: enr.user_id,
          enrollmentId: eId,
          courseId: null,
          kind: 'certificate',
          messages: [{ text: `Your certificate is ready: ${cert.code}` }],
        });
        await query(
          tx,
          'UPDATE certificates SET last_resent_at = now(), resend_count = resend_count + 1 WHERE enrollment_id = $1',
          [eId],
        );
      });

      // Re-fetch the message we just enqueued. resend_count was incremented by the
      // committed transaction, so the generation we used is (current - 1).
      const after = await query<{ resend_count: number }>(
        db,
        'SELECT resend_count FROM certificates WHERE enrollment_id = $1',
        [eId],
      );
      const idempotencyKey = `cert-resend:${eId}:${Number(after.rows[0]?.resend_count ?? 1) - 1}`;
      const message = await outbound.getByKey(idempotencyKey);
      if (!message) throw new Error('certificate resend failed');
      await audit(req, 'certificate.resend', `enrollment:${eId} message:${message.id}`);
      res.json({ ok: true, messageId: message.id });
    }) satisfies RequestHandler,

    // ---- Schedule preview (org_admin + platform_admin) ----------------------------------

    schedulePreview: (async (req, res) => {
      if (!schedules) throw new NotFoundError();
      const q = parseBody(schedulePreviewSchema, req.query);
      const org = orgId(req);
      const eId = q.enrollmentId;

      // Verify enrollment belongs to this org
      const owned = await schedules.ownsEnrollment(org, eId);
      if (!owned) throw new NotFoundError('Enrollment not found');

      const schedRow = await schedules.getEnrollmentSchedule(eId);
      if (!schedRow || (!schedRow.dailyTime && schedRow.slots.length === 0)) {
        res.json({ times: [], note: 'No schedule configured for this enrollment' });
        return;
      }

      // Get course_id from enrollment for effective schedule lookup.
      const enrRow = await query<{ course_id: number }>(
        db,
        'SELECT course_id FROM enrollments WHERE id = $1 AND org_id = $2',
        [eId, org],
      );
      const enr = enrRow.rows[0];
      if (!enr) throw new NotFoundError('Enrollment not found');
      const courseId = Number(enr.course_id);
      const effective2 = await schedules.effectiveSchedule(org, eId, courseId);

      const nowMs = Date.now();
      const times: Array<{ utc: string; local: string }> = [];
      const tz = effective2.sched.timezone;

      // Compute next N slot times starting from now
      const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        weekday: 'short',
      });
      const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

      let cursorMs = nowMs;
      let found = 0;
      const maxIterations = q.count * 10; // prevent infinite loop

      for (let i = 0; i < maxIterations && found < q.count; i++) {
        const wall = wallParts(cursorMs, tz);
        const candidates: Array<{ key: string; ms: number }> = [];

        if (effective2.sched.slots.length > 0) {
          const zoneDow = DOW[dtf.formatToParts(new Date(cursorMs)).find((p) => p.type === 'weekday')?.value ?? 'Sun'] ?? 0;
          for (const slot of effective2.sched.slots) {
            if (slot.dow !== zoneDow) continue;
            const [h, m] = slot.time.split(':').map(Number) as [number, number];
            const slotMs = zonedWallToUtcMs(wall.year, wall.month, wall.day, h, m, tz);
            if (slotMs > nowMs) {
              candidates.push({ key: `${wall.dateStr}T${slot.time}`, ms: slotMs });
            }
          }
        } else if (effective2.sched.dailyTime) {
          const [h, m] = effective2.sched.dailyTime.split(':').map(Number) as [number, number];
          const slotMs = zonedWallToUtcMs(wall.year, wall.month, wall.day, h, m, tz);
          if (slotMs > nowMs) {
            candidates.push({ key: `${wall.dateStr}T${effective2.sched.dailyTime}`, ms: slotMs });
          }
        }

        candidates.sort((a, b) => a.ms - b.ms);
        if (candidates.length > 0) {
          const next = candidates[0]!;
          const wallNext = wallParts(next.ms, tz);
          times.push({
            utc: new Date(next.ms).toISOString(),
            local: `${wallNext.dateStr}T${String(wallNext.hour).padStart(2, '0')}:${String(wallNext.minute).padStart(2, '0')}`,
          });
          found++;
          cursorMs = next.ms + 1;
        } else {
          // Move to next day
          cursorMs = Date.UTC(wall.year, wall.month - 1, wall.day) + 86_400_000;
        }
      }

      res.json({ times, timezone: tz });
    }) satisfies RequestHandler,
  };
}
