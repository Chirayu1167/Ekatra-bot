import express, { Router } from 'express';
import type { PgDb } from '../db/pg';
import { createAdminController } from '../controllers/admin.controller';
import { createFailuresController } from '../controllers/failures.controller';
import { createLearnerController } from '../controllers/learner.controller';
import {
  authenticateAdmin,
  requireRole,
  resolveOrgFromPrincipal,
} from '../middleware/adminAuth';
import type { AdminAuthService } from '../services/adminAuth.service';
import type { CourseService } from '../services/course.service';
import type { EnrollmentService } from '../services/enrollment.service';
import type { OrganisationsService } from '../services/organisations.service';
import type { SchedulerService } from '../services/scheduler.service';
import type { DeadLetterService } from '../services/deadLetters.service';
import type { InboundEventService } from '../services/inboundEvents.service';
import type { OutboundService } from '../services/outbound.service';
import type { LearnerService } from '../services/learner.service';
import type { OptOutService } from '../services/optout.service';
import type { CertificateService } from '../services/certificate.service';

export interface AdminRouterOptions {
  db: PgDb;
  courses: CourseService;
  orgs: OrganisationsService;
  auth: AdminAuthService;
  /** Learner-data services. Omit all four to leave the export/delete routes unmounted. */
  enrollments?: EnrollmentService;
  learners?: LearnerService;
  optOuts?: OptOutService;
  certificates?: CertificateService;
  /** Schedule store. Omit to leave the schedule routes unmounted (404, feature off). */
  schedules?: SchedulerService;
  /** Dead letters + replay. Omit to leave the failure routes unmounted (404, feature off). */
  deadLetters?: DeadLetterService;
  /** Durable inbound store + outbound pipeline for learner export/delete. */
  inbound?: InboundEventService;
  outbound?: OutboundService;
  /** Bootstrap platform_admin credential (ADMIN_API_KEY). Omit when keyless. */
  bootstrapKey?: string;
}

/**
 * Admin API. Every route requires authentication (per-user key or bootstrap key);
 * course routes additionally resolve the tenant org from the principal, and
 * management routes are role-gated. Cross-org access fails with 404 (never 403),
 * insufficient role with 403, bad credentials with 401.
 */
export function createAdminRouter({
  db,
  courses,
  orgs,
  auth,
  enrollments,
  learners,
  optOuts,
  certificates,
  schedules,
  deadLetters,
  inbound,
  outbound,
  bootstrapKey,
}: AdminRouterOptions): Router {
  const router = Router();
  const c = createAdminController({ db, courses, orgs, auth, schedules, enrollments, learners, optOuts, outbound, certificates });
  const manageUsers = requireRole('platform_admin', 'org_admin');

  router.use(
    authenticateAdmin(auth, bootstrapKey),
    express.json({ limit: '256kb' }),
    resolveOrgFromPrincipal(orgs),
  );

  // Courses & lessons: every admin role, tenant-scoped.
  router.get('/courses', c.listCourses);
  router.post('/courses', manageUsers, c.createCourse);
  router.get('/courses/:id', c.getCourse);
  router.patch('/courses/:id', manageUsers, c.updateCourse);
  router.delete('/courses/:id', manageUsers, c.deleteCourse);
  router.post('/courses/:id/publish', manageUsers, c.publishCourse);
  router.post('/courses/:id/unpublish', manageUsers, c.unpublishCourse);

  router.post('/courses/:id/lessons', manageUsers, c.addLesson);
  router.put('/courses/:id/lessons/:lessonId', manageUsers, c.updateLesson);
  router.delete('/courses/:id/lessons/:lessonId', manageUsers, c.deleteLesson);

  // Course schedules are operational controls, not course authoring.
  // tenant-scoped. Mounted only when the schedule store is configured.
  if (schedules) {
    router.get('/courses/:id/schedule', manageUsers, c.getCourseSchedule);
    router.put('/courses/:id/schedule', manageUsers, c.setCourseSchedule);
    router.delete('/courses/:id/schedule', manageUsers, c.deleteCourseSchedule);
  }

  // Organisations: platform_admin only.
  router.get('/orgs', requireRole('platform_admin'), c.listOrgs);
  router.post('/orgs', requireRole('platform_admin'), c.createOrg);

  // Users & keys: platform_admin + org_admin (org_admin pinned to own org inside).
  const readLearners = requireRole('platform_admin', 'org_admin', 'instructor');
  router.get('/users', manageUsers, c.listUsers);
  router.post('/users', manageUsers, c.createUser);
  router.post('/users/:id/keys', manageUsers, c.rotateUserKey);
  router.delete('/users/:id/keys/:keyId', manageUsers, c.revokeUserKey);

  // Recovery (lost org_admin key): platform_admin only; revokes all live keys first.
  router.post('/users/:id/recover', requireRole('platform_admin'), c.recoverUserKey);

  // Audit log: platform_admin (all or ?org=) + org_admin (own org).
  router.get('/audit', requireRole('platform_admin', 'org_admin'), c.listAudit);

  // ---- Session (any authenticated admin) ----------------------------------------------

  router.get('/session', c.getSession);

  // ---- Learners: read for instructors; management remains org_admin/platform_admin -----

  if (enrollments && learners && optOuts) {
    router.get('/learners', readLearners, c.listLearners);
    router.get('/learners/:id', readLearners, c.getLearner);
  }

  // ---- Enrollments: read for instructors; management remains org_admin/platform_admin -

  if (enrollments) {
    router.get('/enrollments', readLearners, c.listEnrollments);
    router.post('/enrollments', manageUsers, c.createEnrollment);
    router.post('/enrollments/:id/pause', manageUsers, c.pauseEnrollment);
    router.post('/enrollments/:id/resume', manageUsers, c.resumeEnrollment);
  }

  // ---- Delivery (org_admin + platform_admin) ------------------------------------------

  if (outbound) {
    router.get('/delivery', manageUsers, c.listDelivery);
    router.get('/delivery/:id', manageUsers, c.getDelivery);
  }

  // ---- Certificates (org_admin + platform_admin) --------------------------------------

  if (certificates) {
    router.get('/certificates', manageUsers, c.listCertificates);
    router.post('/certificates/:id/resend', manageUsers, c.resendCertificate);
  }

  // ---- Schedule preview (org_admin + platform_admin) ----------------------------------

  if (schedules) {
    router.get('/schedule-preview', manageUsers, c.schedulePreview);
  }

  // Enrollment schedules + org delivery defaults (Phase 3): platform_admin +
  // org_admin, org-scoped, audited. Mounted only when configured.
  if (schedules) {
    router.get('/enrollments/:id/schedule', manageUsers, c.getEnrollmentSchedule);
    router.put('/enrollments/:id/schedule', manageUsers, c.setEnrollmentSchedule);
    router.get('/schedule-defaults', manageUsers, c.getScheduleDefaults);
    router.put('/schedule-defaults', manageUsers, c.setScheduleDefaults);
  }

  // Dead letters + controlled replay (Phase 3): platform_admin + org_admin,
  // org-scoped, audited. Mounted only when configured.
  if (deadLetters) {
    const fc = createFailuresController({ deadLetters, auth });
    router.get('/failures', manageUsers, fc.listFailures);
    router.get('/failures/:id', manageUsers, fc.getFailure);
    router.post('/failures/:id/replay', manageUsers, fc.replayFailure);
    router.post('/failures/:id/discard', manageUsers, fc.discardFailure);
  }

  // Learner data: platform_admin + org_admin, scoped to the caller's org, audited.
  // Mounted only when all learner services plus the durable stores are configured (else 404).
  if (enrollments && learners && optOuts && certificates && inbound && outbound) {
    const lc = createLearnerController({
      auth,
      enrollments,
      learners,
      optOuts,
      certificates,
      inbound,
      outbound,
    });
    router.get(
      '/learners/:phone/export',
      requireRole('platform_admin', 'org_admin'),
      lc.exportLearner,
    );
    router.delete(
      '/learners/:phone',
      requireRole('platform_admin', 'org_admin'),
      lc.deleteLearner,
    );
  }

  return router;
}
