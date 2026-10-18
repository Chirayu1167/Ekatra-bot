import request from 'supertest';
import type { Pool } from 'pg';
import { Chatbot } from '../src/bot/chatbot';
import { CourseBot } from '../src/bot/courseBot';
import { createApp } from '../src/app';
import { CertificateService } from '../src/services/certificate.service';
import { CourseService } from '../src/services/course.service';
import { OrganisationsService } from '../src/services/organisations.service';
import { CourseTutor, type LlmClient } from '../src/services/courseTutor';
import { EnrollmentService } from '../src/services/enrollment.service';
import { LearnerService } from '../src/services/learner.service';
import { OptOutService } from '../src/services/optout.service';
import { TwilioSendError } from '../src/errors';
import type { WhatsAppSender } from '../src/services/whatsapp.service';
import type { OutgoingWhatsAppMessage } from '../src/types/whatsapp';
import { resetDb } from './pg.helpers';
import { InboundEventService } from '../src/services/inboundEvents.service';
import { JobService } from '../src/services/jobs.service';
import { OutboundService } from '../src/services/outbound.service';
import { drainJobs, type ProcessorDeps } from '../src/worker/processor';
import { silentLogger } from '../src/logger';

export const LEARNER = 'whatsapp:+919876543210';
export const BOT_NUMBER = 'whatsapp:+14155238886';
export const BASE = 'https://ekatra.test';

export class FakeSender implements WhatsAppSender {
  sent: OutgoingWhatsAppMessage[] = [];
  failAll = false;
  private n = 0;
  async sendWhatsAppMessage(m: OutgoingWhatsAppMessage) {
    if (this.failAll) throw new TwilioSendError(new Error('twilio down'));
    this.sent.push(m);
    return { sid: `SM${++this.n}` };
  }
  /** Everything sent to a learner as one searchable string (button messages use their variable). */
  text(): string {
    return this.sent.map((m) => `${m.body} ${m.contentVariables?.['1'] ?? ''} ${m.mediaUrl ?? ''}`).join('\n');
  }
  clear() {
    this.sent = [];
  }
}

export class FakeLlm implements LlmClient {
  calls: { system: string; user: string }[] = [];
  reply: string | null = 'Spaced repetition means reviewing material at increasing intervals.';
  async complete(system: string, user: string) {
    this.calls.push({ system, user });
    return this.reply;
  }
}

export async function harness(pg: Pool, fresh = true) {
  const db = pg;
  if (fresh) await resetDb(db);
  const orgs = new OrganisationsService(db);
  const orgId = await orgs.getDefaultId();
  const courses = new CourseService(db);
  const enrollments = new EnrollmentService(db);
  const learners = new LearnerService(db);
  const optOuts = new OptOutService(db, undefined);
  const certificates = new CertificateService(db, learners, 'test-secret-test-secret');
  const sender = new FakeSender();
  const llm = new FakeLlm();
  const tutor = new CourseTutor({ llm, courses, questionsPerHour: 3 });
  const inbound = new InboundEventService(db);
  const jobs = new JobService(db);
  const outbound = new OutboundService(db);
  const chatbot = new CourseBot({
    courses,
    enrollments,
    optOuts,
    orgs,
    fallback: new Chatbot(),
    tutor,
    certificates,
    publicBaseUrl: BASE,
    learnerName: (u) => learners.getName(u),
  });
  const app = createApp({
    env: { TWILIO_AUTH_TOKEN: 'x', TWILIO_WEBHOOK_VALIDATE: false, PUBLIC_BASE_URL: BASE },
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
    certificates,
  });
  const processor: ProcessorDeps = {
    db,
    chatbot,
    rawSender: sender,
    optOuts,
    enrollments,
    certificates,
    courses,
    scheduleRender: {
      buttons: {},
      certificates,
      publicBaseUrl: BASE,
      learnerName: (u) => learners.getName(u),
    },
    inbound,
    jobs,
    outbound,
    logger: silentLogger,
    workerId: 'test-worker',
  };

  let sid = 0;
  const say = async (body: string, from = LEARNER, messageSid = `IN${++sid}`, payload?: string) => {
    const res = await request(app)
      .post('/webhooks/whatsapp')
      .type('form')
      .send({
        MessageSid: messageSid,
        From: from,
        To: BOT_NUMBER,
        Body: body,
        ...(payload !== undefined && { ButtonPayload: payload }),
      });
    // The worker runs inline here so journey assertions still read replies synchronously.
    await drainJobs(processor);
    return res;
  };

  const course = await courses.createCourse(orgId, {
    title: 'Study Habits',
    description: 'How to learn well',
    lessons: [
      { title: 'Spacing', items: [{ kind: 'text', text: 'Spaced repetition means reviewing material at increasing intervals.' }] },
      {
        title: 'Recall',
        items: [
          { kind: 'text', text: 'Active recall means testing yourself instead of rereading notes.' },
          {
            kind: 'quiz',
            caption: 'What is active recall?',
            options: [{ label: 'Rereading notes' }, { label: 'Testing yourself', correct: true }],
          },
        ],
      },
      { title: 'Sleep', items: [{ kind: 'text', text: 'Sleep helps memory consolidation after studying.' }] },
    ],
  });
  await courses.publish(orgId, course.id);
  return { db, pool: pg, app, say, sender, llm, courses, enrollments, certificates, learners, course, orgs, orgId, request };
}

export type Harness = Awaited<ReturnType<typeof harness>>;