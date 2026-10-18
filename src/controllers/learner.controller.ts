import type { Request, RequestHandler } from 'express';
import { BadRequestError, NotFoundError } from '../errors';
import type { AdminAuthService } from '../services/adminAuth.service';
import type { CertificateService } from '../services/certificate.service';
import type { EnrollmentService } from '../services/enrollment.service';
import type { InboundEventService } from '../services/inboundEvents.service';
import type { LearnerService } from '../services/learner.service';
import type { OptOutService } from '../services/optout.service';
import type { OutboundService } from '../services/outbound.service';
import { makeAuditor, orgId } from './admin.controller';

export interface LearnerControllerDeps {
  auth: AdminAuthService;
  enrollments: EnrollmentService;
  learners: LearnerService;
  optOuts: OptOutService;
  certificates: CertificateService;
  inbound: InboundEventService;
  outbound: OutboundService;
}

const PHONE_PARAM = /^whatsapp:\+\d{7,15}$/;

function phoneParam(req: Request): string {
  const raw = req.params['phone'];
  if (typeof raw !== 'string' || !PHONE_PARAM.test(raw)) {
    throw new BadRequestError('Invalid phone number');
  }
  return raw;
}

/**
 * Learner data export & deletion (platform_admin + org_admin, enforced by route middleware).
 * Scoped to the caller's org, audit-logged, phones in audit targets only (never keys).
 */
export function createLearnerController({
  auth,
  enrollments,
  learners,
  optOuts,
  certificates,
  inbound,
  outbound,
}: LearnerControllerDeps) {
  const audit = makeAuditor(auth);

  return {
    exportLearner: (async (req, res) => {
      const scope = orgId(req);
      const phone = phoneParam(req);
      const rows = await enrollments.listForUser(scope, phone, 100);
      if (rows.length === 0) throw new NotFoundError('Learner not found');
      const [name, consentedAt, optedOut] = await Promise.all([
        learners.getName(phone),
        learners.consentedAt(phone),
        optOuts.isOptedOut(phone),
      ]);
      const certs: unknown[] = [];
      for (const e of rows) {
        const cert = await certificates.getByEnrollment(scope, e.id);
        if (cert) certs.push({ ...cert, enrollmentId: e.id });
      }
      const [inboundEvents, outboundMessages] = await Promise.all([
        inbound.listByUser(phone, scope),
        outbound.listByUser(phone, scope),
      ]);
      await audit(req, 'learner.export', `learner:${phone}`);
      res.json({
        learner: { phone, name, consentedAt },
        organisation: { id: scope },
        optOut: { optedOut },
        enrollments: rows.map((e) => ({
          id: e.id,
          courseId: e.courseId,
          courseTitle: e.courseTitle,
          status: e.status,
          consentAt: e.consentAt,
          consentSource: e.consentSource,
          consentAdminId: e.consentAdminId,
          lastDeliveredPosition: e.lastDeliveredPosition,
          lessonCount: e.lessonCount,
          startedAt: e.startedAt,
          updatedAt: e.updatedAt,
          completedAt: e.completedAt,
        })),
        certificates: certs,
        // `storedMessages` is kept for backward compatibility; the durable message history is
        // reported under `messages` (inbound) and `delivery` (outbound) below.
        storedMessages: [],
        messages: inboundEvents.map((ev) => ({
          id: ev.id,
          direction: 'inbound',
          body: ev.body,
          status: ev.status,
        })),
        delivery: outboundMessages.map((m) => ({
          id: m.id,
          kind: m.kind,
          status: m.status,
          lessonPosition: m.lessonPosition,
          attempts: m.attempts,
          twilioSid: m.twilioSid,
        })),
      });
    }) satisfies RequestHandler,

    deleteLearner: (async (req, res) => {
      const scope = orgId(req);
      const phone = phoneParam(req);
      const rows = await enrollments.listForUser(scope, phone, 100);
      if (rows.length === 0) throw new NotFoundError('Learner not found');
      const otherOrgEnrollments = await enrollments.countEnrollmentsOutsideOrg(scope, phone);
      const optedOut = otherOrgEnrollments === 0 && (await optOuts.isOptedOut(phone));
      let certificatesDeleted = 0;
      for (const e of rows) {
        if (await certificates.deleteForEnrollment(scope, e.id)) certificatesDeleted += 1;
      }
      const deletedEnrollments = await enrollments.deleteUserEnrollments(scope, phone);
      let profileDeleted = false;
      if (otherOrgEnrollments === 0) {
        // The block must survive deletion: keep it as a hash, drop the raw number.
        if (optedOut) await optOuts.forgetPhone(phone);
        await learners.anonymiseForDeletion(phone);
        profileDeleted = await learners.remove(phone);
      } else {
        // Preserve other organisations' profile, consent and delivery history.
        await learners.anonymiseForOrgDeletion(phone, scope);
      }
      await audit(
        req,
        'learner.delete',
        `learner:${phone} enrollments:${deletedEnrollments.length} certificates:${certificatesDeleted}`,
      );
      res.json({
        deleted: true,
        enrollments: deletedEnrollments.length,
        certificates: certificatesDeleted,
        profileDeleted,
        optOutRetained: await optOuts.isOptedOut(phone),
      });
    }) satisfies RequestHandler,
  };
}
