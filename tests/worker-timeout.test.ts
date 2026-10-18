import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { query } from '../src/db/pg';
import { resetDb } from './pg.helpers';
import { pgFileContext } from './pg.helpers';
import { OrganisationsService } from '../src/services/organisations.service';
import { CourseService } from '../src/services/course.service';
import { EnrollmentService } from '../src/services/enrollment.service';
import { LearnerService } from '../src/services/learner.service';
import { OptOutService } from '../src/services/optout.service';
import { CertificateService } from '../src/services/certificate.service';
import { InboundEventService } from '../src/services/inboundEvents.service';
import { JobService } from '../src/services/jobs.service';
import { OutboundService } from '../src/services/outbound.service';
import { CourseBot } from '../src/bot/courseBot';
import { Chatbot } from '../src/bot/chatbot';
import { silentLogger } from '../src/logger';
import { drainJobs, type ProcessorDeps } from '../src/worker/processor';
import { TwilioWhatsAppService } from '../src/services/whatsapp.service';

const pgx = pgFileContext('worker-timeout');

/** A Twilio client that hangs only for the hung learner; succeeds for others. */
let hungTo: string | null = null;
const hangingClient = {
  messages: {
    create: (params: { to: string }) =>
      new Promise<{ sid: string }>((resolve, _reject) => {
        if (params.to === hungTo) {
          // never settles -> triggers the 800ms timeout
          return;
        }
        resolve({ sid: `SMhung-${Date.now()}` });
      }),
  },
} as unknown as { messages: { create: (params: { to: string }) => Promise<{ sid: string }> } };

async function buildProcessor(pg: Pool) {
  await resetDb(pg);
  const orgs = new OrganisationsService(pg);
  const orgId = await orgs.getDefaultId();
  const courses = new CourseService(pg);
  const enrollments = new EnrollmentService(pg);
  const learners = new LearnerService(pg);
  const optOuts = new OptOutService(pg, undefined);
  const certificates = new CertificateService(pg, learners, 'test-secret-test-secret');
  const inbound = new InboundEventService(pg);
  const jobs = new JobService(pg);
  const outbound = new OutboundService(pg);
  const sender = new TwilioWhatsAppService(
    hangingClient,
    'whatsapp:+14155238886',
    silentLogger,
    800, // 800ms hard timeout
  );
  const chatbot = new CourseBot({ courses, enrollments, optOuts, orgs, fallback: new Chatbot() });
  const processor: ProcessorDeps = {
    db: pg,
    chatbot,
    rawSender: sender,
    optOuts,
    enrollments,
    certificates,
    courses,
    scheduleRender: { buttons: {}, certificates, publicBaseUrl: 'https://example.test' },
    inbound,
    jobs,
    outbound,
    logger: silentLogger,
    workerId: 'timeout-worker',
    visibilitySecs: 300,
  };
  return { pg, orgId, processor, jobs, outbound, courses, enrollments };
}

async function makeEnrollment(h: Awaited<ReturnType<typeof buildProcessor>>, userId: string) {
  const { pg, orgId, courses } = h;
  const course = await courses.createCourse(orgId, {
    title: 'T',
    description: '',
    slug: `c-${Date.now()}`,
    lessons: [{ title: 'L', items: [{ kind: 'text', text: 'hi' }] }],
  });
  await courses.publish(orgId, course.id);
  await query(
    pg,
    `INSERT INTO enrollments (org_id, user_id, course_id, status, last_delivered_position) VALUES ($1,$2,$3,'active',0)`,
    [orgId, userId, course.id],
  );
  const { rows } = await query<{ id: number }>(
    pg,
    'SELECT id FROM enrollments WHERE user_id = $1 AND course_id = $2',
    [userId, course.id],
  );
  return { enrollmentId: rows[0]!.id, courseId: course.id };
}

async function makeOutboundJob(
  h: Awaited<ReturnType<typeof buildProcessor>>,
  enrollmentId: number,
  courseId: number,
  userId: string,
  orgId: number,
) {
  const { outbound, jobs } = h;
  const { message } = await outbound.create({
    idempotencyKey: `wt-out:${Date.now()}`,
    orgId,
    userId,
    enrollmentId,
    courseId,
    lessonPosition: 1,
    kind: 'scheduled_lesson',
    messages: [{ text: 'hi' }],
  });
  await jobs.enqueue({
    kind: 'outbound_send',
    dedupeKey: `wt-job:${message.id}`,
    refType: 'outbound_messages',
    refId: message.id,
    payload: { messageId: message.id, progressAction: { type: 'none' as const } },
  });
  return message.id;
}

describe('worker send timeout (A2)', () => {
  it('a hung send ends unknown, releases the lock, and does not block other learners', async () => {
    const h = await buildProcessor(pgx.pool);
    const { orgId, processor, outbound } = h;

    const userA = 'whatsapp:+919876543211';
    const userB = 'whatsapp:+919876543212';
    hungTo = userA;
    const encA = await makeEnrollment(h, userA);
    const encB = await makeEnrollment(h, userB);

    const msgA = await makeOutboundJob(h, encA.enrollmentId, encA.courseId, userA, orgId);
    const msgB = await makeOutboundJob(h, encB.enrollmentId, encB.courseId, userB, orgId);

    const started = Date.now();
    // Drain both jobs: A's send hangs (times out after 800ms), B must still complete.
    await drainJobs(processor, 10);
    const elapsed = Date.now() - started;

    const a = await outbound.getById(msgA);
    const b = await outbound.getById(msgB);
    expect(a?.status).toBe('unknown'); // uncertain outcome, parked
    expect(String(a?.errorMessage ?? '')).toMatch(/timed out|timeout/i);
    // B was not blocked by A's hung send.
    expect(b?.status).toBe('sent');
    // Lock/connection released: drain finished in roughly the timeout, not minutes.
    expect(elapsed).toBeLessThan(30000);
  });

  it('A2: reclaim of a job whose message is sending with attempts>1 parks as unknown, never auto-resent', async () => {
    const h = await buildProcessor(pgx.pool);
    const { orgId, processor, outbound, jobs } = h;

    const userA = 'whatsapp:+919876543211';
    const course = await h.courses.createCourse(orgId, {
      title: 'T',
      description: '',
      slug: `c-${Date.now()}`,
      lessons: [{ title: 'L', items: [{ kind: 'text', text: 'hi' }] }],
    });
    await h.courses.publish(orgId, course.id);
    await query(
      h.pg,
      `INSERT INTO enrollments (org_id, user_id, course_id, status, last_delivered_position) VALUES ($1,$2,$3,'active',0)`,
      [orgId, userA, course.id],
    );

    const { message } = await outbound.create({
      idempotencyKey: `wt-sending-${Date.now()}`,
      orgId,
      userId: userA,
      courseId: course.id,
      lessonPosition: 1,
      kind: 'reply',
      messages: [{ text: 'crash mid-send' }],
    });
    // Message is mid-send (sending) from a previous worker that died.
    await query(h.pg, `UPDATE outbound_messages SET status = 'sending', attempts = 2 WHERE id = $1`, [message.id]);

    // Job reclaimed with attempts > 1.
    await jobs.enqueue({
      kind: 'outbound_send',
      dedupeKey: `wt-send-job-${message.id}`,
      refType: 'outbound_messages',
      refId: message.id,
      payload: { messageId: message.id, progressAction: { type: 'none' as const } },
    });
    await query(h.pg, `UPDATE jobs SET attempts = 2 WHERE dedupe_key = $1`, [`wt-send-job-${message.id}`]);

    await drainJobs(processor, 10);

    const after = await outbound.getById(message.id);
    expect(after?.status).toBe('unknown');
    const dl = await query<{ reason: string }>(h.pg, "SELECT reason FROM dead_letters WHERE kind = 'outbound' AND ref_id = $1 AND status = 'open'", [message.id]);
    expect(dl.rows[0]!.reason).toMatch(/reclaimed while sending/i);

    // forceDue + drain must not resend an unknown message.
    await query(h.pg, `UPDATE jobs SET run_at = now(), visible_at = now() WHERE status = 'queued'`);
    await drainJobs(processor, 10);
    const still = await outbound.getById(message.id);
    expect(still?.status).toBe('unknown');
  });
});
