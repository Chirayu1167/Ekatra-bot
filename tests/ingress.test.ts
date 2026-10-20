import request from 'supertest';
import twilio from 'twilio';
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp, ROUTE_INVENTORY } from '../src/app';
import { maskPhone, silentLogger, type Logger } from '../src/logger';
import { assertProductionIngress } from '../src/config/env';
import { query } from '../src/db/pg';
import { pgFileContext, resetDb } from './pg.helpers';

const pgx = pgFileContext('ingress');
import { AdminAuthService } from '../src/services/adminAuth.service';
import { CertificateService } from '../src/services/certificate.service';
import { CourseService } from '../src/services/course.service';
import { LearnerService } from '../src/services/learner.service';
import { EnrollmentService } from '../src/services/enrollment.service';
import { OrganisationsService } from '../src/services/organisations.service';
import { OptOutService } from '../src/services/optout.service';
import { InboundEventService } from '../src/services/inboundEvents.service';
import { JobService } from '../src/services/jobs.service';
import { OutboundService } from '../src/services/outbound.service';
import { SchedulerService } from '../src/services/scheduler.service';
import { DeadLetterService } from '../src/services/deadLetters.service';

const AUTH_TOKEN = 'test_auth_token';
const PUBLIC_BASE_URL = 'https://example.test';
const WEBHOOK = '/webhooks/whatsapp';
const USER = 'whatsapp:+919876543210';
const BOT = 'whatsapp:+14155238886';

function capturingLogger(into: unknown[]): Logger {
  const push = (level: string, message: string, fields: Record<string, unknown> = {}) =>
    into.push({ level, message, ...fields });
  return {
    info: (m, f) => push('info', m, f),
    warn: (m, f) => push('warn', m, f),
    error: (m, f) => push('error', m, f),
  };
}

/** Every mounted route, as documented in docs/route-inventory.md. Additions must be classified here. */
const EXPECTED_ROUTES: { method: string; path: string; protection: string }[] = [
  { method: 'GET', path: '/health', protection: 'public:health' },
  { method: 'GET', path: '/metrics', protection: 'public:health' },
  { method: 'GET', path: '/console', protection: 'public:static-console' },
  { method: 'GET', path: '/ready', protection: 'public:health' },
  { method: 'GET', path: '/worker-status', protection: 'public:health' },
  { method: 'GET', path: '/register', protection: 'public:page' },
  { method: 'GET', path: '/register/courses', protection: 'public:catalog' },
  { method: 'POST', path: '/register', protection: 'public:rate-limited' },
  { method: 'GET', path: '/certificates/:file', protection: 'public:capability-url' },
  { method: 'POST', path: '/webhooks/whatsapp', protection: 'twilio-signature' },
  { method: 'POST', path: '/webhooks/whatsapp/status', protection: 'twilio-signature' },
  { method: 'GET', path: '/admin/courses', protection: 'admin:role' },
  { method: 'POST', path: '/admin/courses', protection: 'admin:role' },
  { method: 'GET', path: '/admin/courses/:id', protection: 'admin:role' },
  { method: 'PATCH', path: '/admin/courses/:id', protection: 'admin:role' },
  { method: 'DELETE', path: '/admin/courses/:id', protection: 'admin:role' },
  { method: 'POST', path: '/admin/courses/:id/publish', protection: 'admin:role' },
  { method: 'POST', path: '/admin/courses/:id/unpublish', protection: 'admin:role' },
  { method: 'POST', path: '/admin/courses/:id/lessons', protection: 'admin:role' },
  { method: 'PUT', path: '/admin/courses/:id/lessons/:lessonId', protection: 'admin:role' },
  { method: 'DELETE', path: '/admin/courses/:id/lessons/:lessonId', protection: 'admin:role' },
  { method: 'GET', path: '/admin/courses/:id/schedule', protection: 'admin:role' },
  { method: 'PUT', path: '/admin/courses/:id/schedule', protection: 'admin:role' },
  { method: 'DELETE', path: '/admin/courses/:id/schedule', protection: 'admin:role' },
  { method: 'GET', path: '/admin/enrollments/:id/schedule', protection: 'admin:manage-users' },
  { method: 'PUT', path: '/admin/enrollments/:id/schedule', protection: 'admin:manage-users' },
  { method: 'GET', path: '/admin/schedule-defaults', protection: 'admin:manage-users' },
  { method: 'PUT', path: '/admin/schedule-defaults', protection: 'admin:manage-users' },
  { method: 'GET', path: '/admin/failures', protection: 'admin:manage-users' },
  { method: 'GET', path: '/admin/failures/:id', protection: 'admin:manage-users' },
  { method: 'POST', path: '/admin/failures/:id/replay', protection: 'admin:manage-users' },
  { method: 'POST', path: '/admin/failures/:id/discard', protection: 'admin:manage-users' },
  { method: 'GET', path: '/admin/orgs', protection: 'admin:platform' },
  { method: 'POST', path: '/admin/orgs', protection: 'admin:platform' },
  { method: 'GET', path: '/admin/users', protection: 'admin:manage-users' },
  { method: 'POST', path: '/admin/users', protection: 'admin:manage-users' },
  { method: 'POST', path: '/admin/users/:id/keys', protection: 'admin:manage-users' },
  { method: 'DELETE', path: '/admin/users/:id/keys/:keyId', protection: 'admin:manage-users' },
  { method: 'POST', path: '/admin/users/:id/recover', protection: 'admin:platform' },
  { method: 'GET', path: '/admin/audit', protection: 'admin:manage-users' },
  { method: 'GET', path: '/admin/learners/:phone/export', protection: 'admin:manage-users' },
  { method: 'DELETE', path: '/admin/learners/:phone', protection: 'admin:manage-users' },
  // Step 1 admin console endpoints (Phase 4)
  { method: 'GET', path: '/admin/session', protection: 'admin:role' },
  { method: 'GET', path: '/admin/learners', protection: 'admin:learner-read' },
  { method: 'GET', path: '/admin/learners/:id', protection: 'admin:learner-read' },
  { method: 'GET', path: '/admin/enrollments', protection: 'admin:learner-read' },
  { method: 'POST', path: '/admin/enrollments', protection: 'admin:manage-users' },
  { method: 'POST', path: '/admin/enrollments/:id/pause', protection: 'admin:manage-users' },
  { method: 'POST', path: '/admin/enrollments/:id/resume', protection: 'admin:manage-users' },
  { method: 'GET', path: '/admin/delivery', protection: 'admin:manage-users' },
  { method: 'GET', path: '/admin/delivery/:id', protection: 'admin:manage-users' },
  { method: 'GET', path: '/admin/certificates', protection: 'admin:manage-users' },
  { method: 'POST', path: '/admin/certificates/:id/resend', protection: 'admin:manage-users' },
  { method: 'GET', path: '/admin/schedule-preview', protection: 'admin:manage-users' },
  // /media is middleware-served static (no route layer): covered by HTTP assertions below.
];

describe('route inventory', () => {
  it('the exported inventory matches the documented list exactly', () => {
    expect(ROUTE_INVENTORY).toEqual(EXPECTED_ROUTES);
  });

  it('every mounted route is inventoried: stack count matches, nothing unprotected hides', async () => {
    await resetDb(pgx.pool);
    const db = pgx.pool;
    const orgs = new OrganisationsService(db);
    const courses = new CourseService(db);
    const enrollments = new EnrollmentService(db);
    const learners = new LearnerService(db);
    const optOuts = new OptOutService(db, undefined);
    const certificates = new CertificateService(db, learners, 'test-secret-test-secret');
    const app = createApp({
      env: {
        TWILIO_AUTH_TOKEN: AUTH_TOKEN,
        TWILIO_WEBHOOK_VALIDATE: false,
        PUBLIC_BASE_URL,
      },
      db,
      inbound: new InboundEventService(db),
      jobs: new JobService(db),
      statusCallback: {
        reconcile: {
          db,
          outbound: new OutboundService(db),
          enrollments,
          certificates: new CertificateService(db, learners, 'test-secret-test-secret'),
        },
        logger: silentLogger,
      },
      logger: silentLogger,
      courses,
      enrollments,
      learners,
      optOuts,
      orgs,
      certificates,
      admin: {
        db,
        courses,
        orgs,
        auth: new AdminAuthService(db),
        enrollments,
        learners,
        optOuts,
        certificates,
        inbound: new InboundEventService(db),
        outbound: new OutboundService(db),
        schedules: new SchedulerService(db),
        deadLetters: new DeadLetterService(
          db,
          new OutboundService(db),
          new JobService(db),
          optOuts,
          enrollments,
          courses,
        ),
        bootstrapKey: 'x'.repeat(20),
      },
    });
    await request(app).get('/health');
    const router = (app as unknown as { router?: { stack: unknown[] }; _router?: { stack: unknown[] } }).router ??
      (app as unknown as { _router?: { stack: unknown[] } })._router;
    // Count route layers recursively: sub-routers (register, admin, …) nest their routes.
    const countRoutes = (layers: unknown[]): number =>
      (layers ?? []).reduce<number>((n, l) => {
        const layer = l as { route?: unknown; handle?: { stack?: unknown[] } };
        if (layer.route !== undefined) return n + 1;
        if (layer.handle?.stack) return n + countRoutes(layer.handle.stack);
        return n;
      }, 0);
    // Every inventory entry is one route layer; /media is static middleware, not a layer.
    expect(countRoutes(router?.stack ?? [])).toBe(EXPECTED_ROUTES.length - 1);
  });

  it('unknown routes are 404, admin without credentials is 401', async () => {
    const { app } = await setupApp();
    expect((await request(app).get('/nope')).status).toBe(404);
    expect((await request(app).get('/admin/courses')).status).toBe(401);
    expect((await request(app).get('/admin/orgs')).status).toBe(401);
  });
});

async function setupApp(logs: unknown[] = [], consoleDir?: string) {
  await resetDb(pgx.pool);
  const db = pgx.pool;
  const orgs = new OrganisationsService(db);
  const courses = new CourseService(db);
  const enrollments = new EnrollmentService(db);
  const optOuts = new OptOutService(db);
  const app = createApp({
    env: {
      TWILIO_AUTH_TOKEN: AUTH_TOKEN,
      TWILIO_WEBHOOK_VALIDATE: true,
      PUBLIC_BASE_URL,
    },
    db,
    inbound: new InboundEventService(db),
    jobs: new JobService(db),
    statusCallback: {
      reconcile: {
        db,
        outbound: new OutboundService(db),
        enrollments,
      },
      logger: capturingLogger(logs),
    },
    logger: capturingLogger(logs),
    consoleDir,
    courses,
    enrollments,
    learners: undefined as never,
    optOuts,
    orgs,
    admin: { db, courses, orgs, auth: new AdminAuthService(db), bootstrapKey: 'x'.repeat(20) },
  });
  return { app, db, courses, enrollments };
}

describe('/console static route isolation', () => {
  it('serves the SPA with strict CSP and does not shadow existing application routes', async () => {
    const consoleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ek-console-'));
    fs.mkdirSync(path.join(consoleDir, 'assets'));
    fs.writeFileSync(path.join(consoleDir, 'index.html'), '<!doctype html><title>Console</title>');
    fs.writeFileSync(path.join(consoleDir, 'assets', 'app-AbCdEf123456.js'), 'window.consoleReady = true;');
    try {
      const { app } = await setupApp([], consoleDir);
      const index = await request(app).get('/console/');
      expect(index.status).toBe(200);
      expect(index.text).toContain('<title>Console</title>');
      expect(index.headers['cache-control']).toContain('no-store');
      expect(index.headers['content-security-policy']).toContain("default-src 'self'");
      expect(index.headers['content-security-policy']).toContain("script-src 'self'");

      const fallback = await request(app).get('/console/learners');
      expect(fallback.status).toBe(200);
      expect(fallback.text).toContain('<title>Console</title>');
      const asset = await request(app).get('/console/assets/app-AbCdEf123456.js');
      expect(asset.status).toBe(200);
      expect(asset.headers['cache-control']).toContain('immutable');
      expect((await request(app).post('/console/learners')).status).toBe(404);

      expect((await request(app).get('/health')).body).toEqual({ status: 'ok' });
      expect((await request(app).get('/ready')).status).toBe(200);
      expect((await request(app).get('/admin/courses')).status).toBe(401);
      expect((await request(app).get('/register')).status).toBe(404);
      expect((await request(app).get('/media/not-present')).status).toBe(404);
      expect((await request(app).post('/webhooks/whatsapp').type('form').send({})).status).toBe(403);
    } finally {
      fs.rmSync(consoleDir, { recursive: true, force: true });
    }
  });
});

describe('production ingress guard', () => {
  it('refuses production with signature validation disabled', () => {
    expect(() =>
      assertProductionIngress({ NODE_ENV: 'production', TWILIO_WEBHOOK_VALIDATE: false }),
    ).toThrow(/signature/i);
  });

  it('allows production with validation on, and anything in development', () => {
    expect(() =>
      assertProductionIngress({ NODE_ENV: 'production', TWILIO_WEBHOOK_VALIDATE: true }),
    ).not.toThrow();
    expect(() =>
      assertProductionIngress({ NODE_ENV: 'development', TWILIO_WEBHOOK_VALIDATE: false }),
    ).not.toThrow();
  });
});

describe('webhook rejection is total: no processing, no DB change, no send', () => {
  it('invalid signature changes nothing and sends nothing', async () => {
    const logs: unknown[] = [];
    const { app, db, courses, enrollments } = await setupApp(logs);
    const beforeCourses = await courses.listCourses(1);
    const beforeEnroll = await enrollments.locateUser(USER);
    const res = await request(app)
      .post(WEBHOOK)
      .set('X-Twilio-Signature', 'bogus')
      .type('form')
      .send({ MessageSid: 'SMx', From: USER, To: BOT, Body: 'START 1' });
    expect(res.status).toBe(403);
    expect(await courses.listCourses(1)).toEqual(beforeCourses);
    expect(await enrollments.locateUser(USER)).toEqual(beforeEnroll);
    expect((await query(db, 'SELECT COUNT(*) AS n FROM inbound_events')).rows).toEqual([{ n: 0 }]);
    expect((await query(db, 'SELECT COUNT(*) AS n FROM jobs')).rows).toEqual([{ n: 0 }]);
    expect((await query(db, 'SELECT COUNT(*) AS n FROM outbound_messages')).rows).toEqual([{ n: 0 }]);
  });

  it('oversized webhook bodies are rejected before processing', async () => {
    const { app, db } = await setupApp();
    const big = 'x'.repeat(64 * 1024);
    const params = { MessageSid: 'SMbig', From: USER, To: BOT, Body: big };
    const sig = twilio.getExpectedTwilioSignature(AUTH_TOKEN, `${PUBLIC_BASE_URL}${WEBHOOK}`, params);
    const res = await request(app)
      .post(WEBHOOK)
      .set('X-Twilio-Signature', sig)
      .type('form')
      .send(params);
    expect(res.status).toBe(413);
    expect((await query(db, 'SELECT COUNT(*) AS n FROM inbound_events')).rows).toEqual([{ n: 0 }]);
  });
});

describe('log redaction', () => {
  it('masks phone numbers, keeping the last 4 digits', () => {
    expect(maskPhone('whatsapp:+919876543210')).toBe('whatsapp:+***3210');
    expect(maskPhone('+14155238886')).toBe('+***8886');
    expect(maskPhone('not-a-number')).toBe('not-a-number');
  });

  it('webhook logs never contain message bodies or full numbers', async () => {
    const logs: unknown[] = [];
    const { app } = await setupApp(logs);
    const params = { MessageSid: 'SMlog', From: USER, To: BOT, Body: 'my secret body' };
    const sig = twilio.getExpectedTwilioSignature(AUTH_TOKEN, `${PUBLIC_BASE_URL}${WEBHOOK}`, params);
    await request(app).post(WEBHOOK).set('X-Twilio-Signature', sig).type('form').send(params);
    const dump = JSON.stringify(logs);
    expect(dump).not.toContain('my secret body');
    expect(dump).not.toContain('+919876543210');
    expect(dump).toContain('3210');
  });
});

describe('security headers and CORS', () => {
  it('sets hardening headers and no CORS by default', async () => {
    const { app } = await setupApp();
    const res = await request(app).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('/media is public but cannot leak or traverse', () => {
  it('serves files, refuses listings and path traversal', async () => {
    const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ekatra-media-'));
    fs.writeFileSync(path.join(mediaDir, 'sample.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const app = createApp({
    env: {
      TWILIO_AUTH_TOKEN: AUTH_TOKEN,
      TWILIO_WEBHOOK_VALIDATE: false,
      PUBLIC_BASE_URL,
    },
    db: pgx.pool,
    inbound: new InboundEventService(pgx.pool),
      jobs: new JobService(pgx.pool),
      statusCallback: {
        reconcile: {
          db: pgx.pool,
          outbound: new OutboundService(pgx.pool),
          enrollments: new EnrollmentService(pgx.pool),
        },
        logger: silentLogger,
      },
      logger: silentLogger,
      mediaDir,
    });
    expect((await request(app).get('/media/sample.png')).status).toBe(200);
    expect((await request(app).get('/media/')).status).toBe(404);
    expect((await request(app).get('/media/../package.json')).status).toBe(404);
    fs.rmSync(mediaDir, { recursive: true, force: true });
  });
});
