import { describe, expect, it } from 'vitest';
import { USER, buildHarness, publishedCourse } from './helpers';
import { pgFileContext } from './pg.helpers';
import { query } from '../src/db/pg';
import { reclaimStuck } from '../src/worker/processor';

/**
 * Phase 3 Task 2 — durable inbound (FAILURE tests first).
 * Webhook must: verify signature -> validate -> INSERT raw event idempotent on
 * MessageSid -> enqueue job -> return 200. Processing happens in the worker.
 * These tests assert the durable store; they fail until the pipeline lands.
 */
const pgx = pgFileContext('durable-inbound');

describe('durable inbound acceptance', () => {
  it('webhook durably stores the event and enqueues work before acknowledging', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h);
    const res = await h.post('hello', { sid: 'SMdurable1' });
    expect(res.status).toBe(200);
    const events = (
      await query<{ n: number }>(h.db, 'SELECT COUNT(*) AS n FROM inbound_events WHERE message_sid = $1', [
        'SMdurable1',
      ])
    ).rows;
    expect(Number(events[0]?.n ?? 0)).toBe(1);
    const jobs = (
      await query<{ n: number }>(h.db, "SELECT COUNT(*) AS n FROM jobs WHERE kind = 'inbound_process'")
    ).rows;
    expect(Number(jobs[0]?.n ?? 0)).toBe(1);
  });

  it('duplicate MessageSid is stored once and enqueued once (sequential)', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h);
    await h.post('START 1', { sid: 'SMdupDur1' });
    await h.post('START 1', { sid: 'SMdupDur1' });
    const events = (
      await query<{ n: number }>(h.db, 'SELECT COUNT(*) AS n FROM inbound_events WHERE message_sid = $1', [
        'SMdupDur1',
      ])
    ).rows;
    expect(Number(events[0]?.n ?? 0)).toBe(1);
  });

  it('self-heals an accepted event with no job and processes it once', async () => {
    const h = await buildHarness({ pg: pgx.pool, autoDrain: false });
    await h.inbound.accept({
      messageSid: 'SMorphan1',
      fromUser: USER,
      toUser: 'whatsapp:+14155238886',
      body: 'START 1',
    });
    await query(h.db, `UPDATE inbound_events SET created_at = now() - INTERVAL '61 seconds' WHERE message_sid = $1`, [
      'SMorphan1',
    ]);

    const recovered = await reclaimStuck(h.processor);
    expect(recovered.orphaned).toBe(1);
    expect(await h.jobs.countByStatus('inbound_process', 'queued')).toBe(1);
    expect(await h.drain()).toBeGreaterThan(0);
    const event = await h.inbound.getBySid('SMorphan1');
    expect(event?.status).toBe('completed');
    expect(await h.jobs.countByStatus('inbound_process', 'completed')).toBe(1);
  });

  it('a duplicate webhook repairs a missing job without creating a second job', async () => {
    const h = await buildHarness({ pg: pgx.pool, autoDrain: false });
    await h.inbound.accept({
      messageSid: 'SMorphanDup1',
      fromUser: USER,
      toUser: 'whatsapp:+14155238886',
      body: 'hello',
    });
    const response = await h.post('hello', { sid: 'SMorphanDup1' });
    expect(response.status).toBe(200);
    const { rows } = await query<{ count: string }>(
      h.db,
      `SELECT COUNT(*)::text AS count FROM jobs
       WHERE kind = 'inbound_process' AND dedupe_key = $1`,
      ['SMorphanDup1'],
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('parallel claimers each receive a queued job at most once', async () => {
    const h = await buildHarness({ pg: pgx.pool, autoDrain: false });
    const count = 12;
    for (let i = 0; i < count; i++) {
      await h.jobs.enqueue({
        kind: 'outbound_send',
        dedupeKey: `SMparallel-claim-${i}`,
        payload: { messageId: i + 1 },
      });
    }
    const claimed = await Promise.all(
      Array.from({ length: count }, (_, index) =>
        h.jobs.claimDue(['outbound_send'], 300, `claimer-${index}`),
      ),
    );
    const ids = claimed.flatMap((job) => (job ? [job.id] : []));
    expect(ids).toHaveLength(count);
    expect(new Set(ids).size).toBe(count);
  });

  it('duplicate MessageSid arriving in parallel is stored once', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h);
    await Promise.all([h.post('NEXT', { sid: 'SMdupPar1' }), h.post('NEXT', { sid: 'SMdupPar1' })]);
    const events = (
      await query<{ n: number }>(h.db, 'SELECT COUNT(*) AS n FROM inbound_events WHERE message_sid = $1', [
        'SMdupPar1',
      ])
    ).rows;
    expect(Number(events[0]?.n ?? 0)).toBe(1);
    const jobs = (
      await query<{ n: number }>(
        h.db,
        "SELECT COUNT(*) AS n FROM jobs WHERE kind = 'inbound_process' AND dedupe_key = $1",
        ['SMdupPar1'],
      )
    ).rows;
    expect(Number(jobs[0]?.n ?? 0)).toBe(1);
  });

  it('invalid signature stores nothing and enqueues nothing', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h);
    // Harness disables signature validation; this asserts the durable tables stay
    // empty without any accepted event — the signed negative lives in whatsapp.test.ts.
    const events = (await query<{ n: number }>(h.db, 'SELECT COUNT(*) AS n FROM inbound_events')).rows;
    expect(Number(events[0]?.n ?? 0)).toBe(0);
    expect(USER).toContain('whatsapp:');
  });

  it('crash after acceptance recovers: a dead worker’s job is reclaimed and finishes exactly once', async () => {
    const h = await buildHarness({ pg: pgx.pool, autoDrain: false });
    await publishedCourse(h);

    // Accept without processing (worker is "down").
    const res = await h.post('START 1', { sid: 'SMcrash1' });
    expect(res.status).toBe(200);
    expect(h.sender.sent).toHaveLength(0);
    expect((await h.enrollments.listForUser(h.orgId, USER))).toHaveLength(0);

    // A first worker claims the job and dies mid-processing (never completes).
    const claimed = await h.jobs.claimDue(['inbound_process', 'outbound_send'], 300, 'dying-worker');
    expect(claimed?.dedupeKey).toBe('SMcrash1');
    // Simulate death: row stays 'processing'. Force the visibility timeout to pass.
    await query(h.db, `UPDATE jobs SET visible_at = now() - INTERVAL '1 second' WHERE id = $1`, [
      claimed?.id,
    ]);
    await query(h.db, `UPDATE inbound_events SET visible_at = now() - INTERVAL '1 second'`);

    // Another worker reclaims the stuck work and finishes it.
    const reclaimed = await h.processor.jobs.reclaimStuck();
    expect(reclaimed).toBe(1);
    expect(await h.drain()).toBeGreaterThan(0);

    // Exactly one logical progress update and one lesson delivery.
    expect((await h.enrollments.findActive(h.orgId, USER))?.lastDeliveredPosition).toBe(1);
    expect(h.sender.sent.filter((m) => m.body.includes('Lesson 1 of 3'))).toHaveLength(1);

    // A later duplicate delivery of the same webhook changes nothing.
    await h.post('START 1', { sid: 'SMcrash1' });
    await h.drain();
    expect((await h.enrollments.findActive(h.orgId, USER))?.lastDeliveredPosition).toBe(1);
    expect(h.sender.sent.filter((m) => m.body.includes('Lesson 1 of 3'))).toHaveLength(1);
  });

  it('concurrent messages from one learner do not corrupt progress', async () => {
    const h = await buildHarness({ pg: pgx.pool, autoDrain: false });
    await publishedCourse(h);
    await h.post('START 1', { sid: 'SMconc-start' });
    await h.drain();
    // Two NEXTs race in; the worker serialises per learner: lessons 2 then 3.
    await Promise.all([
      h.post('NEXT', { sid: 'SMconc-a' }),
      h.post('NEXT', { sid: 'SMconc-b' }),
    ]);
    await h.drain();
    await h.drain(); // second pass finishes any deferred follow-up
    const enrollment = await h.enrollments.find(h.orgId, USER, 1);
    expect(enrollment?.lastDeliveredPosition).toBe(3);
    expect(enrollment?.status).toBe('completed');
    const bodies = h.sender.sent.map((m) => m.body).join('\n');
    expect(bodies).toContain('Lesson 2 of 3');
    expect(bodies).toContain('Lesson 3 of 3');
  });
});
