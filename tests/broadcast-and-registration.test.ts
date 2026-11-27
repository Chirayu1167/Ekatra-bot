import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../src/app';
import { silentLogger } from '../src/logger';
import { query } from '../src/db/pg';
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
import { CourseBot } from '../src/bot/courseBot';
import { Chatbot } from '../src/bot/chatbot';
import { pgFileContext, resetDb } from './pg.helpers';

const pgx = pgFileContext('broadcast-and-registration');
const BOOTSTRAP = 'test-bootstrap-key-0123456789abcdef';

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
    courses,
    enrollments,
    learners,
    optOuts,
    orgs,
    outbound,
    certificates,
    admin: {
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
      bootstrapKey: BOOTSTRAP,
    },
  });

  return {
    db,
    app,
    orgs,
    courses,
    enrollments,
    learners,
    optOuts,
    outbound,
    certificates,
    auth,
    schedules,
  };
}

async function mkUser(
  app: Express,
  orgId: number | null,
  name: string,
  role: string,
  key: string,
) {
  const res = await request(app)
    .post('/admin/users')
    .set('Authorization', `Bearer ${key}`)
    .send({ name, role });
  expect(res.status).toBe(201);
  return res.body.apiKey as string;
}

async function mkCourse(app: Express, orgId: number, title: string, key: string) {
  const res = await request(app)
    .post('/admin/courses')
    .set('Authorization', `Bearer ${key}`)
    .send({
      title,
      description: 'Course description',
      lessons: [{ title: 'Lesson 1', items: [{ kind: 'text', text: 'Hello' }] }],
    });
  expect(res.status).toBe(201);
  const id = res.body.course.id as number;
  await request(app).post(`/admin/courses/${id}/publish`).set('Authorization', `Bearer ${key}`);
  return id;
}

describe('Auto Welcome Message and Course Buttons on Registration', () => {
  it('sends personalized welcome message and course buttons after registration', async () => {
    const { app, orgs, learners, enrollments, db } = await setup();
    const orgId = await orgs.getDefaultId();
    const key = await mkUser(app, orgId, 'Admin', 'org_admin', BOOTSTRAP);
    const courseId = await mkCourse(app, orgId, 'Web Development Basics', key);

    const phone = '+91 98765 43299';
    const whatsappPhone = 'whatsapp:+919876543299';
    const name = 'Rahul Sharma';

    const res = await request(app)
      .post('/register')
      .send({
        name,
        phoneNumber: phone,
        courseId,
        consent: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Verify learner was created
    const savedName = await learners.getName(whatsappPhone);
    expect(savedName).toBe(name);

    // Verify pending enrollment was created
    const pending = await enrollments.findLatest(orgId, whatsappPhone, 'pending');
    expect(pending).toBeDefined();
    expect(pending?.courseId).toBe(courseId);

    // Verify outbound welcome messages
    const outRows = await query<{
      id: number;
      kind: string;
      messages: Array<{ text: string; contentSid?: string }>;
    }>(
      db,
      "SELECT id, kind, messages FROM outbound_messages WHERE user_id = $1 AND kind = 'template'",
      [whatsappPhone],
    );
    expect(outRows.rows).toHaveLength(1);
    const welcomeMsg = outRows.rows[0]!;
    expect(welcomeMsg.kind).toBe('template');
    expect(welcomeMsg.messages).toHaveLength(2);

    // Message 1: Personalized welcome
    expect(welcomeMsg.messages[0]?.text).toBe(`Hi ${name}! 👋 Welcome!`);

    // Message 2: Course list and Start Course option
    expect(welcomeMsg.messages[1]?.text).toContain('Available courses');
    expect(welcomeMsg.messages[1]?.text).toContain('Web Development Basics');
    expect(welcomeMsg.messages[1]?.text).toContain('Start Course');
  });

  it('clicking Start Course button auto-enrolls and triggers the course-start flow', async () => {
    const { orgs, courses, enrollments, optOuts, app } = await setup();
    const orgId = await orgs.getDefaultId();
    const key = await mkUser(app, orgId, 'Admin', 'org_admin', BOOTSTRAP);
    const courseId = await mkCourse(app, orgId, 'Data Science 101', key);

    const phone = '+91 98765 43288';
    const whatsappPhone = 'whatsapp:+919876543288';
    const name = 'Priya Patel';

    // 1. Register
    await request(app)
      .post('/register')
      .send({
        name,
        phoneNumber: phone,
        courseId,
        consent: true,
      });

    // 2. Initialize CourseBot
    const bot = new CourseBot({
      courses,
      enrollments,
      optOuts,
      orgs,
      fallback: new Chatbot(),
    });

    // 3. User taps "Start Course" button (payload START_COURSE)
    const reply = await bot.handleMessage({
      userId: whatsappPhone,
      text: 'START_COURSE',
    });

    // 4. Verify course-start flow is triggered: active enrollment created & lesson 1 delivered
    const active = await enrollments.findActive(orgId, whatsappPhone);
    expect(active).toBeDefined();
    expect(active?.courseId).toBe(courseId);
    // Progress only advances once the worker confirms delivery, so it is still 0 here.
    expect(active?.status).toBe('active');
    expect(reply.deliveryAction).toBeDefined();
    expect(reply.text).toContain('Data Science 101');
  });
});
