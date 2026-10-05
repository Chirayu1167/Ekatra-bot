import request from 'supertest';
import twilio from 'twilio';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createApp } from '../src/app';
import { Chatbot, REPLIES, type MessageHandler } from '../src/bot/chatbot';
import { silentLogger } from '../src/logger';
import type { IdempotencyStore } from '../src/services/idempotency';
import {
  TwilioWhatsAppService,
  type TwilioMessagesClient,
  type WhatsAppSender,
} from '../src/services/whatsapp.service';

const AUTH_TOKEN = 'test_auth_token';
const PUBLIC_BASE_URL = 'https://example.test';
const WEBHOOK_PATH = '/webhooks/whatsapp';
const USER = 'whatsapp:+919876543210';
const BOT = 'whatsapp:+14155238886';

const payload = (body = 'hello') => ({
  MessageSid: 'SM1234567890abcdef',
  From: USER,
  To: BOT,
  Body: body,
});

function setup(
  overrides: {
    validate?: boolean;
    chatbot?: MessageHandler;
    sender?: WhatsAppSender;
    idempotency?: IdempotencyStore;
  } = {},
) {
  const sender: WhatsAppSender = overrides.sender ?? {
    sendWhatsAppMessage: vi.fn().mockResolvedValue({ sid: 'SMreply' }),
  };
  const app = createApp({
    env: {
      TWILIO_AUTH_TOKEN: AUTH_TOKEN,
      TWILIO_WEBHOOK_VALIDATE: overrides.validate ?? false,
      PUBLIC_BASE_URL,
    },
    chatbot: overrides.chatbot ?? new Chatbot(),
    sender,
    ...(overrides.idempotency && { idempotency: overrides.idempotency }),
    logger: silentLogger,
  });
  return { app, sender, send: sender.sendWhatsAppMessage as ReturnType<typeof vi.fn> };
}

describe('GET /health', () => {
  it('returns { status: "ok" }', async () => {
    const { app } = setup();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});

describe('POST /webhooks/whatsapp (validation disabled)', () => {
  it('handles a valid request: replies to the sender with the chatbot response', async () => {
    const { app, send } = setup();
    const res = await request(app).post(WEBHOOK_PATH).type('form').send(payload('hello'));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/xml/);
    expect(res.text).toBe('<Response></Response>');
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({ to: USER, body: REPLIES.greeting });
  });

  it.each([
    ['1', REPLIES.startLearning],
    ['2', REPLIES.help],
    ['help', REPLIES.help],
    ['gibberish', REPLIES.fallback],
  ])('routes "%s" through the chatbot', async (body, expected) => {
    const { app, send } = setup();
    await request(app).post(WEBHOOK_PATH).type('form').send(payload(body)).expect(200);
    expect(send).toHaveBeenCalledWith({ to: USER, body: expected });
  });

  it('handles media-only messages (empty Body) with the fallback', async () => {
    const { app, send } = setup();
    const { MessageSid, From, To } = payload();
    const noBody = { MessageSid, From, To };
    await request(app).post(WEBHOOK_PATH).type('form').send(noBody).expect(200);
    expect(send).toHaveBeenCalledWith({ to: USER, body: REPLIES.fallback });
  });

  it('passes user, text and MessageSid to the chatbot', async () => {
    const chatbot = { handleMessage: vi.fn().mockResolvedValue({ text: 'ok' }) };
    const { app } = setup({ chatbot });
    await request(app).post(WEBHOOK_PATH).type('form').send(payload('hi')).expect(200);
    expect(chatbot.handleMessage).toHaveBeenCalledWith({
      userId: USER,
      text: 'hi',
      messageId: 'SM1234567890abcdef',
    });
  });

  it('rejects a malformed webhook (missing fields) with 400 and does nothing else', async () => {
    const chatbot = { handleMessage: vi.fn() };
    const { app, send } = setup({ chatbot });
    const res = await request(app).post(WEBHOOK_PATH).type('form').send({ Body: 'hello' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_request');
    expect(chatbot.handleMessage).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects a sender without the whatsapp: prefix', async () => {
    const { app, send } = setup();
    const res = await request(app)
      .post(WEBHOOK_PATH)
      .type('form')
      .send({ ...payload(), From: '+919876543210' });
    expect(res.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects an empty request body with 400', async () => {
    const { app } = setup();
    await request(app).post(WEBHOOK_PATH).expect(400);
  });

  it('returns 500 with a generic message when the chatbot throws, and sends nothing', async () => {
    const chatbot = {
      handleMessage: vi.fn().mockRejectedValue(new Error('secret internal detail')),
    };
    const { app, send } = setup({ chatbot });
    const res = await request(app).post(WEBHOOK_PATH).type('form').send(payload());

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('chatbot_error');
    expect(JSON.stringify(res.body)).not.toContain('secret internal detail');
    expect(send).not.toHaveBeenCalled();
  });

  it('returns 502 without leaking details when the Twilio send fails', async () => {
    const failingClient: TwilioMessagesClient = {
      messages: {
        create: vi.fn().mockRejectedValue(new Error('Twilio exploded: token abc123')),
      },
    };
    const sender = new TwilioWhatsAppService(failingClient, BOT, silentLogger);
    const { app } = setup({ sender });
    const res = await request(app).post(WEBHOOK_PATH).type('form').send(payload());

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('twilio_send_failed');
    expect(JSON.stringify(res.body)).not.toContain('abc123');
  });

  it('skips duplicate MessageSids when the idempotency store reports a duplicate', async () => {
    const idempotency = { claim: vi.fn().mockResolvedValue(false) };
    const chatbot = { handleMessage: vi.fn() };
    const { app, send } = setup({ idempotency, chatbot });
    const res = await request(app).post(WEBHOOK_PATH).type('form').send(payload());

    expect(res.status).toBe(200);
    expect(idempotency.claim).toHaveBeenCalledWith('SM1234567890abcdef');
    expect(chatbot.handleMessage).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('returns 404 JSON for unknown routes', async () => {
    const { app } = setup();
    const res = await request(app).get('/nope');
    expect(res.status).toBe(404);
  });
});

describe('POST /webhooks/whatsapp (signature validation enabled)', () => {
  const sign = (params: Record<string, string>, token = AUTH_TOKEN) =>
    twilio.getExpectedTwilioSignature(token, `${PUBLIC_BASE_URL}${WEBHOOK_PATH}`, params);

  it('accepts a correctly signed request', async () => {
    const { app, send } = setup({ validate: true });
    const params = payload();
    const res = await request(app)
      .post(WEBHOOK_PATH)
      .set('X-Twilio-Signature', sign(params))
      .type('form')
      .send(params);

    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledOnce();
  });

  it('rejects a request with no signature header (403) and runs no chatbot logic', async () => {
    const chatbot = { handleMessage: vi.fn() };
    const { app, send } = setup({ validate: true, chatbot });
    const res = await request(app).post(WEBHOOK_PATH).type('form').send(payload());

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('invalid_signature');
    expect(chatbot.handleMessage).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects an invalid signature (403)', async () => {
    const chatbot = { handleMessage: vi.fn() };
    const { app, send } = setup({ validate: true, chatbot });
    const res = await request(app)
      .post(WEBHOOK_PATH)
      .set('X-Twilio-Signature', 'definitely-not-valid')
      .type('form')
      .send(payload());

    expect(res.status).toBe(403);
    expect(chatbot.handleMessage).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects a signature made with the wrong auth token', async () => {
    const { app, send } = setup({ validate: true });
    const params = payload();
    const res = await request(app)
      .post(WEBHOOK_PATH)
      .set('X-Twilio-Signature', sign(params, 'some_other_token'))
      .type('form')
      .send(params);

    expect(res.status).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects a valid signature if the body was tampered with', async () => {
    const { app, send } = setup({ validate: true });
    const signature = sign(payload('hello'));
    const res = await request(app)
      .post(WEBHOOK_PATH)
      .set('X-Twilio-Signature', signature)
      .type('form')
      .send(payload('1'));

    expect(res.status).toBe(403);
    expect(send).not.toHaveBeenCalled();
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
