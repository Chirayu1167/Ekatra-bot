// RECONSTRUCTED from test usage on 2026-10-14; original was not recoverable.
import request from 'supertest';
import { Chatbot } from '../src/bot/chatbot';
import { CourseBot, type ButtonTemplates } from '../src/bot/courseBot';
import { createApp } from '../src/app';
import { silentLogger } from '../src/logger';
import type { Pool } from 'pg';
import { AdminAuthService } from '../src/services/adminAuth.service';
import { CertificateService } from '../src/services/certificate.service';
import { CourseService } from '../src/services/course.service';
import { EnrollmentService } from '../src/services/enrollment.service';
import { LearnerService } from '../src/services/learner.service';
import { OrganisationsService } from '../src/services/organisations.service';
import { InboundEventService } from '../src/services/inboundEvents.service';
import { JobService } from '../src/services/jobs.service';
import { OutboundService } from '../src/services/outbound.service';
import { SchedulerService } from '../src/services/scheduler.service';
import { DeadLetterService } from '../src/services/deadLetters.service';
import { drainJobs, type ProcessorDeps } from '../src/worker/processor';
import { resetDb } from './pg.helpers';
import { OptOutService } from '../src/services/optout.service';
import { TwilioSendError } from '../src/errors';
import type { WhatsAppSender } from '../src/services/whatsapp.service';
import type { OutgoingWhatsAppMessage } from '../src/types/whatsapp';
import type { CourseCreateInput } from '../src/types/course';

export const USER = 'whatsapp:+919876543210';
export const OTHER_USER = 'whatsapp:+919811122233';
export const BOT = 'whatsapp:+14155238886';
export const ADMIN_KEY = 'test-admin-key-0123456789';
export const WEBHOOK = '/webhooks/whatsapp';

/** Records what would be sent to WhatsApp. Can be told to fail or to be slow. */
export class FakeSender implements WhatsAppSender {
  sent: OutgoingWhatsAppMessage[] = [];
  calls = 0;
  delayMs = 0;
  failAll = false;
  /** Return true to make this call fail with a Twilio-style error. */
  failIf?: (message: OutgoingWhatsAppMessage, callIndex: number) => boolean;

  async sendWhatsAppMessage(message: OutgoingWhatsAppMessage): Promise<{ sid: string }> {
    const index = this.calls++;
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failIf?.(message, index)) throw new TwilioSendError(new Error('simulated failure'));
    if (this.failAll) throw new TwilioSendError(new Error('twilio down'));
    this.sent.push(message);
    return { sid: `SMout${index}` };
  }
}

/** The real app + a real Postgres database; only Twilio is faked. */
export interface HarnessOptions {
  /** Postgres pool (usually the test file's isolated database). Required. */
  pg: Pool;
  /** Reset the database to pristine before building (default true; false reuses existing data). */
  pgFresh?: boolean;
  locks?: boolean;
  admin?: boolean;
  buttons?: ButtonTemplates;
  /** When false, POSTs only enqueue — the test drains the worker manually. Default true. */
  autoDrain?: boolean;
  /** Approved schedule template SID (A1). Unset => closed-window scheduled lessons fail. */
  templateSid?: string;
  /** Enable signature validation for proxy and staging smoke tests. */
  validateWebhookSignature?: boolean;
  /** Override the console static directory for isolated integration tests. */
  consoleDir?: string;
}

/** The real app + a real Postgres database; only Twilio is faked. */
export async function buildHarness(options: HarnessOptions) {
  const db = options.pg;
  if (options.pgFresh !== false) await resetDb(db);
  const orgs = new OrganisationsService(db);
  const orgId = await orgs.getDefaultId();
  const auth = new AdminAuthService(db);
  const courses = new CourseService(db);
  const enrollments = new EnrollmentService(db);
  const learners = new LearnerService(db);
  const optOuts = new OptOutService(db, undefined);
  const certificates = new CertificateService(db, learners, 'test-secret-test-secret');
  const inbound = new InboundEventService(db);
  const jobs = new JobService(db);
  const outbound = new OutboundService(db);
  const sender = new FakeSender();
  const chatbot = new CourseBot({
    courses,
    enrollments,
    optOuts,
    orgs,
    fallback: new Chatbot(),
    ...(options.buttons && { buttons: options.buttons }),
  });
  const app = createApp({
    env: {
      TWILIO_AUTH_TOKEN: 'test_auth_token',
      TWILIO_WEBHOOK_VALIDATE: options.validateWebhookSignature ?? false,
      PUBLIC_BASE_URL: 'https://example.test',
    },
    db: options.pg,
    inbound,
    jobs,
    courses,
    enrollments,
    learners,
    optOuts,
    orgs,
    certificates,
    statusCallback: {
      reconcile: { db, outbound, enrollments, certificates },
      logger: silentLogger,
      ...(options.consoleDir && { consoleDir: options.consoleDir }),
    },
    logger: silentLogger,
    ...(options.admin !== false && {
      admin: {
        db,
        courses,
        orgs,
        auth,
        enrollments,
        learners,
        optOuts,
        certificates,
        inbound,
        outbound,
        schedules: new SchedulerService(db),
        deadLetters: new DeadLetterService(db, outbound, jobs, optOuts, enrollments, courses),
        bootstrapKey: ADMIN_KEY,
      },
    }),
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
      buttons: options.buttons ?? {},
      certificates,
      publicBaseUrl: 'https://example.test',
      learnerName: (u) => learners.getName(u),
      templateSid: options.templateSid,
    },
    inbound,
    jobs,
    outbound,
    logger: silentLogger,
    workerId: 'test-worker',
    visibilitySecs: 300,
  };
  /** Run the worker inline until no due job remains (simulates the worker process). */
  const drain = () => drainJobs(processor);

  let counter = 0;
  const nextSid = () => `SMin${Date.now()}_${++counter}`;

  const post = async (body: string, opts: { sid?: string; from?: string; payload?: string } = {}) => {
    const res = await request(app)
      .post(WEBHOOK)
      .type('form')
      .send({
        MessageSid: opts.sid ?? nextSid(),
        From: opts.from ?? USER,
        To: BOT,
        Body: body,
        ...(opts.payload !== undefined && { ButtonPayload: opts.payload }),
      });
    if (options.autoDrain !== false) await drain();
    return res;
  };

  /** Deliver a Twilio status callback (signed in production; harness leaves it unsigned). */
  const postCallback = (twilioSid: string, twilioStatus: string) =>
    request(app).post('/webhooks/whatsapp/status').type('form').send({
      MessageSid: twilioSid,
      MessageStatus: twilioStatus,
    });

  /** Send a WhatsApp message and return the HTTP response plus what the bot sent back. */
  async function say(body: string, opts: { sid?: string; from?: string; payload?: string } = {}) {
    const before = sender.sent.length;
    const res = await post(body, opts);
    const messages = sender.sent.slice(before);
    return {
      res,
      messages,
      texts: messages.map((m) => m.body),
      all: messages.map((m) => m.body).join('\n---\n'),
    };
  }

  return {
    db,
    pool: options.pg,
    app,
    courses,
    enrollments,
    learners,
    optOuts,
    orgs,
    orgId,
    auth,
    certificates,
    inbound,
    jobs,
    outbound,
    sender,
    post,
    postCallback,
    say,
    drain,
    processor,
  };
}

export type Harness = Awaited<ReturnType<typeof buildHarness>>;

/** A published 3-lesson course covering text, image, document and link content. */
export function alphaCourse(): CourseCreateInput {
  return {
    title: 'Alpha',
    description: 'First test course',
    slug: 'alpha',
    lessons: [
      { title: 'One', items: [{ kind: 'text', text: 'Text of lesson one.' }] },
      {
        title: 'Two',
        items: [
          { kind: 'text', text: 'Text of lesson two.' },
          { kind: 'image', url: 'https://cdn.example.test/pic.png', caption: 'A picture' },
          { kind: 'document', url: 'https://cdn.example.test/notes.pdf' },
        ],
      },
      {
        title: 'Three',
        items: [
          { kind: 'text', text: 'Text of lesson three.' },
          { kind: 'link', url: 'https://example.test/read', label: 'Further reading' },
        ],
      },
    ],
  };
}

export async function publishedCourse(h: Harness, input: CourseCreateInput = alphaCourse()) {
  const course = await h.courses.createCourse(h.orgId, input);
  return h.courses.publish(h.orgId, course.id);
}

export function singleLessonCourse(title = 'Tiny', slug = 'tiny'): CourseCreateInput {
  return {
    title,
    description: '',
    slug,
    lessons: [{ title: 'Only', items: [{ kind: 'text', text: 'The only lesson.' }] }],
  };
}

export const BOT_NUMBER = 'whatsapp:+14155238886';
