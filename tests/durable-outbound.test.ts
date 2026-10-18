import { describe, expect, it } from 'vitest';
import request from 'supertest';
import twilio from 'twilio';
import { createApp } from '../src/app';
import { silentLogger } from '../src/logger';
import { ADMIN_KEY, USER, buildHarness, publishedCourse, type Harness } from './helpers';
import { pgFileContext, resetDb } from './pg.helpers';
import { query } from '../src/db/pg';
import { TwilioSendError } from '../src/errors';
import { EnrollmentService } from '../src/services/enrollment.service';
import { LearnerService } from '../src/services/learner.service';
import { CertificateService } from '../src/services/certificate.service';
import { InboundEventService } from '../src/services/inboundEvents.service';
import { JobService } from '../src/services/jobs.service';
import { OutboundService } from '../src/services/outbound.service';

/**
 * Phase 3 Task 3 — durable outbound (failure/negative tests).
 * All sends go through outbound_messages + attempts; progress commits only
 * after a confirmed send; permanent errors dead-letter immediately; uncertain
 * outcomes park for reconcile and are never blindly resent.
 */
const pgx = pgFileContext('durable-outbound');

const forceDue = (h: Harness) =>
  query(h.db, `UPDATE jobs SET run_at = now(), visible_at = now() WHERE status = 'queued'`);

const latestOutbound = async (h: Harness) =>
  (
    await query<{ id: number; status: string; attempts: number; error_code: string | null }>(
      h.db,
      'SELECT id, status, attempts, error_code FROM outbound_messages ORDER BY id DESC LIMIT 1',
    )
  ).rows[0];

const attemptRows = async (h: Harness, messageId: number) =>
  (
    await query<{ status: string }>(
      h.db,
      'SELECT status FROM outbound_attempts WHERE message_id = $1 ORDER BY attempt_no',
      [messageId],
    )
  ).rows.map((r) => r.status);

const deadLetters = async (h: Harness) =>
  (await query<{ reason_code: string; status: string }>(h.db, 'SELECT reason_code, status FROM dead_letters'))
    .rows;

describe('durable outbound', () => {
  it('fail twice then succeed: backoff retries deliver once and advance once', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h);
    await h.say('START 1');
    const base = h.sender.calls;
    h.sender.failIf = (_m, i) => i === base || i === base + 1;

    const accepted = await h.say('NEXT', { sid: 'SMflaky' });
    expect(accepted.res.status).toBe(200);
    expect((await h.enrollments.find(h.orgId, USER, 1))?.lastDeliveredPosition).toBe(1);
    expect((await latestOutbound(h))?.status).toBe('failed');

    h.sender.failIf = undefined;
    await forceDue(h);
    await h.drain();
    const out = await latestOutbound(h);
    expect(out?.status).toBe('sent');
    expect(out?.attempts).toBe(2);
    expect(await attemptRows(h, out!.id)).toEqual(['failed', 'sent']);
    expect((await h.enrollments.find(h.orgId, USER, 1))?.lastDeliveredPosition).toBe(2);
  });

  it('permanent error (unsubscribed) is not retried: one attempt, dead letter with reason', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h);
    await h.say('START 1');
    const callsBefore = h.sender.calls;
    h.sender.sendWhatsAppMessage = async () => {
      throw new TwilioSendError(Object.assign(new Error('unsubscribed recipient'), { code: '21610' }));
    };

    await h.say('NEXT', { sid: 'SMperm' });
    const out = await latestOutbound(h);
    expect(out?.status).toBe('dead_letter');
    expect(out?.attempts).toBe(1);
    expect(out?.error_code).toBe('21610');
    expect((await h.enrollments.find(h.orgId, USER, 1))?.lastDeliveredPosition).toBe(1); // never success
    const dl = await deadLetters(h);
    expect(dl).toHaveLength(1);
    expect(dl[0]?.status).toBe('open');

    // No retry ever: draining changes nothing and sends nothing more.
    await forceDue(h);
    await h.drain();
    expect((await latestOutbound(h))?.attempts).toBe(1);
    expect(h.sender.calls).toBe(callsBefore); // overridden sender bypasses the counter
  });

  it('24h-window template rejection is a permanent, visible failure (never retried endlessly)', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h);
    await h.say('START 1');
    h.sender.sendWhatsAppMessage = async () => {
      throw new TwilioSendError(
        Object.assign(new Error('template required outside the 24-hour window'), { code: '63016' }),
      );
    };

    await h.say('NEXT', { sid: 'SMtemplate' });
    const out = await latestOutbound(h);
    expect(out?.status).toBe('dead_letter');
    expect(out?.error_code).toBe('63016');
    await forceDue(h);
    await h.drain();
    expect((await latestOutbound(h))?.attempts).toBe(1);
  });

  it('retry cap leads to dead letter with the reason preserved', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h);
    await h.say('START 1');
    h.sender.failIf = () => true; // always transiently failing
    const callsBefore = h.sender.calls;

    await h.say('NEXT', { sid: 'SMcap' });
    for (let i = 0; i < 6; i++) {
      await forceDue(h);
      await h.drain();
    }
    const out = await latestOutbound(h);
    expect(out?.status).toBe('dead_letter');
    expect(out?.attempts).toBe(6);
    expect(h.sender.calls - callsBefore).toBe(6); // one send attempt per retry, then stop
    const dl = await deadLetters(h);
    expect(dl).toHaveLength(1);

    // Draining past the cap sends nothing more.
    await forceDue(h);
    await h.drain();
    expect(h.sender.calls - callsBefore).toBe(6);
    expect((await h.enrollments.find(h.orgId, USER, 1))?.lastDeliveredPosition).toBe(1);
  });

  it('retries a failed progress action without resending, dead-letters it, and replay applies it', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h);
    await h.say('START 1');
    const originalAdvance = h.enrollments.advance.bind(h.enrollments);
    h.enrollments.advance = async () => {
      throw new Error('injected progress update failure');
    };
    const sentBefore = h.sender.sent.length;

    await h.post('NEXT', { sid: 'SMaction-retry' });
    const deliveredCount = h.sender.sent.length - sentBefore;
    expect(deliveredCount).toBeGreaterThan(0);
    for (let attempt = 0; attempt < 6; attempt++) {
      await forceDue(h);
      await h.drain();
    }

    expect(h.sender.sent.length - sentBefore).toBe(deliveredCount);
    expect((await h.enrollments.find(h.orgId, USER, 1))?.lastDeliveredPosition).toBe(1);
    const event = await h.inbound.getBySid('SMaction-retry');
    expect(event?.status).toBe('failed');
    const failures = await query<{ id: number; payload: Record<string, unknown> }>(
      h.db,
      `SELECT id, payload FROM dead_letters
       WHERE kind = 'outbound' AND reason_code = 'progress_action_failed'`,
    );
    expect(failures.rows).toHaveLength(1);
    expect(failures.rows[0]?.payload).toMatchObject({
      inboundMessageSid: 'SMaction-retry',
      action: { type: 'advance', from: 1, to: 2 },
    });

    h.enrollments.advance = originalAdvance;
    const replay = await request(h.app)
      .post(`/admin/failures/${failures.rows[0]!.id}/replay`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({});
    expect(replay.status).toBe(200);
    await h.drain();
    expect((await h.enrollments.find(h.orgId, USER, 1))?.lastDeliveredPosition).toBe(2);
    expect(h.sender.sent.length - sentBefore).toBe(deliveredCount);
  });

  it('uncertain outcome (timeout) is parked, never blindly resent, and reconciles via callback', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h);
    await h.say('START 1');
    h.sender.sendWhatsAppMessage = async () => {
      throw new TwilioSendError(new Error('request timed out after 15000ms'));
    };
    const callsBefore = h.sender.calls;

    await h.say('NEXT', { sid: 'SMunknown' });
    const out = await latestOutbound(h);
    expect(out?.status).toBe('unknown');
    expect((await h.enrollments.find(h.orgId, USER, 1))?.lastDeliveredPosition).toBe(1);

    // Draining never resends an unknown message.
    await forceDue(h);
    await h.drain();
    expect((await latestOutbound(h))?.status).toBe('unknown');
    expect(h.sender.calls).toBe(callsBefore);

    // The sid is learned via a Twilio lookup (operator/runbook step); the
    // provider later confirms delivery through the signed status callback.
    await query(h.db, 'UPDATE outbound_messages SET twilio_sid = $1 WHERE id = $2', ['SMunk1', out!.id]);
    const cb = await h.postCallback('SMunk1', 'delivered');
    expect(cb.status).toBe(200);
    expect((await latestOutbound(h))?.status).toBe('delivered');
    // The pending progress action ran exactly once upon reconcile.
    expect((await h.enrollments.find(h.orgId, USER, 1))?.lastDeliveredPosition).toBe(2);
    const dl = await deadLetters(h);
    expect(dl[0]?.status).toBe('replayed');

    // Re-applying the same callback is a no-op (deduped by state).
    const again = await h.postCallback('SMunk1', 'delivered');
    expect(again.status).toBe(200);
    expect((await h.enrollments.find(h.orgId, USER, 1))?.lastDeliveredPosition).toBe(2);
  });

  it('delivery status never regresses: delivered cannot go back to sent', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h);
    await h.say('START 1');
    await h.say('NEXT', { sid: 'SMregress' });
    const out = await latestOutbound(h);
    await query(h.db, 'UPDATE outbound_messages SET twilio_sid = $1 WHERE id = $2', ['SMreg1', out!.id]);

    expect((await h.postCallback('SMreg1', 'delivered')).status).toBe(200);
    expect((await latestOutbound(h))?.status).toBe('delivered');
    expect((await h.postCallback('SMreg1', 'sent')).status).toBe(200);
    expect((await latestOutbound(h))?.status).toBe('delivered');
  });

  it('a failed send is never recorded as success', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h);
    await h.say('START 1');
    h.sender.failAll = true;
    await h.say('NEXT', { sid: 'SMnosuccess' });
    const out = await latestOutbound(h);
    expect(out?.status).not.toBe('sent');
    expect(out?.status).not.toBe('delivered');
    expect((await h.enrollments.find(h.orgId, USER, 1))?.lastDeliveredPosition).toBe(1);
  });
});

describe('status callbacks are signed, deduped and monotonic', () => {
  const AUTH_TOKEN = 'test_auth_token';
  const PUBLIC_BASE_URL = 'https://example.test';
  const PATH = '/webhooks/whatsapp/status';

  async function signedSetup() {
    await resetDb(pgx.pool);
    const db = pgx.pool;
    const enrollments = new EnrollmentService(db);
    const learners = new LearnerService(db);
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
          certificates: new CertificateService(db, learners, 'test-secret-test-secret'),
        },
        logger: silentLogger,
      },
      logger: silentLogger,
    });
    return { app, db, outbound: new OutboundService(db) };
  }

  const sign = (params: Record<string, string>) =>
    twilio.getExpectedTwilioSignature(AUTH_TOKEN, `${PUBLIC_BASE_URL}${PATH}`, params);

  it('accepts a signed callback and applies it; rejects tampered/unsigned ones with 403', async () => {
    const { app, db, outbound } = await signedSetup();
    const created = await outbound.create({
      idempotencyKey: 'cb-test-1',
      userId: USER,
      kind: 'reply',
      messages: [{ text: 'hi' }],
    });
    const id = created.message.id;
    await query(db, 'UPDATE outbound_messages SET twilio_sid = $1, status = $2 WHERE id = $3', [
      'SMcb1',
      'sent',
      id,
    ]);

    const params = { MessageSid: 'SMcb1', MessageStatus: 'delivered' };
    const ok = await request(app)
      .post(PATH)
      .set('X-Twilio-Signature', sign(params))
      .type('form')
      .send(params);
    expect(ok.status).toBe(200);
    expect((await outbound.getById(id))?.status).toBe('delivered');

    // Same callback twice: deduped by state (still delivered, no extra attempt rows).
    const attemptsBefore = (
      await query<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM outbound_attempts')
    ).rows[0]?.n;
    const dup = await request(app)
      .post(PATH)
      .set('X-Twilio-Signature', sign(params))
      .type('form')
      .send(params);
    expect(dup.status).toBe(200);
    expect(
      (await query<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM outbound_attempts')).rows[0]?.n,
    ).toBe(Number(attemptsBefore ?? 0));

    // Unsigned / tampered: 403 and nothing changes.
    const noSig = await request(app).post(PATH).type('form').send(params);
    expect(noSig.status).toBe(403);
    const tampered = await request(app)
      .post(PATH)
      .set('X-Twilio-Signature', 'bogus')
      .type('form')
      .send(params);
    expect(tampered.status).toBe(403);
    expect((await outbound.getById(id))?.status).toBe('delivered');
  });

  it('unknown sids and unknown statuses are acknowledged without effect', async () => {
    const { app, db } = await signedSetup();
    const params = { MessageSid: 'SMnope', MessageStatus: 'delivered' };
    const res = await request(app)
      .post(PATH)
      .set('X-Twilio-Signature', sign(params))
      .type('form')
      .send(params);
    expect(res.status).toBe(200);
    expect(
      Number((await query<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM outbound_messages')).rows[0]?.n ?? 0),
    ).toBe(0);
  });
});
