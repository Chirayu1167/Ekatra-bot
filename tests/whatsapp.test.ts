import request from 'supertest';
import twilio from 'twilio';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createApp } from '../src/app';
import { silentLogger } from '../src/logger';
import { query } from '../src/db/pg';
import { InboundEventService } from '../src/services/inboundEvents.service';
import { JobService } from '../src/services/jobs.service';
import { OutboundService } from '../src/services/outbound.service';
import { EnrollmentService } from '../src/services/enrollment.service';
import { CertificateService } from '../src/services/certificate.service';
import { LearnerService } from '../src/services/learner.service';
import {
  TwilioWhatsAppService,
  type TwilioMessagesClient,
} from '../src/services/whatsapp.service';
import { pgFileContext, resetDb } from './pg.helpers';

const pgx = pgFileContext('whatsapp');

const AUTH_TOKEN = 'test_auth_token';
const PUBLIC_BASE_URL = 'https://example.test';
const WEBHOOK_PATH = '/webhooks/whatsapp';
const USER = 'whatsapp:+919876543210';
const BOT = 'whatsapp:+14155238886';

const payload = (body = 'hello', sid = 'SM1234567890abcdef') => ({
  MessageSid: sid,
  From: USER,
  To: BOT,
  Body: body,
});

async function setup(overrides: { validate?: boolean; publicBaseUrl?: string | null } = {}) {
  await resetDb(pgx.pool);
  const db = pgx.pool;
  const enrollments = new EnrollmentService(db);
  const learners = new LearnerService(db);
  const app = createApp({
    env: {
      TWILIO_AUTH_TOKEN: AUTH_TOKEN,
      TWILIO_WEBHOOK_VALIDATE: overrides.validate ?? false,
      PUBLIC_BASE_URL:
        overrides.publicBaseUrl === null ? undefined : (overrides.publicBaseUrl ?? PUBLIC_BASE_URL),
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
  });
  return { app, db };
}

const eventCount = async (db: unknown, sid?: string) => {
  const { rows } = sid
    ? await query<{ n: number }>(
        db as never,
        'SELECT COUNT(*) AS n FROM inbound_events WHERE message_sid = $1',
        [sid],
      )
    : await query<{ n: number }>(db as never, 'SELECT COUNT(*) AS n FROM inbound_events');
  return Number(rows[0]?.n ?? 0);
};

const jobCount = async (db: unknown) => {
  const { rows } = await query<{ n: number }>(
    db as never,
    "SELECT COUNT(*) AS n FROM jobs WHERE kind = 'inbound_process'",
  );
  return Number(rows[0]?.n ?? 0);
};

describe('GET /health', () => {
  it('returns { status: "ok" }', async () => {
    const { app } = await setup();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});

describe('POST /webhooks/whatsapp (validation disabled)', () => {
  it('accepts a valid request durably: 200, stored event, enqueued job, no inline send', async () => {
    const { app, db } = await setup();
    const res = await request(app).post(WEBHOOK_PATH).type('form').send(payload('hello'));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/xml/);
    expect(res.text).toBe('<Response></Response>');
    // Durably stored before acknowledging (the worker sends the reply later).
    expect(await eventCount(db, 'SM1234567890abcdef')).toBe(1);
    expect(await jobCount(db)).toBe(1);
  });

  it.each([['1'], ['2'], ['help'], ['gibberish']])('accepts "%s" for later processing', async (body) => {
    const { app, db } = await setup();
    await request(app).post(WEBHOOK_PATH).type('form').send(payload(body, `SM${body}`)).expect(200);
    expect(await eventCount(db, `SM${body}`)).toBe(1);
  });

  it('handles media-only messages (empty Body): stored with empty body', async () => {
    const { app, db } = await setup();
    const { MessageSid, From, To } = payload();
    const noBody = { MessageSid, From, To };
    await request(app).post(WEBHOOK_PATH).type('form').send(noBody).expect(200);
    expect(await eventCount(db, MessageSid)).toBe(1);
  });

  it('rejects a malformed webhook (missing fields) with 400 and stores nothing', async () => {
    const { app, db } = await setup();
    const res = await request(app).post(WEBHOOK_PATH).type('form').send({ Body: 'hello' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_request');
    expect(await eventCount(db)).toBe(0);
    expect(await jobCount(db)).toBe(0);
  });

  it('rejects a sender without the whatsapp: prefix', async () => {
    const { app, db } = await setup();
    const res = await request(app)
      .post(WEBHOOK_PATH)
      .type('form')
      .send({ ...payload(), From: '+919876543210' });

    expect(res.status).toBe(400);
    expect(await eventCount(db)).toBe(0);
  });

  it('rejects an empty request body with 400', async () => {
    const { app } = await setup();
    await request(app).post(WEBHOOK_PATH).expect(400);
  });

  it('a repeated MessageSid is acknowledged once: one event, one job, no reprocessing', async () => {
    const { app, db } = await setup();
    const first = await request(app).post(WEBHOOK_PATH).type('form').send(payload());
    const second = await request(app).post(WEBHOOK_PATH).type('form').send(payload());

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.text).toBe('<Response></Response>');
    expect(await eventCount(db, 'SM1234567890abcdef')).toBe(1);
    expect(await jobCount(db)).toBe(1);
  });

  it('parallel duplicate delivery stores one event and enqueues one job', async () => {
    const { app, db } = await setup();
    const [a, b] = await Promise.all([
      request(app).post(WEBHOOK_PATH).type('form').send(payload('hi', 'SMrace')),
      request(app).post(WEBHOOK_PATH).type('form').send(payload('hi', 'SMrace')),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await eventCount(db, 'SMrace')).toBe(1);
    expect(await jobCount(db)).toBe(1);
  });

  it('returns 404 JSON for unknown routes', async () => {
    const { app } = await setup();
    const res = await request(app).get('/nope');
    expect(res.status).toBe(404);
  });
});

describe('POST /webhooks/whatsapp (signature validation enabled)', () => {
  const sign = (params: Record<string, string>, token = AUTH_TOKEN) =>
    twilio.getExpectedTwilioSignature(token, `${PUBLIC_BASE_URL}${WEBHOOK_PATH}`, params);

  it('accepts a correctly signed request and stores it', async () => {
    const { app, db } = await setup({ validate: true });
    const params = payload();
    const res = await request(app)
      .post(WEBHOOK_PATH)
      .set('X-Twilio-Signature', sign(params))
      .type('form')
      .send(params);

    expect(res.status).toBe(200);
    expect(await eventCount(db, params.MessageSid)).toBe(1);
  });

  it('uses trusted forwarded proto and host when no public base URL is configured', async () => {
    const { app, db } = await setup({ validate: true, publicBaseUrl: null });
    const params = payload('proxy test', 'SMproxy123456789');
    const signature = twilio.getExpectedTwilioSignature(
      AUTH_TOKEN,
      `https://public.example.test${WEBHOOK_PATH}`,
      params,
    );
    const res = await request(app)
      .post(WEBHOOK_PATH)
      .set('X-Forwarded-Proto', 'https')
      .set('X-Forwarded-Host', 'public.example.test')
      .set('X-Twilio-Signature', signature)
      .type('form')
      .send(params);

    expect(res.status).toBe(200);
    expect(await eventCount(db, params.MessageSid)).toBe(1);
    expect(await jobCount(db)).toBe(1);
  });

  it('rejects a request with no signature header (403) and stores nothing', async () => {
    const { app, db } = await setup({ validate: true });
    const res = await request(app).post(WEBHOOK_PATH).type('form').send(payload());

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('invalid_signature');
    expect(await eventCount(db)).toBe(0);
    expect(await jobCount(db)).toBe(0);
  });

  it('rejects an invalid signature (403) and stores nothing', async () => {
    const { app, db } = await setup({ validate: true });
    const res = await request(app)
      .post(WEBHOOK_PATH)
      .set('X-Twilio-Signature', 'definitely-not-valid')
      .type('form')
      .send(payload());

    expect(res.status).toBe(403);
    expect(await eventCount(db)).toBe(0);
  });

  it('rejects a signature made with the wrong auth token', async () => {
    const { app, db } = await setup({ validate: true });
    const params = payload();
    const res = await request(app)
      .post(WEBHOOK_PATH)
      .set('X-Twilio-Signature', sign(params, 'some_other_token'))
      .type('form')
      .send(params);

    expect(res.status).toBe(403);
    expect(await eventCount(db)).toBe(0);
  });

  it('rejects a valid signature if the body was tampered with', async () => {
    const { app, db } = await setup({ validate: true });
    const signature = sign(payload('hello'));
    const res = await request(app)
      .post(WEBHOOK_PATH)
      .set('X-Twilio-Signature', signature)
      .type('form')
      .send(payload('1'));

    expect(res.status).toBe(403);
    expect(await eventCount(db)).toBe(0);
  });
});

describe('TwilioWhatsAppService', () => {
  let create: Mock<TwilioMessagesClient['messages']['create']>;
  let client: TwilioMessagesClient;

  beforeEach(() => {
    create = vi.fn<TwilioMessagesClient['messages']['create']>();
    client = { messages: { create } };
  });

  it('sends via the Twilio client using the configured WhatsApp sender', async () => {
    create.mockResolvedValue({ sid: 'SM999' });
    const service = new TwilioWhatsAppService(client, BOT, silentLogger);

    const result = await service.sendWhatsAppMessage({ to: USER, body: 'hi there' });

    expect(create).toHaveBeenCalledWith({ from: BOT, to: USER, body: 'hi there' });
    expect(result).toEqual({ sid: 'SM999' });
  });

  it('wraps Twilio failures in a TwilioSendError', async () => {
    create.mockRejectedValue(Object.assign(new Error('boom'), { code: 63016, status: 400 }));
    const service = new TwilioWhatsAppService(client, BOT, silentLogger);

    await expect(service.sendWhatsAppMessage({ to: USER, body: 'x' })).rejects.toMatchObject({
      name: 'TwilioSendError',
      status: 502,
    });
  });
});
