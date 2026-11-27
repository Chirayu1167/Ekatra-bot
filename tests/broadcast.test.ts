import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { query } from '../src/db/pg';
import { silentLogger } from '../src/logger';
import { AdminAuthService } from '../src/services/adminAuth.service';
import { BroadcastService, normalizeBroadcastPhone } from '../src/services/broadcast.service';
import { CourseService } from '../src/services/course.service';
import { EnrollmentService } from '../src/services/enrollment.service';
import { InboundEventService } from '../src/services/inboundEvents.service';
import { JobService } from '../src/services/jobs.service';
import { OptOutService } from '../src/services/optout.service';
import { OrganisationsService } from '../src/services/organisations.service';
import { OutboundService } from '../src/services/outbound.service';
import { pgFileContext, resetDb } from './pg.helpers';

const pgx = pgFileContext('broadcast');
const KEY = 'broadcast-test-bootstrap-key-012345';
const COURSE_ID = 101;
const WINDOW_USER = 'whatsapp:+919876543210';

async function setup(templateSid?: string) {
  await resetDb(pgx.pool);
  const db = pgx.pool;
  const orgs = new OrganisationsService(db);
  const courses = new CourseService(db);
  const enrollments = new EnrollmentService(db);
  const inbound = new InboundEventService(db);
  const jobs = new JobService(db);
  const outbound = new OutboundService(db);
  const optOuts = new OptOutService(db);
  const broadcasts = new BroadcastService(db, optOuts, inbound, outbound, jobs, templateSid);
  const auth = new AdminAuthService(db);
  const orgId = await orgs.getDefaultId();
  await query(
    db,
    `INSERT INTO courses (id, org_id, slug, title, status)
     VALUES ($1, $2, 'broadcast-course', 'Broadcast course', 'published')`,
    [COURSE_ID, orgId],
  );
  const app = createApp({
    env: {
      TWILIO_AUTH_TOKEN: 'test_auth_token',
      TWILIO_WEBHOOK_VALIDATE: false,
      PUBLIC_BASE_URL: 'https://example.test',
    },
    db,
    inbound,
    jobs,
    statusCallback: { reconcile: { db, outbound, enrollments }, logger: silentLogger },
    admin: {
      db,
      courses,
      orgs,
      auth,
      enrollments,
      optOuts,
      inbound,
      outbound,
      broadcasts,
      bootstrapKey: KEY,
    },
  });
  return { db, app, orgId, inbound, jobs, outbound, optOuts, broadcasts };
}

async function addEnrollment(
  db: typeof pgx.pool,
  orgId: number,
  userId: string,
  status = 'active',
  consent = true,
) {
  await query(
    db,
    `INSERT INTO learners (user_id, name) VALUES ($1, 'Test learner')
     ON CONFLICT (user_id) DO NOTHING`,
    [userId],
  );
  const result = await query<{ id: number }>(
    db,
    `INSERT INTO enrollments (org_id, user_id, course_id, status, consent_at, consent_source)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [orgId, userId, COURSE_ID, status, consent ? new Date() : null, consent ? 'admin_attestation' : null],
  );
  return Number(result.rows[0]!.id);
}

async function addInbound(inbound: InboundEventService, userId: string, suffix: string) {
  await inbound.accept({
    messageSid: `SM-broadcast-${suffix}`,
    fromUser: userId,
    toUser: 'whatsapp:+14155238886',
    body: 'START',
  });
}

const auth = { Authorization: `Bearer ${KEY}` };

describe('course-scoped broadcasts', () => {
  it('normalizes international numbers without accepting local or malformed values', () => {
    expect(normalizeBroadcastPhone(' +91 (98765) 43210 ')).toBe('whatsapp:+919876543210');
    expect(normalizeBroadcastPhone('whatsapp:+14155550123')).toBe('whatsapp:+14155550123');
    expect(normalizeBroadcastPhone('9876543210')).toBeUndefined();
    expect(normalizeBroadcastPhone('+0123456789')).toBeUndefined();
  });

  it('denies broadcast access to instructors', async () => {
    const { app } = await setup();
    const created = await request(app)
      .post('/admin/users')
      .set(auth)
      .send({ org: 'default', name: 'Course instructor', role: 'instructor' });
    expect(created.status).toBe(201);
    const denied = await request(app)
      .post('/admin/broadcasts/preview')
      .set({ Authorization: `Bearer ${created.body.apiKey}` })
      .send({ courseId: COURSE_ID, message: 'Update', phoneNumbers: [WINDOW_USER] });
    expect(denied.status).toBe(403);
  });

  it('does not expose a course from another organisation', async () => {
    const { db, app } = await setup();
    const otherOrg = await query<{ id: number }>(
      db,
      `INSERT INTO organisations (slug, name) VALUES ('other-broadcast-org', 'Other org') RETURNING id`,
    );
    await query(
      db,
      `INSERT INTO courses (id, org_id, slug, title, status)
       VALUES (102, $1, 'other-broadcast-course', 'Other course', 'published')`,
      [otherOrg.rows[0]!.id],
    );
    const response = await request(app)
      .post('/admin/broadcasts/preview')
      .set(auth)
      .send({ courseId: 102, message: 'Update', phoneNumbers: [WINDOW_USER] });
    expect(response.status).toBe(404);
  });

  it('previews anyone with a valid number: enrolled in any state, or not registered at all', async () => {
    const { db, app, orgId, inbound, optOuts } = await setup();
    await addEnrollment(db, orgId, WINDOW_USER);
    await addInbound(inbound, WINDOW_USER, 'window');
    const pending = 'whatsapp:+919876543211';
    await addEnrollment(db, orgId, pending, 'pending');
    await addInbound(inbound, pending, 'pending');
    const noConsent = 'whatsapp:+919876543212';
    await addEnrollment(db, orgId, noConsent, 'active', false);
    await addInbound(inbound, noConsent, 'noconsent');
    const stranger = 'whatsapp:+919876543215';
    await addInbound(inbound, stranger, 'stranger');
    const optedOut = 'whatsapp:+919876543213';
    await addEnrollment(db, orgId, optedOut);
    await addInbound(inbound, optedOut, 'opted-out');
    await optOuts.optOut(optedOut);
    const outsideWindow = 'whatsapp:+919876543214';
    await addEnrollment(db, orgId, outsideWindow);

    const response = await request(app)
      .post('/admin/broadcasts/preview')
      .set(auth)
      .send({
        audience: 'numbers',
        courseId: COURSE_ID,
        message: 'A course update',
        phoneNumbers: [
          '+919876543210', '+91 98765 43210', 'not a number',
          pending, noConsent, stranger, optedOut, outsideWindow,
        ],
      });

    expect(response.status).toBe(201);
    expect(response.body.acceptedCount).toBe(4);
    expect(response.body.rejected).toEqual(expect.arrayContaining([
      { reason: 'duplicate', count: 1 },
      { reason: 'invalid_number', count: 1 },
      { reason: 'opted_out', count: 1 },
      { reason: 'outside_window_template_required', count: 1 },
    ]));
    expect(JSON.stringify(response.body)).not.toContain('9876543215');
  });

  it('resolves a course roster server-side, honours the status filter, and sends to registered-but-pending learners', async () => {
    const { db, app, orgId, inbound, broadcasts, jobs } = await setup();
    const pending = 'whatsapp:+919876540001';
    const active = 'whatsapp:+919876540002';
    const paused = 'whatsapp:+919876540003';
    for (const [u, st] of [[pending, 'pending'], [active, 'active'], [paused, 'paused']] as const) {
      await addEnrollment(db, orgId, u, st);
      await addInbound(inbound, u, u.slice(-4));
    }

    const counts = await request(app).get(`/admin/broadcasts/audience?courseId=${COURSE_ID}`).set(auth);
    expect(counts.body).toMatchObject({ total: 3, pending: 1, active: 1, paused: 1, completed: 0 });

    const all = await request(app)
      .post('/admin/broadcasts/preview').set(auth)
      .send({ audience: 'course', courseId: COURSE_ID, message: 'Hello' });
    expect(all.status).toBe(201);
    expect(all.body.acceptedCount).toBe(3);

    const onlyPending = await request(app)
      .post('/admin/broadcasts/preview').set(auth)
      .send({ audience: 'course', courseId: COURSE_ID, statuses: ['pending'], message: 'Hello' });
    expect(onlyPending.body.acceptedCount).toBe(1);

    const queued = await request(app).post(`/admin/broadcasts/${all.body.id}/queue`).set(auth).send({});
    expect(queued.body).toMatchObject({ queuedCount: 3, skippedCount: 0 });

    // The worker-side check must let every one of them through (this used to skip silently).
    const rows = await query<{ id: number; outbound_message_id: number }>(
      db, 'SELECT id, outbound_message_id FROM broadcast_recipients WHERE broadcast_id = $1', [all.body.id]);
    for (const r of rows.rows) {
      expect(await broadcasts.prepareRecipientForSend(Number(r.id), Number(r.outbound_message_id)))
        .toEqual({ ready: true });
    }
    expect(jobs).toBeDefined();
  });

  it('sends to numbers that are not registered and to all learners (no course) through the worker check', async () => {
    const { db, app, orgId, inbound, broadcasts } = await setup();
    const stranger = 'whatsapp:+919876540010';
    const learner = 'whatsapp:+919876540011';
    await addInbound(inbound, stranger, 'stranger');
    await addEnrollment(db, orgId, learner, 'pending');
    await addInbound(inbound, learner, 'learner');

    const preview = await request(app)
      .post('/admin/broadcasts/preview').set(auth)
      .send({ audience: 'all_learners', message: 'Hi all', phoneNumbers: [stranger] });
    expect(preview.body).toMatchObject({ audience: 'all_learners', acceptedCount: 2 });
    await request(app).post(`/admin/broadcasts/${preview.body.id}/queue`).set(auth).send({});
    const rows = await query<{ id: number; outbound_message_id: number }>(
      db, 'SELECT id, outbound_message_id FROM broadcast_recipients WHERE broadcast_id = $1', [preview.body.id]);
    expect(rows.rows).toHaveLength(2);
    for (const r of rows.rows) {
      expect(await broadcasts.prepareRecipientForSend(Number(r.id), Number(r.outbound_message_id)))
        .toEqual({ ready: true });
    }
  });

  it('rejects a course audience without a course and an empty roster', async () => {
    const { app } = await setup();
    const noCourse = await request(app)
      .post('/admin/broadcasts/preview').set(auth).send({ audience: 'course', message: 'x' });
    expect(noCourse.status).toBe(400);
    const empty = await request(app)
      .post('/admin/broadcasts/preview').set(auth)
      .send({ audience: 'course', courseId: COURSE_ID, message: 'x' });
    expect(empty.status).toBe(409);
  });

  it('queues through the durable outbound job and suppresses a recipient if eligibility changes', async () => {
    const { db, app, orgId, inbound, broadcasts } = await setup();
    await addEnrollment(db, orgId, WINDOW_USER);
    await addInbound(inbound, WINDOW_USER, 'expires');

    const preview = await request(app)
      .post('/admin/broadcasts/preview')
      .set(auth)
      .send({ courseId: COURSE_ID, message: 'Lesson update', phoneNumbers: [WINDOW_USER] });
    expect(preview.body.acceptedCount).toBe(1);

    const queued = await request(app)
      .post(`/admin/broadcasts/${preview.body.id}/queue`)
      .set(auth)
      .send({});
    expect(queued.status).toBe(200);
    expect(queued.body).toMatchObject({ queued: true, queuedCount: 1, skippedCount: 0 });
    expect(
      (
        await request(app)
          .post(`/admin/broadcasts/${preview.body.id}/queue`)
          .set(auth)
          .send({})
      ).status,
    ).toBe(409);

    const message = await query<{ id: number; status: string }>(
      db,
      `SELECT om.id, om.status FROM outbound_messages om
       JOIN broadcast_recipients br ON br.outbound_message_id = om.id
       WHERE br.broadcast_id = $1`,
      [preview.body.id],
    );
    const job = await query<{ kind: string; payload: Record<string, unknown> }>(
      db,
      `SELECT kind, payload FROM jobs WHERE ref_id = $1`,
      [message.rows[0]!.id],
    );
    expect(message.rows[0]?.status).toBe('queued');
    expect(job.rows[0]?.kind).toBe('outbound_send');
    expect(job.rows[0]?.payload).toMatchObject({ messageId: message.rows[0]!.id });

    await query(
      db,
      `UPDATE inbound_events SET created_at = now() - INTERVAL '25 hours'
       WHERE from_user = $1`,
      [WINDOW_USER],
    );
    const recipient = await query<{ id: number }>(
      db,
      'SELECT id FROM broadcast_recipients WHERE broadcast_id = $1',
      [preview.body.id],
    );
    const prepared = await broadcasts.prepareRecipientForSend(
      Number(recipient.rows[0]!.id),
      Number(message.rows[0]!.id),
    );
    expect(prepared).toEqual({ ready: false, reason: 'outside_window_template_required' });
    const status = await request(app).get(`/admin/broadcasts/${preview.body.id}`).set(auth);
    expect(status.body).toMatchObject({ failed: 1, skipped: 1 });
  });

  it('uses the approved template outside the window and never falls back to free-form text', async () => {
    const sid = 'HX1234567890abcdef1234567890abcdef';
    const { db, app, orgId } = await setup(sid);
    const outsideWindow = 'whatsapp:+919876543216';
    await addEnrollment(db, orgId, outsideWindow);
    const preview = await request(app)
      .post('/admin/broadcasts/preview')
      .set(auth)
      .send({ courseId: COURSE_ID, message: 'A course update', phoneNumbers: [outsideWindow] });
    expect(preview.body).toMatchObject({ acceptedCount: 1, templateCount: 1 });
    await request(app).post(`/admin/broadcasts/${preview.body.id}/queue`).set(auth).send({});
    const stored = await query<{ messages: Array<Record<string, unknown>> }>(
      db,
      `SELECT om.messages FROM outbound_messages om
       JOIN broadcast_recipients br ON br.outbound_message_id = om.id
       WHERE br.broadcast_id = $1`,
      [preview.body.id],
    );
    expect(stored.rows[0]?.messages[0]).toMatchObject({
      text: 'A course update',
      contentSid: sid,
      templateFallback: 'none',
    });
  });
});
