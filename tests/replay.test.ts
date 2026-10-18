import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { USER, buildHarness, publishedCourse, ADMIN_KEY } from './helpers';
import { pgFileContext } from './pg.helpers';
import { query } from '../src/db/pg';
import { TwilioSendError } from '../src/errors';
import { SchedulerService, zonedWallToUtcMs } from '../src/services/scheduler.service';

/**
 * Phase 3 Task 5 — dead letters + controlled replay.
 * Org_admin and platform_admin only, org-scoped; every replay/discard is
 * audit-logged; replay re-checks opt-out, pause and course state at replay time.
 */
const pgx = pgFileContext('replay');

const auth = (key: string) => ({ Authorization: `Bearer ${key}` });

async function orgAdminKey(app: unknown, org = 'default', role = 'org_admin'): Promise<string> {
  const res = await request(app as never)
    .post('/admin/users')
    .set(auth(ADMIN_KEY))
    .send({ org, name: `${role}-${org}`, role });
  expect(res.status).toBe(201);
  return res.body.apiKey as string;
}

async function failedNext(h: Awaited<ReturnType<typeof buildHarness>>, sid: string): Promise<number> {
  const orig = h.sender.sendWhatsAppMessage.bind(h.sender);
  h.sender.sendWhatsAppMessage = async () => {
    throw new TwilioSendError(Object.assign(new Error('unsubscribed recipient'), { code: '21610' }));
  };
  await h.say('NEXT', { sid });
  h.sender.sendWhatsAppMessage = orig;
  const rows = (
    await query<{ id: number }>(h.db, `SELECT id FROM dead_letters ORDER BY id DESC LIMIT 1`)
  ).rows;
  return Number(rows[0]?.id ?? 0);
}

describe('dead letters and controlled replay', () => {
  it('lists failures with reasons + counts; instructor forbidden; anonymous denied', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h);
    await h.say('START 1');
    await failedNext(h, 'SMfail-list');

    const key = await orgAdminKey(h.app);
    const list = await request(h.app).get('/admin/failures').set(auth(key));
    expect(list.status).toBe(200);
    expect(list.body.failures).toHaveLength(1);
    expect(list.body.failures[0]).toMatchObject({ kind: 'outbound', reasonCode: '21610', status: 'open' });
    expect(list.body.counts).toContainEqual({ reasonCode: '21610', count: 1 });

    const ins = await orgAdminKey(h.app, 'default', 'instructor');
    expect((await request(h.app).get('/admin/failures').set(auth(ins))).status).toBe(403);
    expect((await request(h.app).get('/admin/failures')).status).toBe(401);
  });

  it('inspects a failure with its attempt chain; unknown ids are 404', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h);
    await h.say('START 1');
    const id = await failedNext(h, 'SMfail-inspect');

    const key = await orgAdminKey(h.app);
    const got = await request(h.app).get(`/admin/failures/${id}`).set(auth(key));
    expect(got.status).toBe(200);
    expect(got.body.failure).toMatchObject({ id, status: 'open' });
    expect(got.body.attempts).toHaveLength(1);
    expect((await request(h.app).get('/admin/failures/99999').set(auth(key))).status).toBe(404);
  });

  it('org scoping: another org sees nothing and cannot touch the failure', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h);
    await h.say('START 1');
    const id = await failedNext(h, 'SMfail-scope');
    await request(h.app).post('/admin/orgs').set(auth(ADMIN_KEY)).send({ slug: 'other', name: 'Other' });
    const otherKey = await orgAdminKey(h.app, 'other');

    const list = await request(h.app).get('/admin/failures').set(auth(otherKey));
    expect(list.status).toBe(200);
    expect(list.body.failures).toHaveLength(0);
    expect((await request(h.app).get(`/admin/failures/${id}`).set(auth(otherKey))).status).toBe(404);
    expect(
      (await request(h.app).post(`/admin/failures/${id}/replay`).set(auth(otherKey)).send({})).status,
    ).toBe(404);
  });

  it('replay creates a new attempt chain and finishes the pending progress (audited)', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h);
    await h.say('START 1');
    const id = await failedNext(h, 'SMfail-replay');
    const key = await orgAdminKey(h.app);

    const replay = await request(h.app).post(`/admin/failures/${id}/replay`).set(auth(key)).send({});
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);

    await h.drain();
    expect((await h.enrollments.find(h.orgId, USER, 1))?.lastDeliveredPosition).toBe(2);
    const attempts = (
      await query<{ n: number }>(
        h.db,
        'SELECT COUNT(*) AS n FROM outbound_attempts WHERE message_id = $1',
        [replay.body.messageId],
      )
    ).rows;
    expect(Number(attempts[0]?.n ?? 0)).toBe(2); // failed attempt + replay attempt, same row

    const audit = await request(h.app).get('/admin/audit').set(auth(ADMIN_KEY));
    const actions = (audit.body.entries ?? audit.body.audit ?? []).map(
      (e: { action: string }) => e.action,
    );
    expect(actions).toContain('failure.replay');
  });

  it('replay respects opt-out at replay time (409, still open, nothing sent)', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h);
    await h.say('START 1');
    const id = await failedNext(h, 'SMfail-optout');
    const key = await orgAdminKey(h.app);
    await h.optOuts.optOut(USER);

    const sentBefore = h.sender.sent.length;
    const replay = await request(h.app).post(`/admin/failures/${id}/replay`).set(auth(key)).send({});
    expect(replay.status).toBe(409);
    await h.drain();
    expect(h.sender.sent.length).toBe(sentBefore);
    const got = await request(h.app).get(`/admin/failures/${id}`).set(auth(key));
    expect(got.body.failure.status).toBe('open');
  });

  it('replay of a scheduled lesson respects pause; resume allows it', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    const course = await publishedCourse(h);
    await h.say('START 1');
    const sched = new SchedulerService(h.db);
    await sched.setCourseSchedule(h.orgId, course.id, {
      kind: 'daily',
      dailyTime: '09:30',
      timezone: 'Asia/Kolkata',
    });
    const now = zonedWallToUtcMs(2026, 6, 15, 9, 30, 'Asia/Kolkata') + 5 * 60_000;
    await sched.tick(now);
    // Fail the scheduled send permanently.
    const orig = h.sender.sendWhatsAppMessage.bind(h.sender);
    h.sender.sendWhatsAppMessage = async () => {
      throw new TwilioSendError(Object.assign(new Error('bad number'), { code: '21211' }));
    };
    await h.drain();
    h.sender.sendWhatsAppMessage = orig;
    const dl = (
      await query<{ id: number }>(h.db, `SELECT id FROM dead_letters ORDER BY id DESC LIMIT 1`)
    ).rows;
    const id = Number(dl[0]?.id ?? 0);
    expect(id).toBeGreaterThan(0);
    const key = await orgAdminKey(h.app);

    await h.say('PAUSE');
    const refused = await request(h.app).post(`/admin/failures/${id}/replay`).set(auth(key)).send({});
    expect(refused.status).toBe(409);

    await h.say('RESUME');
    const replay = await request(h.app).post(`/admin/failures/${id}/replay`).set(auth(key)).send({});
    expect(replay.status).toBe(200);
    await h.drain();
    expect((await h.enrollments.find(h.orgId, USER, course.id))?.lastDeliveredPosition).toBe(2);
  });

  it('discard needs a reason, resolves the failure, and is audited; replay-after-discard is 409', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h);
    await h.say('START 1');
    const id = await failedNext(h, 'SMfail-discard');
    const key = await orgAdminKey(h.app);

    expect(
      (await request(h.app).post(`/admin/failures/${id}/discard`).set(auth(key)).send({})).status,
    ).toBe(400);
    const done = await request(h.app)
      .post(`/admin/failures/${id}/discard`)
      .set(auth(key))
      .send({ reason: 'wrong number, learner re-registered' });
    expect(done.status).toBe(200);
    const got = await request(h.app).get(`/admin/failures/${id}`).set(auth(key));
    expect(got.body.failure.status).toBe('discarded');
    expect(
      (await request(h.app).post(`/admin/failures/${id}/replay`).set(auth(key)).send({})).status,
    ).toBe(409);

    const audit = await request(h.app).get('/admin/audit').set(auth(ADMIN_KEY));
    const actions = (audit.body.entries ?? audit.body.audit ?? []).map(
      (e: { action: string }) => e.action,
    );
    expect(actions).toContain('failure.discard');
  });

  it('inbound terminal failures are visible to platform_admin and replayable', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h);
    const origChatbot = h.processor.chatbot;
    h.processor.chatbot = {
      handleMessage: async () => {
        throw new Error('llm exploded');
      },
    };
    await h.post('NEXT', { sid: 'SMin-fail' });
    for (let i = 0; i < 6; i++) {
      await query(h.db, `UPDATE jobs SET run_at = now(), visible_at = now() WHERE status = 'queued'`);
      await h.drain();
    }
    h.processor.chatbot = origChatbot;
    const dl = (
      await query<{ id: number; kind: string }>(
        h.db,
        `SELECT id, kind FROM dead_letters ORDER BY id DESC LIMIT 1`,
      )
    ).rows;
    expect(dl[0]?.kind).toBe('inbound');

    // Platform sees it; org_admin does not (no org attribution on inbound rows).
    const platform = await request(h.app).get('/admin/failures').set(auth(ADMIN_KEY));
    expect(platform.status).toBe(200);
    expect(platform.body.failures.some((f: { id: number }) => f.id === Number(dl[0]?.id))).toBe(true);
    const key = await orgAdminKey(h.app);
    const orgList = await request(h.app).get('/admin/failures').set(auth(key));
    expect(orgList.body.failures.some((f: { id: number }) => f.id === Number(dl[0]?.id))).toBe(false);

    // Replay re-enqueues; with the bot restored the message processes normally.
    const replay = await request(h.app)
      .post(`/admin/failures/${Number(dl[0]?.id)}/replay`)
      .set(auth(ADMIN_KEY))
      .send({});
    expect(replay.status).toBe(200);
    await h.drain();
    expect(h.sender.sent.length).toBeGreaterThan(0);
  });
});
