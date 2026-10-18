import request from 'supertest';
import { describe, expect, it } from 'vitest';
/* eslint-disable @typescript-eslint/no-unused-vars */
import type { Express } from 'express';
import type { PgDb } from '../src/db/pg';
import { createApp } from '../src/app';
import { silentLogger } from '../src/logger';
import { query } from '../src/db/pg';
import { maskPhone } from '../src/logger';
import { CourseService } from '../src/services/course.service';
import { EnrollmentService } from '../src/services/enrollment.service';
import { OrganisationsService } from '../src/services/organisations.service';
import { AdminAuthService } from '../src/services/adminAuth.service';
import { LearnerService } from '../src/services/learner.service';
import { OptOutService } from '../src/services/optout.service';
import { OutboundService } from '../src/services/outbound.service';
import { CertificateService } from '../src/services/certificate.service';
import { SchedulerService } from '../src/services/scheduler.service';
import { InboundEventService } from '../src/services/inboundEvents.service';
import { JobService } from '../src/services/jobs.service';
import { DeadLetterService } from '../src/services/deadLetters.service';
import { pgFileContext, resetDb } from './pg.helpers';

const pgx = pgFileContext('admin-step1');

const BOOTSTRAP = 'test-bootstrap-key-0123456789abcdef';

/** Build an app with all admin services wired. */
async function setup() {
  await resetDb(pgx.pool);
  const db = pgx.pool;
  const orgs = new OrganisationsService(db);
  const courses = new CourseService(db);
  const enrollments = new EnrollmentService(db);
  const learners = new LearnerService(db);
  const optOuts = new OptOutService(db);
  const outbound = new OutboundService(db);
  const certificates = new CertificateService(db, learners, 'test-secret-test-secret');
  const inbound = new InboundEventService(db);
  const jobs = new JobService(db);
  const deadLetters = new DeadLetterService(db, outbound, jobs, optOuts, enrollments, courses);
  const auth = new AdminAuthService(db);
  const schedules = new SchedulerService(db);
  const app = createApp({
    env: {
      TWILIO_AUTH_TOKEN: 'test_auth_token',
      TWILIO_WEBHOOK_VALIDATE: false,
      PUBLIC_BASE_URL: 'https://example.test',
    },
    db,
    inbound,
    jobs,
    statusCallback: {
      reconcile: { db, outbound, enrollments, certificates },
      logger: silentLogger,
    },
    logger: silentLogger,
    admin: {
      db, courses, orgs, auth, enrollments, learners, optOuts, certificates, schedules, deadLetters,
      inbound, outbound, bootstrapKey: BOOTSTRAP,
    },
  });
  return { db, app, orgs, courses, enrollments, learners, optOuts, outbound, certificates, auth, schedules };
}

/** Create an org and return its slug + id. */
async function mkOrg(app: Express, slug: string, name: string, key: string) {
  const res = await request(app)
    .post('/admin/orgs')
    .set('Authorization', `Bearer ${key}`)
    .send({ slug, name });
  expect(res.status).toBe(201);
  const { rows } = await query<{ id: number }>(pgx.pool, 'SELECT id FROM organisations WHERE slug = $1', [slug]);
  return { slug, id: rows[0]!.id };
}

/** Create a user in an org with a role, return the apiKey. */
async function mkUser(app: Express, orgId: number | null, name: string, role: string, key: string, orgSlug?: string) {
  const res = await request(app)
    .post('/admin/users')
    .set('Authorization', `Bearer ${key}`)
    .send(orgSlug ? { org: orgSlug, name, role } : { name, role });
  expect(res.status).toBe(201);
  return res.body.apiKey as string;
}

/** Create a published course in an org, return its id. */
async function mkCourse(app: Express, orgId: number, title: string, key: string) {
  const res = await request(app)
    .post('/admin/courses')
    .set('Authorization', `Bearer ${key}`)
    .send({ title, description: 'd', lessons: [{ title: 'L1', items: [{ kind: 'text', text: 'hi' }] }] });
  expect(res.status).toBe(201);
  const id = res.body.course.id as number;
  await request(app)
    .post(`/admin/courses/${id}/publish`)
    .set('Authorization', `Bearer ${key}`);
  return id;
}

/** Create an enrollment, return its id (opaque learner id). Requires a valid course_id. */
async function mkEnrollment(db: PgDb, orgId: number, userId: string, courseId: number, status = 'active') {
  const { rows } = await query<{ id: number }>(
    db,
    'INSERT INTO enrollments (org_id, user_id, course_id, status, last_delivered_position) VALUES ($1,$2,$3,$4,0) RETURNING id',
    [orgId, userId, courseId, status],
  );
  return rows[0]!.id;
}

/** Create an outbound message, return its id. Requires valid enrollment_id/course_id if set. */
async function mkOutbound(db: PgDb, orgId: number, userId: string, enrollmentId: number | null, courseId: number | null, kind = 'reply', status = 'sent', attempts = 1) {
  const { rows } = await query<{ id: number }>(
    db,
    `INSERT INTO outbound_messages (idempotency_key, org_id, user_id, enrollment_id, course_id, kind, messages, status, attempts, twilio_sid)
     VALUES ($1,$2,$3,$4,$5,$6,'[]',$7,$8,'SMtest') RETURNING id`,
    [`msg-${Date.now()}-${Math.random()}`, orgId, userId, enrollmentId, courseId, kind, status, attempts],
  );
  return rows[0]!.id;
}

/** Create an outbound attempt for a message. */
async function mkAttempt(db: PgDb, messageId: number, attemptNo: number, status = 'sent', sid = 'SMatt') {
  await query(
    db,
    'INSERT INTO outbound_attempts (message_id, attempt_no, twilio_sid, status) VALUES ($1,$2,$3,$4)',
    [messageId, attemptNo, sid, status],
  );
}

/** Create a certificate for a completed enrollment. */
async function mkCertificate(db: PgDb, enrollmentId: number, learnerName: string, courseTitle: string) {
  const code = `${enrollmentId}-abcd1234efgh5678`;
  await query(
    db,
    'INSERT INTO certificates (enrollment_id, code, learner_name, course_title) VALUES ($1,$2,$3,$4)',
    [enrollmentId, code, learnerName, courseTitle],
  );
}

describe('admin step 1 endpoints', () => {
  describe('GET /admin/session', () => {
    it('returns the authenticated principal info', async () => {
      const { app, orgs, auth } = await setup();
      const orgId = await orgs.getDefaultId();
      const user = await auth.createUser(orgId, 'Asha', 'org_admin');
      const key = (await auth.issueKey(user.id)).plaintext;
      const res = await request(app).get('/admin/session').set('Authorization', `Bearer ${key}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(user.id);
      expect(res.body.name).toBe('Asha');
      expect(res.body.role).toBe('org_admin');
      expect(res.body.orgId).toBe(orgId);
      expect(typeof res.body.orgSlug).toBe('string');
    });

    it('bootstrap key returns platform_admin session', async () => {
      const { app, orgs } = await setup();
      const orgId = await orgs.getDefaultId();
      const { rows } = await query<{ slug: string }>(pgx.pool, 'SELECT slug FROM organisations WHERE id = $1', [orgId]);
      const res = await request(app).get('/admin/session').set('Authorization', `Bearer ${BOOTSTRAP}`);
      expect(res.status).toBe(200);
      expect(res.body.role).toBe('platform_admin');
      expect(res.body.orgId).toBeNull();
      expect(res.body.orgSlug).toBeNull();
    });

    it('missing key returns 401', async () => {
      const { app } = await setup();
      expect((await request(app).get('/admin/session')).status).toBe(401);
    });

    it('invalid key returns 401', async () => {
      const { app } = await setup();
      expect((await request(app).get('/admin/session').set('Authorization', 'Bearer nope')).status).toBe(401);
    });
  });

  describe('GET /admin/learners', () => {
    it('lists learners with masked phones and progress', async () => {
      const { app, orgs, courses, enrollments, learners, auth } = await setup();
      const orgId = await orgs.getDefaultId();
      const key = await mkUser(app, orgId, 'Admin', 'org_admin', BOOTSTRAP);
      const courseId = await mkCourse(app, orgId, 'Alpha', key);
      await learners.upsert('whatsapp:+919876543210', 'Asha Rao');
      await learners.upsert('whatsapp:+919811122233', 'Beena Kumari');
      const e1 = await mkEnrollment(pgx.pool, orgId, 'whatsapp:+919876543210', courseId, 'active');
      const e2 = await mkEnrollment(pgx.pool, orgId, 'whatsapp:+919811122233', courseId, 'paused');

      const res = await request(app).get('/admin/learners').set('Authorization', `Bearer ${key}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.learners)).toBe(true);
      expect(res.body.learners.length).toBeGreaterThanOrEqual(2);
      for (const l of res.body.learners) {
        expect(typeof l.id).toBe('number'); // opaque id = enrollment id
        expect(typeof l.name).toBe('string');
        expect(l.phone).toMatch(/\*\*\*\d{4}$/); // masked
        expect(typeof l.course).toBe('string');
        expect(typeof l.progress).toBe('number');
        expect(['pending','active','paused','completed']).toContain(l.status);
        expect(typeof l.optedOut).toBe('boolean');
      }
    });

    it('masks phones in lists, never shows full phone', async () => {
      const { app, orgs, courses, learners, auth } = await setup();
      const orgId = await orgs.getDefaultId();
      const key = await mkUser(app, orgId, 'Admin', 'org_admin', BOOTSTRAP);
      const courseId = await mkCourse(app, orgId, 'Alpha', key);
      await learners.upsert('whatsapp:+919876543210', 'Asha Rao');
      await mkEnrollment(pgx.pool, orgId, 'whatsapp:+919876543210', courseId, 'active');

      const res = await request(app).get('/admin/learners').set('Authorization', `Bearer ${key}`);
      expect(res.status).toBe(200);
      for (const l of res.body.learners) {
        expect(l.phone).not.toBe('whatsapp:+919876543210');
        expect(l.phone).toBe(maskPhone('whatsapp:+919876543210'));
      }
    });

    it('filters by courseId', async () => {
      const { app, orgs, courses, learners, auth } = await setup();
      const orgId = await orgs.getDefaultId();
      const key = await mkUser(app, orgId, 'Admin', 'org_admin', BOOTSTRAP);
      const c1 = await mkCourse(app, orgId, 'Alpha', key);
      const c2 = await mkCourse(app, orgId, 'Beta', key);
      await learners.upsert('whatsapp:+919876543210', 'Asha Rao');
      await learners.upsert('whatsapp:+919811122233', 'Beena Kumari');
      await mkEnrollment(pgx.pool, orgId, 'whatsapp:+919876543210', c1, 'active');
      await mkEnrollment(pgx.pool, orgId, 'whatsapp:+919811122233', c2, 'active');

      const res = await request(app).get(`/admin/learners?courseId=${c1}`).set('Authorization', `Bearer ${key}`);
      expect(res.status).toBe(200);
      for (const l of res.body.learners) {
        expect(l.course).toContain('Alpha');
      }
    });

    it('filters by status', async () => {
      const { app, orgs, courses, learners, auth } = await setup();
      const orgId = await orgs.getDefaultId();
      const key = await mkUser(app, orgId, 'Admin', 'org_admin', BOOTSTRAP);
      const courseId = await mkCourse(app, orgId, 'Alpha', key);
      await learners.upsert('whatsapp:+919876543210', 'Asha Rao');
      await mkEnrollment(pgx.pool, orgId, 'whatsapp:+919876543210', courseId, 'paused');

      const res = await request(app).get('/admin/learners?status=paused').set('Authorization', `Bearer ${key}`);
      expect(res.status).toBe(200);
      for (const l of res.body.learners) {
        expect(l.status).toBe('paused');
      }
    });

    it('searches by name or last 4 digits', async () => {
      const { app, orgs, courses, learners, auth } = await setup();
      const orgId = await orgs.getDefaultId();
      const key = await mkUser(app, orgId, 'Admin', 'org_admin', BOOTSTRAP);
      const courseId = await mkCourse(app, orgId, 'Alpha', key);
      await learners.upsert('whatsapp:+919876543210', 'Asha Rao');
      await mkEnrollment(pgx.pool, orgId, 'whatsapp:+919876543210', courseId, 'active');

      const res = await request(app).get('/admin/learners?search=Asha').set('Authorization', `Bearer ${key}`);
      expect(res.status).toBe(200);
      expect(res.body.learners.length).toBeGreaterThan(0);

      const res2 = await request(app).get('/admin/learners?search=3210').set('Authorization', `Bearer ${key}`);
      expect(res2.status).toBe(200);
      expect(res2.body.learners.length).toBeGreaterThan(0);
    });

    it('cross-org: org A cannot see org B learners (404)', async () => {
      const { app, orgs, courses, learners, auth } = await setup();
      const orgA = await mkOrg(app, 'acme', 'Acme', BOOTSTRAP);
      const orgB = await mkOrg(app, 'other', 'Other', BOOTSTRAP);
      const keyA = await mkUser(app, orgA.id, 'AdminA', 'org_admin', BOOTSTRAP, 'acme');
      const cId = await mkCourse(app, orgA.id, 'Alpha', keyA);
      await learners.upsert('whatsapp:+919876543210', 'Asha Rao');
      await mkEnrollment(pgx.pool, orgA.id, 'whatsapp:+919876543210', cId, 'active');

      const res = await request(app).get('/admin/learners?org=other').set('Authorization', `Bearer ${keyA}`);
      expect(res.status).toBe(404);
    });

    it('instructor can list own-org learners with masked phone numbers', async () => {
      const { app, orgs, courses, learners, auth } = await setup();
      const orgId = await orgs.getDefaultId();
      const key = await mkUser(app, orgId, 'Ins', 'instructor', BOOTSTRAP);
      const courseKey = await mkUser(app, orgId, 'Course admin', 'org_admin', BOOTSTRAP);
      const courseId = await mkCourse(app, orgId, 'Alpha', courseKey);
      await learners.upsert('whatsapp:+919876543210', 'Asha Rao');
      await mkEnrollment(pgx.pool, orgId, 'whatsapp:+919876543210', courseId, 'active');

      const res = await request(app).get('/admin/learners').set('Authorization', `Bearer ${key}`);
      expect(res.status).toBe(200);
      expect(res.body.learners).toHaveLength(1);
      expect(res.body.learners[0].phone).toBe('whatsapp:+***3210');
      expect(JSON.stringify(res.body)).not.toContain('whatsapp:+919876543210');
    });
  });

  describe('GET /admin/learners/:id', () => {
    it('returns full phone and enrollments for the learner (detail view)', async () => {
      const { app, orgs, courses, learners, enrollments, auth } = await setup();
      const orgId = await orgs.getDefaultId();
      const key = await mkUser(app, orgId, 'Admin', 'org_admin', BOOTSTRAP);
      const courseId = await mkCourse(app, orgId, 'Alpha', key);
      await learners.upsert('whatsapp:+919876543210', 'Asha Rao');
      const eId = await mkEnrollment(pgx.pool, orgId, 'whatsapp:+919876543210', courseId, 'active');

      const res = await request(app).get(`/admin/learners/${eId}`).set('Authorization', `Bearer ${key}`);
      expect(res.status).toBe(200);
      expect(res.body.phone).toBe('whatsapp:+919876543210'); // full phone only in detail
      expect(res.body.name).toBe('Asha Rao');
      expect(Array.isArray(res.body.enrollments)).toBe(true);
    });

    it('cross-org: org A cannot see org B learner detail (404)', async () => {
      const { app, orgs, courses, learners, auth } = await setup();
      const orgA = await mkOrg(app, 'acme', 'Acme', BOOTSTRAP);
      const orgB = await mkOrg(app, 'other', 'Other', BOOTSTRAP);
      const keyA = await mkUser(app, orgA.id, 'AdminA', 'org_admin', BOOTSTRAP, 'acme');
      const cIdB = await mkCourse(app, orgB.id, 'Beta', BOOTSTRAP);
      await learners.upsert('whatsapp:+919876543210', 'Asha Rao');
      const eId = await mkEnrollment(pgx.pool, orgB.id, 'whatsapp:+919876543210', cIdB, 'active');

      const res = await request(app).get(`/admin/learners/${eId}`).set('Authorization', `Bearer ${keyA}`);
      expect(res.status).toBe(404);
    });

    it('404 for unknown enrollment id', async () => {
      const { app, orgs, auth } = await setup();
      const orgId = await orgs.getDefaultId();
      const key = await mkUser(app, orgId, 'Admin', 'org_admin', BOOTSTRAP);
      expect((await request(app).get('/admin/learners/999999').set('Authorization', `Bearer ${key}`)).status).toBe(404);
    });

    it('instructor gets learner detail with masked phone only', async () => {
      const { app, orgs, courses, learners, auth } = await setup();
      const orgId = await orgs.getDefaultId();
      const key = await mkUser(app, orgId, 'Ins', 'instructor', BOOTSTRAP);
      const courseKey = await mkUser(app, orgId, 'Course admin', 'org_admin', BOOTSTRAP);
      const cId = await mkCourse(app, orgId, 'Alpha', courseKey);
      await learners.upsert('whatsapp:+919876543210', 'Asha Rao');
      const eId = await mkEnrollment(pgx.pool, orgId, 'whatsapp:+919876543210', cId, 'active');
      const res = await request(app).get(`/admin/learners/${eId}`).set('Authorization', `Bearer ${key}`);
      expect(res.status).toBe(200);
      expect(res.body.phone).toBe('whatsapp:+***3210');
      expect(res.body.fullPhone).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain('whatsapp:+919876543210');
      expect(res.body.enrollments).toHaveLength(1);
    });

    it('instructor cannot read learner detail from another org (404)', async () => {
      const { app, learners } = await setup();
      const orgA = await mkOrg(app, 'acme', 'Acme', BOOTSTRAP);
      const orgB = await mkOrg(app, 'other', 'Other', BOOTSTRAP);
      const instructorKey = await mkUser(app, orgA.id, 'Ins', 'instructor', BOOTSTRAP, orgA.slug);
      const courseId = await mkCourse(app, orgB.id, 'Beta', BOOTSTRAP);
      await learners.upsert('whatsapp:+919876543210', 'Asha Rao');
      const eId = await mkEnrollment(pgx.pool, orgB.id, 'whatsapp:+919876543210', courseId, 'active');

      const res = await request(app).get(`/admin/learners/${eId}`).set('Authorization', `Bearer ${instructorKey}`);
      expect(res.status).toBe(404);
    });
  });

  describe('GET /admin/enrollments', () => {
    it('lists enrollments with filters', async () => {
      const { app, orgs, courses, enrollments, auth } = await setup();
      const orgId = await orgs.getDefaultId();
      const key = await mkUser(app, orgId, 'Admin', 'org_admin', BOOTSTRAP);
      const courseId = await mkCourse(app, orgId, 'Alpha', key);
      await mkEnrollment(pgx.pool, orgId, 'whatsapp:+919876543210', courseId, 'active');
      await mkEnrollment(pgx.pool, orgId, 'whatsapp:+919811122233', courseId, 'paused');

      const res = await request(app).get('/admin/enrollments').set('Authorization', `Bearer ${key}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.enrollments)).toBe(true);
      for (const e of res.body.enrollments) {
        expect(typeof e.id).toBe('number'); // opaque id
        expect(typeof e.userId).toBe('string'); // phone masked? enrollments store raw phone...
        expect(typeof e.courseId).toBe('number');
        expect(['pending','active','paused','completed']).toContain(e.status);
      }
    });

    it('filters by status', async () => {
      const { app, orgs, courses, auth } = await setup();
      const orgId = await orgs.getDefaultId();
      const key = await mkUser(app, orgId, 'Admin', 'org_admin', BOOTSTRAP);
      const cId = await mkCourse(app, orgId, 'Alpha', key);
      await mkEnrollment(pgx.pool, orgId, 'whatsapp:+919876543210', cId, 'paused');

      const res = await request(app).get('/admin/enrollments?status=paused').set('Authorization', `Bearer ${key}`);
      expect(res.status).toBe(200);
      for (const e of res.body.enrollments) {
        expect(e.status).toBe('paused');
      }
    });

    it('cross-org: 404 for other org enrollments', async () => {
      const { app, orgs, auth } = await setup();
      const orgA = await mkOrg(app, 'acme', 'Acme', BOOTSTRAP);
      const orgB = await mkOrg(app, 'other', 'Other', BOOTSTRAP);
      const keyA = await mkUser(app, orgA.id, 'AdminA', 'org_admin', BOOTSTRAP, 'acme');
      const cIdB = await mkCourse(app, orgB.id, 'Beta', BOOTSTRAP);
      await mkEnrollment(pgx.pool, orgB.id, 'whatsapp:+919876543210', cIdB, 'active');

      const res = await request(app).get('/admin/enrollments?org=other').set('Authorization', `Bearer ${keyA}`);
      expect(res.status).toBe(404);
    });

    it('instructor can list own-org enrollments with masked phone numbers', async () => {
      const { app, orgs, courses, learners, auth } = await setup();
      const orgId = await orgs.getDefaultId();
      const key = await mkUser(app, orgId, 'Ins', 'instructor', BOOTSTRAP);
      const courseKey = await mkUser(app, orgId, 'Course admin', 'org_admin', BOOTSTRAP);
      const courseId = await mkCourse(app, orgId, 'Alpha', courseKey);
      await learners.upsert('whatsapp:+919876543210', 'Asha Rao');
      await mkEnrollment(pgx.pool, orgId, 'whatsapp:+919876543210', courseId, 'active');

      const res = await request(app).get('/admin/enrollments').set('Authorization', `Bearer ${key}`);
      expect(res.status).toBe(200);
      expect(res.body.enrollments).toHaveLength(1);
      expect(res.body.enrollments[0].userId).toBe('whatsapp:+***3210');
      expect(JSON.stringify(res.body)).not.toContain('whatsapp:+919876543210');
    });
  });

  describe('POST /admin/enrollments', () => {
    it('creates a pending enrollment and durably records consent', async () => {
      const { app, orgs, courses, db } = await setup();
      const orgId = await orgs.getDefaultId();
      const key = await mkUser(app, orgId, 'Admin', 'org_admin', BOOTSTRAP);
      const courseId = await mkCourse(app, orgId, 'Alpha', key);

      const res = await request(app)
        .post('/admin/enrollments')
        .set('Authorization', `Bearer ${key}`)
        .send({ phone: 'whatsapp:+919876543210', courseId, consent: true });
      expect(res.status).toBe(201);
      expect(res.body.enrollment.status).toBe('pending');
      expect(res.body.enrollment.userId).toBe('whatsapp:+919876543210');
      expect(res.body.enrollment.consentSource).toBe('admin_attestation');
      expect(res.body.enrollment.consentAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
      expect(typeof res.body.enrollment.consentAdminId).toBe('number');

      // Durable consent record on the enrollment row (not only the prunable audit log).
      const row = await query<{ consent_at: Date | null; consent_source: string; consent_admin_id: number | null }>(
        db,
        'SELECT consent_at, consent_source, consent_admin_id FROM enrollments WHERE id = $1',
        [res.body.enrollment.id],
      );
      expect(row.rows[0]!.consent_source).toBe('admin_attestation');
      expect(typeof row.rows[0]!.consent_admin_id).toBe('number');
      expect((row.rows[0]!.consent_at as Date).toISOString()).toMatch(/\d{4}-\d{2}-\d{2}T/);

      // Audit entry records consent=true.
      const audits = await query<{ target: string }>(db, "SELECT target FROM audit_log WHERE action = 'enrollment.create'");
      expect(audits.rows.some((a) => a.target.includes('consent:true'))).toBe(true);
    });

    it('rejects consent=false or missing', async () => {
      const { app, orgs, courses, auth } = await setup();
      const orgId = await orgs.getDefaultId();
      const key = await mkUser(app, orgId, 'Admin', 'org_admin', BOOTSTRAP);
      const courseId = await mkCourse(app, orgId, 'Alpha', key);

      const res1 = await request(app)
        .post('/admin/enrollments')
        .set('Authorization', `Bearer ${key}`)
        .send({ phone: 'whatsapp:+919876543210', courseId, consent: false });
      expect(res1.status).toBe(400);

      const res2 = await request(app)
        .post('/admin/enrollments')
        .set('Authorization', `Bearer ${key}`)
        .send({ phone: 'whatsapp:+919876543210', courseId });
      expect(res2.status).toBe(400);
    });

    it('phone in body only, never in URL', async () => {
      const { app, orgs, courses, auth } = await setup();
      const orgId = await orgs.getDefaultId();
      const key = await mkUser(app, orgId, 'Admin', 'org_admin', BOOTSTRAP);
      const courseId = await mkCourse(app, orgId, 'Alpha', key);

      const res = await request(app)
        .post('/admin/enrollments')
        .set('Authorization', `Bearer ${key}`)
        .send({ phone: 'whatsapp:+919876543210', courseId, consent: true });
      expect(res.status).toBe(201);
    });

    it('cross-org: cannot create enrollment in other org', async () => {
      const { app, orgs, courses, auth } = await setup();
      const orgA = await mkOrg(app, 'acme', 'Acme', BOOTSTRAP);
      const orgB = await mkOrg(app, 'other', 'Other', BOOTSTRAP);
      const keyA = await mkUser(app, orgA.id, 'AdminA', 'org_admin', BOOTSTRAP, 'acme');
      const courseIdB = await mkCourse(app, orgB.id, 'Beta', BOOTSTRAP);

      const res = await request(app)
        .post('/admin/enrollments')
        .set('Authorization', `Bearer ${keyA}`)
        .send({ phone: 'whatsapp:+919876543210', courseId: courseIdB, consent: true });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /admin/enrollments/:id/pause and /resume', () => {
    it('pauses an active enrollment', async () => {
      const { app, orgs, courses, db, auth } = await setup();
      const orgId = await orgs.getDefaultId();
      const key = await mkUser(app, orgId, 'Admin', 'org_admin', BOOTSTRAP);
      const cId = await mkCourse(app, orgId, 'Alpha', key);
      const eId = await mkEnrollment(pgx.pool, orgId, 'whatsapp:+919876543210', cId, 'active');

      const res = await request(app)
        .post(`/admin/enrollments/${eId}/pause`)
        .set('Authorization', `Bearer ${key}`);
      expect(res.status).toBe(200);
      const row = await query<{ status: string }>(db, 'SELECT status FROM enrollments WHERE id = $1', [eId]);
      expect(row.rows[0]!.status).toBe('paused');
    });

    it('resumes a paused enrollment', async () => {
      const { app, orgs, courses, db, auth } = await setup();
      const orgId = await orgs.getDefaultId();
      const key = await mkUser(app, orgId, 'Admin', 'org_admin', BOOTSTRAP);
      const cId = await mkCourse(app, orgId, 'Alpha', key);
      const eId = await mkEnrollment(pgx.pool, orgId, 'whatsapp:+919876543210', cId, 'paused');

      const res = await request(app)
        .post(`/admin/enrollments/${eId}/resume`)
        .set('Authorization', `Bearer ${key}`);
      expect(res.status).toBe(200);
      const row = await query<{ status: string }>(db, 'SELECT status FROM enrollments WHERE id = $1', [eId]);
      expect(row.rows[0]!.status).toBe('active');
    });

    it('pausing an already-paused enrollment returns a clear error', async () => {
      const { app, orgs, courses, auth } = await setup();
      const orgId = await orgs.getDefaultId();
      const key = await mkUser(app, orgId, 'Admin', 'org_admin', BOOTSTRAP);
      const cId = await mkCourse(app, orgId, 'Alpha', key);
      const eId = await mkEnrollment(pgx.pool, orgId, 'whatsapp:+919876543210', cId, 'paused');

      const res = await request(app)
        .post(`/admin/enrollments/${eId}/pause`)
        .set('Authorization', `Bearer ${key}`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('conflict');
    });

    it('cross-org: 404 for other org enrollment pause', async () => {
      const { app, orgs, auth } = await setup();
      const orgA = await mkOrg(app, 'acme', 'Acme', BOOTSTRAP);
      const orgB = await mkOrg(app, 'other', 'Other', BOOTSTRAP);
      const keyA = await mkUser(app, orgA.id, 'AdminA', 'org_admin', BOOTSTRAP, 'acme');
      const cIdB = await mkCourse(app, orgB.id, 'Beta', BOOTSTRAP);
      const eId = await mkEnrollment(pgx.pool, orgB.id, 'whatsapp:+919876543210', cIdB, 'active');

      const res = await request(app)
        .post(`/admin/enrollments/${eId}/pause`)
        .set('Authorization', `Bearer ${keyA}`);
      expect(res.status).toBe(404);
    });

    it('instructor gets 403 on pause/resume', async () => {
      const { app, orgs, courses, auth } = await setup();
      const orgId = await orgs.getDefaultId();
      const key = await mkUser(app, orgId, 'Ins', 'instructor', BOOTSTRAP);
      const courseKey = await mkUser(app, orgId, 'Course admin', 'org_admin', BOOTSTRAP);
      const cId = await mkCourse(app, orgId, 'Alpha', courseKey);
      const eId = await mkEnrollment(pgx.pool, orgId, 'whatsapp:+919876543210', cId, 'active');
      expect((await request(app).post(`/admin/enrollments/${eId}/pause`).set('Authorization', `Bearer ${key}`)).status).toBe(403);
      expect((await request(app).post(`/admin/enrollments/${eId}/resume`).set('Authorization', `Bearer ${key}`)).status).toBe(403);
    });
  });

  describe('GET /admin/delivery', () => {
    it('lists outbound messages with metadata only, no message bodies', async () => {
      const { app, orgs, courses, outbound, auth } = await setup();
      const orgId = await orgs.getDefaultId();
      const key = await mkUser(app, orgId, 'Admin', 'org_admin', BOOTSTRAP);
      const cId = await mkCourse(app, orgId, 'Alpha', key);
      const eId = await mkEnrollment(pgx.pool, orgId, 'whatsapp:+919876543210', cId, 'active');
      const msgId = await mkOutbound(pgx.pool, orgId, 'whatsapp:+919876543210', eId, cId, 'reply', 'sent', 2);
      await mkAttempt(pgx.pool, msgId, 1);
      await mkAttempt(pgx.pool, msgId, 2);

      const res = await request(app).get('/admin/delivery').set('Authorization', `Bearer ${key}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.messages)).toBe(true);
      for (const m of res.body.messages) {
        expect(typeof m.id).toBe('number');
        expect(typeof m.status).toBe('string');
        expect(typeof m.kind).toBe('string');
        expect(typeof m.attempts).toBe('number');
        expect(typeof m.createdAt).toBe('string');
        expect(m.messages).toBeUndefined(); // no message bodies in list
        expect(m.providerMessageId).toBeDefined();
      }
    });

    it('filters by status', async () => {
      const { app, orgs, courses, outbound, auth } = await setup();
      const orgId = await orgs.getDefaultId();
      const key = await mkUser(app, orgId, 'Admin', 'org_admin', BOOTSTRAP);
      const cId = await mkCourse(app, orgId, 'Alpha', key);
      const eId = await mkEnrollment(pgx.pool, orgId, 'whatsapp:+919876543210', cId, 'active');
      await mkOutbound(pgx.pool, orgId, 'whatsapp:+919876543210', eId, cId, 'reply', 'failed', 1);

      const res = await request(app).get('/admin/delivery?status=failed').set('Authorization', `Bearer ${key}`);
      expect(res.status).toBe(200);
      for (const m of res.body.messages) {
        expect(m.status).toBe('failed');
      }
    });

    it('cross-org: 404 for other org delivery', async () => {
      const { app, orgs, courses, outbound, auth } = await setup();
      const orgA = await mkOrg(app, 'acme', 'Acme', BOOTSTRAP);
      const orgB = await mkOrg(app, 'other', 'Other', BOOTSTRAP);
      const keyA = await mkUser(app, orgA.id, 'AdminA', 'org_admin', BOOTSTRAP, 'acme');
      const cIdB = await mkCourse(app, orgB.id, 'Beta', BOOTSTRAP);
      const eIdB = await mkEnrollment(pgx.pool, orgB.id, 'whatsapp:+919876543210', cIdB, 'active');
      await mkOutbound(pgx.pool, orgB.id, 'whatsapp:+919876543210', eIdB, cIdB, 'reply', 'sent', 1);

      const res = await request(app).get('/admin/delivery?org=other').set('Authorization', `Bearer ${keyA}`);
      expect(res.status).toBe(404);
    });

    it('instructor gets 403 on delivery', async () => {
      const { app, orgs, auth } = await setup();
      const orgId = await orgs.getDefaultId();
      const key = await mkUser(app, orgId, 'Ins', 'instructor', BOOTSTRAP);
      expect((await request(app).get('/admin/delivery').set('Authorization', `Bearer ${key}`)).status).toBe(403);
    });
  });

  describe('GET /admin/delivery/:id', () => {
    it('returns detail with attempt chain; message text only for org_admin/platform_admin', async () => {
      const { app, orgs, courses, outbound, auth } = await setup();
      const orgId = await orgs.getDefaultId();
      const key = await mkUser(app, orgId, 'Admin', 'org_admin', BOOTSTRAP);
      const cId = await mkCourse(app, orgId, 'Alpha', key);
      const eId = await mkEnrollment(pgx.pool, orgId, 'whatsapp:+919876543210', cId, 'active');
      const msgId = await mkOutbound(pgx.pool, orgId, 'whatsapp:+919876543210', eId, cId, 'reply', 'sent', 2);
      await mkAttempt(pgx.pool, msgId, 1);
      await mkAttempt(pgx.pool, msgId, 2);

      const res = await request(app).get(`/admin/delivery/${msgId}`).set('Authorization', `Bearer ${key}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(msgId);
      expect(Array.isArray(res.body.attempts)).toBe(true);
      expect(res.body.attempts.length).toBe(2);
      // org_admin can see message text
      expect(typeof res.body.messages).toBe('object');
    });

    it('instructor gets 403 on delivery detail (message text restricted)', async () => {
      const { app, orgs, courses, outbound, auth } = await setup();
      const orgId = await orgs.getDefaultId();
      const key = await mkUser(app, orgId, 'Ins', 'instructor', BOOTSTRAP);
      const courseKey = await mkUser(app, orgId, 'Course admin', 'org_admin', BOOTSTRAP);
      const cId = await mkCourse(app, orgId, 'Alpha', courseKey);
      const eId = await mkEnrollment(pgx.pool, orgId, 'whatsapp:+919876543210', cId, 'active');
      const msgId = await mkOutbound(pgx.pool, orgId, 'whatsapp:+919876543210', eId, cId, 'reply', 'sent', 1);

      const res = await request(app).get(`/admin/delivery/${msgId}`).set('Authorization', `Bearer ${key}`);
      expect(res.status).toBe(403);
    });

    it('404 for unknown delivery id', async () => {
      const { app, orgs, auth } = await setup();
      const orgId = await orgs.getDefaultId();
      const key = await mkUser(app, orgId, 'Admin', 'org_admin', BOOTSTRAP);
      expect((await request(app).get('/admin/delivery/999999').set('Authorization', `Bearer ${key}`)).status).toBe(404);
    });

    it('cross-org: 404 for other org delivery detail', async () => {
      const { app, orgs, courses, outbound, auth } = await setup();
      const orgA = await mkOrg(app, 'acme', 'Acme', BOOTSTRAP);
      const orgB = await mkOrg(app, 'other', 'Other', BOOTSTRAP);
      const keyA = await mkUser(app, orgA.id, 'AdminA', 'org_admin', BOOTSTRAP, 'acme');
      const cIdB = await mkCourse(app, orgB.id, 'Beta', BOOTSTRAP);
      const eIdB = await mkEnrollment(pgx.pool, orgB.id, 'whatsapp:+919876543210', cIdB, 'active');
      const msgId = await mkOutbound(pgx.pool, orgB.id, 'whatsapp:+919876543210', eIdB, cIdB, 'reply', 'sent', 1);

      const res = await request(app).get(`/admin/delivery/${msgId}`).set('Authorization', `Bearer ${keyA}`);
      expect(res.status).toBe(404);
    });
  });

  describe('GET /admin/certificates', () => {
    it('lists completion certificates', async () => {
      const { app, orgs, db, enrollments, learners, auth } = await setup();
      const orgId = await orgs.getDefaultId();
      const key = await mkUser(app, orgId, 'Admin', 'org_admin', BOOTSTRAP);
      const courseId = await mkCourse(app, orgId, 'Alpha', key);
      await learners.upsert('whatsapp:+919876543210', 'Asha Rao');
      const eId = await mkEnrollment(pgx.pool, orgId, 'whatsapp:+919876543210', courseId, 'completed');
      await mkCertificate(pgx.pool, eId, 'Asha Rao', 'Alpha');

      const res = await request(app).get('/admin/certificates').set('Authorization', `Bearer ${key}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.certificates)).toBe(true);
      expect(res.body.certificates.length).toBeGreaterThan(0);
      for (const c of res.body.certificates) {
        expect(typeof c.id).toBe('number');
        expect(typeof c.code).toBe('string');
        expect(typeof c.learnerName).toBe('string');
        expect(typeof c.courseTitle).toBe('string');
      }
    });

    it('cross-org: 404 for other org certificates', async () => {
      const { app, orgs, db, learners, courses, auth } = await setup();
      const orgA = await mkOrg(app, 'acme', 'Acme', BOOTSTRAP);
      const orgB = await mkOrg(app, 'other', 'Other', BOOTSTRAP);
      const keyA = await mkUser(app, orgA.id, 'AdminA', 'org_admin', BOOTSTRAP, 'acme');
      const cIdB = await mkCourse(app, orgB.id, 'Beta', BOOTSTRAP);
      await learners.upsert('whatsapp:+919876543210', 'Asha Rao');
      const eId = await mkEnrollment(pgx.pool, orgB.id, 'whatsapp:+919876543210', cIdB, 'completed');
      await mkCertificate(pgx.pool, eId, 'Asha Rao', 'Alpha');

      const res = await request(app).get('/admin/certificates?org=other').set('Authorization', `Bearer ${keyA}`);
      expect(res.status).toBe(404);
    });

    it('instructor gets 403 on certificates', async () => {
      const { app, orgs, auth } = await setup();
      const orgId = await orgs.getDefaultId();
      const key = await mkUser(app, orgId, 'Ins', 'instructor', BOOTSTRAP);
      expect((await request(app).get('/admin/certificates').set('Authorization', `Bearer ${key}`)).status).toBe(403);
    });
  });

  describe('POST /admin/certificates/:id/resend', () => {
    it('re-sends a certificate through the outbound pipeline', async () => {
      const { app, orgs, courses, learners, enrollments, outbound, auth, db } = await setup();
      const orgId = await orgs.getDefaultId();
      const key = await mkUser(app, orgId, 'Admin', 'org_admin', BOOTSTRAP);
      const courseId = await mkCourse(app, orgId, 'Alpha', key);
      await learners.upsert('whatsapp:+919876543210', 'Asha Rao');
      const eId = await mkEnrollment(pgx.pool, orgId, 'whatsapp:+919876543210', courseId, 'completed');
      await mkCertificate(pgx.pool, eId, 'Asha Rao', 'Alpha');

      const res = await request(app)
        .post(`/admin/certificates/${eId}/resend`)
        .set('Authorization', `Bearer ${key}`);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      // One idempotency key per certificate: a repeat call reuses the same row, no duplicate.
      const res2 = await request(app)
        .post(`/admin/certificates/${eId}/resend`)
        .set('Authorization', `Bearer ${key}`);
      expect(res2.status).toBe(409);
      expect(res2.body.error.code).toBe('conflict');
      expect(typeof res2.body.error.message).toBe('string');
      expect(res2.body.error.message.length).toBeGreaterThan(0);

      const count = await query<{ n: string }>(
        db,
        "SELECT COUNT(*) AS n FROM outbound_messages WHERE idempotency_key LIKE $1",
        [`cert-resend:${eId}:%`],
      );
      expect(Number(count.rows[0]!.n)).toBe(1);
      const key0 = await query<{ n: string }>(
        db,
        "SELECT COUNT(*) AS n FROM outbound_messages WHERE idempotency_key = $1",
        [`cert-resend:${eId}:0`],
      );
      expect(Number(key0.rows[0]!.n)).toBe(1);
    });

    it('cooldown expired: a stale last_resent_at allows a new resend', async () => {
      const { app, orgs, courses, learners, enrollments, auth, db } = await setup();
      const orgId = await orgs.getDefaultId();
      const key = await mkUser(app, orgId, 'Admin', 'org_admin', BOOTSTRAP);
      const courseId = await mkCourse(app, orgId, 'Alpha', key);
      await learners.upsert('whatsapp:+919876543210', 'Asha Rao');
      const eId = await mkEnrollment(pgx.pool, orgId, 'whatsapp:+919876543210', courseId, 'completed');
      await mkCertificate(pgx.pool, eId, 'Asha Rao', 'Alpha');

      // Pretend the certificate was resent long ago (outside the 10-minute default cooldown).
      await query(
        db,
        'UPDATE certificates SET last_resent_at = now() - interval \'1 day\' WHERE enrollment_id = $1',
        [eId],
      );

      const res = await request(app)
        .post(`/admin/certificates/${eId}/resend`)
        .set('Authorization', `Bearer ${key}`);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it('resend after cooldown creates a NEW outbound message (second send)', async () => {
      const { app, orgs, courses, learners, db, auth } = await setup();
      const orgId = await orgs.getDefaultId();
      const key = await mkUser(app, orgId, 'Admin', 'org_admin', BOOTSTRAP);
      const courseId = await mkCourse(app, orgId, 'Alpha', key);
      await learners.upsert('whatsapp:+919876543210', 'Asha Rao');
      const eId = await mkEnrollment(pgx.pool, orgId, 'whatsapp:+919876543210', courseId, 'completed');
      await mkCertificate(pgx.pool, eId, 'Asha Rao', 'Alpha');

      // First resend: cooldown clear -> sends, resend_count 0 -> key cert-resend:<eId>:0.
      const res1 = await request(app)
        .post(`/admin/certificates/${eId}/resend`)
        .set('Authorization', `Bearer ${key}`);
      expect(res1.status).toBe(200);
      expect(res1.body.ok).toBe(true);

      // Move past the cooldown.
      await query(
        db,
        'UPDATE certificates SET last_resent_at = now() - interval \'1 day\' WHERE enrollment_id = $1',
        [eId],
      );

      // Second resend: new resend generation -> NEW outbound message, second send.
      const res2 = await request(app)
        .post(`/admin/certificates/${eId}/resend`)
        .set('Authorization', `Bearer ${key}`);
      expect(res2.status).toBe(200);
      expect(res2.body.ok).toBe(true);

      // Two distinct outbound rows, one per resend generation.
      const rows = await query<{ idempotency_key: string }>(
        db,
        "SELECT idempotency_key FROM outbound_messages WHERE idempotency_key LIKE $1 ORDER BY id",
        [`cert-resend:${eId}:%`],
      );
      expect(rows.rows.map((r) => r.idempotency_key)).toEqual([
        `cert-resend:${eId}:0`,
        `cert-resend:${eId}:1`,
      ]);
    });

    it('404 for unknown certificate enrollment', async () => {
      const { app, orgs, auth } = await setup();
      const orgId = await orgs.getDefaultId();
      const key = await mkUser(app, orgId, 'Admin', 'org_admin', BOOTSTRAP);
      const res = await request(app)
        .post('/admin/certificates/999999/resend')
        .set('Authorization', `Bearer ${key}`);
      expect(res.status).toBe(404);
    });
  });

  describe('GET /admin/schedule-preview', () => {
    it('returns next N send times for an enrollment', async () => {
      const { app, orgs, courses, schedules, auth } = await setup();
      const orgId = await orgs.getDefaultId();
      const key = await mkUser(app, orgId, 'Admin', 'org_admin', BOOTSTRAP);
      const cId = await mkCourse(app, orgId, 'Alpha', key);
      const eId = await mkEnrollment(pgx.pool, orgId, 'whatsapp:+919876543210', cId, 'active');

      // Set an enrollment schedule with daily time
      await schedules.setEnrollmentSchedule(orgId, eId, { dailyTime: '09:30', timezone: 'Asia/Kolkata' });

      const res = await request(app)
        .get(`/admin/schedule-preview?enrollmentId=${eId}&count=5`)
        .set('Authorization', `Bearer ${key}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.times)).toBe(true);
      expect(res.body.times.length).toBeGreaterThan(0);
      for (const t of res.body.times) {
        expect(typeof t.utc).toBe('string'); // ISO UTC
        expect(typeof t.local).toBe('string'); // local time string in enrollment timezone
      }
    });

    it('404 for unknown enrollment', async () => {
      const { app, orgs, auth } = await setup();
      const orgId = await orgs.getDefaultId();
      const key = await mkUser(app, orgId, 'Admin', 'org_admin', BOOTSTRAP);
      const res = await request(app)
        .get('/admin/schedule-preview?enrollmentId=999999&count=5')
        .set('Authorization', `Bearer ${key}`);
      expect(res.status).toBe(404);
    });

    it('cross-org: 404 for other org enrollment preview', async () => {
      const { app, orgs, auth } = await setup();
      const orgA = await mkOrg(app, 'acme', 'Acme', BOOTSTRAP);
      const orgB = await mkOrg(app, 'other', 'Other', BOOTSTRAP);
      const keyA = await mkUser(app, orgA.id, 'AdminA', 'org_admin', BOOTSTRAP, 'acme');
      const cIdB = await mkCourse(app, orgB.id, 'Beta', BOOTSTRAP);
      const eId = await mkEnrollment(pgx.pool, orgB.id, 'whatsapp:+919876543210', cIdB, 'active');

      const res = await request(app)
        .get(`/admin/schedule-preview?enrollmentId=${eId}&count=5`)
        .set('Authorization', `Bearer ${keyA}`);
      expect(res.status).toBe(404);
    });

    it('instructor gets 403 on schedule preview', async () => {
      const { app, orgs, courses, auth } = await setup();
      const orgId = await orgs.getDefaultId();
      const key = await mkUser(app, orgId, 'Ins', 'instructor', BOOTSTRAP);
      const courseKey = await mkUser(app, orgId, 'Course admin', 'org_admin', BOOTSTRAP);
      const cId = await mkCourse(app, orgId, 'Alpha', courseKey);
      const eId = await mkEnrollment(pgx.pool, orgId, 'whatsapp:+919876543210', cId, 'active');
      const res = await request(app)
        .get(`/admin/schedule-preview?enrollmentId=${eId}&count=5`)
        .set('Authorization', `Bearer ${key}`);
      expect(res.status).toBe(403);
    });
  });

  it('keeps instructors forbidden from all learner and admin management actions', async () => {
    const { app, orgs } = await setup();
    const orgId = await orgs.getDefaultId();
    const key = await mkUser(app, orgId, 'Ins', 'instructor', BOOTSTRAP);
    const authorization = `Bearer ${key}`;
    const denied = [
      request(app).post('/admin/enrollments').send({}),
      request(app).post('/admin/enrollments/1/pause').send({}),
      request(app).post('/admin/enrollments/1/resume').send({}),
      request(app).get('/admin/enrollments/1/schedule'),
      request(app).put('/admin/enrollments/1/schedule').send({}),
      request(app).get('/admin/schedule-defaults'),
      request(app).put('/admin/schedule-defaults').send({}),
      request(app).get('/admin/delivery'),
      request(app).get('/admin/delivery/1'),
      request(app).get('/admin/certificates'),
      request(app).post('/admin/certificates/1/resend').send({}),
      request(app).get('/admin/schedule-preview'),
      request(app).get('/admin/failures'),
      request(app).get('/admin/failures/1'),
      request(app).post('/admin/failures/1/replay').send({}),
      request(app).post('/admin/failures/1/discard').send({ reason: 'not allowed' }),
      request(app).get('/admin/users'),
      request(app).post('/admin/users').send({}),
      request(app).post('/admin/users/1/keys').send({}),
      request(app).delete('/admin/users/1/keys/1'),
      request(app).post('/admin/users/1/recover').send({}),
      request(app).get('/admin/audit'),
      request(app).get('/admin/learners/whatsapp%3A%2B919876543210/export'),
      request(app).delete('/admin/learners/whatsapp%3A%2B919876543210'),
      request(app).get('/admin/orgs'),
      request(app).post('/admin/orgs').send({}),
    ];

    for (const response of denied) {
      expect((await response.set('Authorization', authorization)).status).toBe(403);
    }
  });

  describe('Consent in learner export', () => {
    it('export includes consent fields for admin-created enrollments', async () => {
      const { app, orgs, courses, learners, db, auth } = await setup();
      const orgId = await orgs.getDefaultId();
      const key = await mkUser(app, orgId, 'Admin', 'org_admin', BOOTSTRAP);
      const courseId = await mkCourse(app, orgId, 'Alpha', key);
      await learners.upsert('whatsapp:+919876543210', 'Asha Rao');

      const created = await request(app)
        .post('/admin/enrollments')
        .set('Authorization', `Bearer ${key}`)
        .send({ phone: 'whatsapp:+919876543210', courseId, consent: true });
      expect(created.status).toBe(201);
      const eId = created.body.enrollment.id;

      const res = await request(app)
        .get('/admin/learners/whatsapp%3A%2B919876543210/export')
        .set('Authorization', `Bearer ${key}`);
      expect(res.status).toBe(200);
      const enrollment = res.body.enrollments.find(
        (e: { id: number }) => e.id === eId,
      ) as { consentSource: string; consentAt: string; consentAdminId: number | null };
      expect(enrollment).toBeDefined();
      expect(enrollment.consentSource).toBe('admin_attestation');
      expect(enrollment.consentAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
      expect(typeof enrollment.consentAdminId).toBe('number');
    });
  });

  describe('Consent backfill (migration v4)', () => {
    it('backfills existing enrollments from learners.consented_at as web_registration', async () => {
      const { db } = await setup();
      const orgId = await query<{ id: number }>(db, "SELECT id FROM organisations WHERE slug = 'default'");
      const oid = orgId.rows[0]!.id;
      await query(db, "INSERT INTO courses (id, org_id, slug, title, status) VALUES (1, $1, 'alpha', 'Alpha', 'draft')", [oid]);
      await query(db, "INSERT INTO learners (user_id, name, consented_at) VALUES ('whatsapp:+919876543210', 'Asha Rao', '2024-01-15T09:00:00Z')");
      await query(
        db,
        'INSERT INTO enrollments (org_id, user_id, course_id, status, last_delivered_position) VALUES ($1, $2, $3, \'pending\', 0)',
        [oid, 'whatsapp:+919876543210', 1],
      );

      // Run the migration v4 backfill SQL directly.
      await query(
        db,
        `UPDATE enrollments e
         SET consent_at = l.consented_at, consent_source = 'web_registration'
         FROM learners l
         WHERE l.user_id = e.user_id
           AND l.consented_at IS NOT NULL
           AND e.consent_at IS NULL`,
      );

      const row = await query<{ consent_at: Date | null; consent_source: string; consent_admin_id: number | null }>(
        db,
        'SELECT consent_at, consent_source, consent_admin_id FROM enrollments WHERE user_id = $1',
        ['whatsapp:+919876543210'],
      );
      expect(row.rows[0]!.consent_source).toBe('web_registration');
      expect((row.rows[0]!.consent_at as Date).toISOString()).toBe('2024-01-15T09:00:00.000Z');
      expect(row.rows[0]!.consent_admin_id).toBeNull();
    });

    it('does not backfill enrollments whose user has no learners row (stays NULL)', async () => {
      const { db } = await setup();
      const orgId = await query<{ id: number }>(db, "SELECT id FROM organisations WHERE slug = 'default'");
      const oid = orgId.rows[0]!.id;
      await query(db, "INSERT INTO courses (id, org_id, slug, title, status) VALUES (2, $1, 'beta', 'Beta', 'draft')", [oid]);
      // No learners row for this user_id at all -> nothing to backfill from.
      await query(
        db,
        'INSERT INTO enrollments (org_id, user_id, course_id, status, last_delivered_position) VALUES ($1, $2, $3, \'pending\', 0)',
        [oid, 'whatsapp:+919999999999', 2],
      );

      await query(
        db,
        `UPDATE enrollments e
         SET consent_at = l.consented_at, consent_source = 'web_registration'
         FROM learners l
         WHERE l.user_id = e.user_id
           AND l.consented_at IS NOT NULL
           AND e.consent_at IS NULL`,
      );

      const row = await query<{ consent_at: Date | null; consent_source: string | null; consent_admin_id: number | null }>(
        db,
        'SELECT consent_at, consent_source, consent_admin_id FROM enrollments WHERE user_id = $1',
        ['whatsapp:+919999999999'],
      );
      expect(row.rows[0]!.consent_at).toBeNull();
      expect(row.rows[0]!.consent_source).toBeNull();
      expect(row.rows[0]!.consent_admin_id).toBeNull();
    });
  });

  describe('Learner delete still removes consent', () => {
    it('delete removes the enrollment row and its consent fields', async () => {
      const { app, orgs, courses, learners, db, auth } = await setup();
      const orgId = await orgs.getDefaultId();
      const key = await mkUser(app, orgId, 'Admin', 'org_admin', BOOTSTRAP);
      const courseId = await mkCourse(app, orgId, 'Alpha', key);
      await learners.upsert('whatsapp:+919876543210', 'Asha Rao');
      await request(app)
        .post('/admin/enrollments')
        .set('Authorization', `Bearer ${key}`)
        .send({ phone: 'whatsapp:+919876543210', courseId, consent: true });

      const del = await request(app)
        .delete('/admin/learners/whatsapp%3A%2B919876543210')
        .set('Authorization', `Bearer ${key}`);
      expect(del.status).toBe(200);

      const remaining = await query<{ n: string }>(
        db,
        'SELECT COUNT(*) AS n FROM enrollments WHERE user_id = $1',
        ['whatsapp:+919876543210'],
      );
      expect(Number(remaining.rows[0]!.n)).toBe(0);
    });
  });
});
