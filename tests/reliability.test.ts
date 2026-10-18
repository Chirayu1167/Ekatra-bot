import { describe, expect, it } from 'vitest';
import { USER, buildHarness, publishedCourse, type Harness } from './helpers';
import { pgFileContext } from './pg.helpers';
import { query } from '../src/db/pg';

const pgx = pgFileContext('reliability');

const lessonCount = (h: Harness, needle: string) =>
  h.sender.sent.filter((m) => m.body.includes(needle)).length;

describe('duplicate webhooks', () => {
  it('a repeated MessageSid is acknowledged but not processed again', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h);
    await h.say('START 1');

    const first = await h.say('NEXT', { sid: 'SMdup1' });
    const sentAfterFirst = h.sender.sent.length;
    const second = await h.say('NEXT', { sid: 'SMdup1' });

    expect(first.res.status).toBe(200);
    expect(second.res.status).toBe(200);
    expect(second.res.text).toBe('<Response></Response>');
    expect(second.messages).toHaveLength(0);
    expect(h.sender.sent.length).toBe(sentAfterFirst);
    expect((await h.enrollments.find(h.orgId, USER, 1))?.lastDeliveredPosition).toBe(2);
    expect(lessonCount(h, 'Lesson 2 of 3')).toBe(1);
  });

  it('a duplicate START does not enrol twice or resend the course', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h);
    await h.say('START 1', { sid: 'SMdupStart' });
    const sent = h.sender.sent.length;
    await h.say('START 1', { sid: 'SMdupStart' });
    expect(h.sender.sent.length).toBe(sent);
    const n = (await query<{ n: number }>(h.db, 'SELECT COUNT(*) AS n FROM enrollments')).rows;
    expect(Number(n[0]?.n ?? 0)).toBe(1);
  });

  it('the same MessageSid arriving concurrently is processed exactly once', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h);
    await h.say('START 1');
    h.sender.delayMs = 5;
    await Promise.all([h.post('NEXT', { sid: 'SMrace' }), h.post('NEXT', { sid: 'SMrace' })]);
    expect(lessonCount(h, 'Lesson 2 of 3')).toBe(1);
    expect((await h.enrollments.find(h.orgId, USER, 1))?.lastDeliveredPosition).toBe(2);
  });

  it('quiz explanation is delivered once across duplicate webhooks and an outbound retry', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    const course = await h.courses.createCourse(h.orgId, {
      title: 'Explained quiz',
      description: '',
      slug: 'explained-quiz',
      lessons: [
        {
          title: 'Quiz',
          items: [
            {
              kind: 'quiz',
              caption: 'Pick B.',
              explanation: 'This feedback is delivered once.',
              options: [{ label: 'A' }, { label: 'B', correct: true }],
            },
          ],
        },
        { title: 'Next', items: [{ kind: 'text', text: 'Next lesson.' }] },
      ],
    });
    await h.courses.publish(h.orgId, course.id);
    await h.say('START explained-quiz');

    h.sender.failAll = true;
    const accepted = await h.say('B', { sid: 'SMquiz-feedback-retry' });
    expect(accepted.res.status).toBe(200);
    expect((await h.enrollments.find(h.orgId, USER, course.id))?.lastDeliveredPosition).toBe(1);

    const sentBeforeRedelivery = h.sender.sent.length;
    const duplicate = await h.say('B', { sid: 'SMquiz-feedback-retry' });
    expect(duplicate.res.status).toBe(200);
    expect(duplicate.messages).toHaveLength(0);

    h.sender.failAll = false;
    await query(h.db, `UPDATE jobs SET run_at = now(), visible_at = now() WHERE status = 'queued'`);
    await h.drain();
    const delivered = h.sender.sent.slice(sentBeforeRedelivery);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.body).toContain('This feedback is delivered once.');
    expect(delivered[0]?.body.match(/This feedback is delivered once\./g)).toHaveLength(1);
    expect((await h.enrollments.find(h.orgId, USER, course.id))?.lastDeliveredPosition).toBe(1);
  });
});

describe('concurrent commands from one learner', () => {
  it('with the per-learner lock, two NEXTs deliver lessons 2 then 3 — in order, none repeated or skipped', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h);
    await h.say('START 1');
    h.sender.delayMs = 5;
    const before = h.sender.sent.length;

    await Promise.all([h.post('NEXT'), h.post('NEXT')]);

    const bodies = h.sender.sent.slice(before).map((m) => m.body);
    const idx2 = bodies.findIndex((b) => b.includes('Lesson 2 of 3'));
    const idx3 = bodies.findIndex((b) => b.includes('Lesson 3 of 3'));
    expect(idx2).toBeGreaterThanOrEqual(0);
    expect(idx3).toBeGreaterThan(idx2);
    // lesson 2's last message must be sent before lesson 3 starts (no interleaving)
    const lastOfLesson2 = bodies.findIndex((b) => b.includes('Reply *NEXT* for lesson 3 of 3'));
    expect(lastOfLesson2).toBeLessThan(idx3);
    expect(bodies.filter((b) => b.includes('Lesson 2 of 3'))).toHaveLength(1);
    expect(bodies.filter((b) => b.includes('Lesson 3 of 3'))).toHaveLength(1);
    expect((await h.enrollments.find(h.orgId, USER, 1))).toMatchObject({
      status: 'completed',
      lastDeliveredPosition: 3,
    });
  });

  it('even WITHOUT the lock, progress is never corrupted (compare-and-set): a lesson may repeat but none is skipped', async () => {
    const h = await buildHarness({ pg: pgx.pool, locks: false });
    await publishedCourse(h);
    await h.say('START 1');
    h.sender.delayMs = 5;
    const [ra, rb] = await Promise.all([h.post('NEXT'), h.post('NEXT')]);
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);

    // Only two outcomes are possible, both valid: the requests overlapped (both saw
    // position 1, lesson 2 delivered twice, exactly one advance) or sequenced (the second
    // saw position 2 and legitimately delivered lesson 3). Never a skip, never a double
    // advance of the same step: the compare-and-set forbids it even across instances.
    const pos = (await h.enrollments.find(h.orgId, USER, 1))?.lastDeliveredPosition;
    if (pos === 2) {
      expect(lessonCount(h, 'Lesson 2 of 3')).toBe(2);
      expect(lessonCount(h, 'Lesson 3 of 3')).toBe(0);
    } else {
      expect(pos).toBe(3);
      expect(lessonCount(h, 'Lesson 2 of 3')).toBe(1);
      expect(lessonCount(h, 'Lesson 3 of 3')).toBe(1);
    }
  });
});

describe('send failures never skip a lesson', () => {
  // Lesson 2 is 5 messages: [0] text, [1] caption, [2] image, [3] PDF, [4] footer.
  // Media messages have a fallback (see "unavailable media"), so fail on TEXT messages here.
  // Durable contract (Phase 3): the webhook ACCEPTS (200) after storing the event; the
  // worker's send failure leaves progress untouched and schedules a retry. A forced-due
  // drain stands in for the passage of backoff time.
  const forceDue = (h: Harness) =>
    query(h.db, `UPDATE jobs SET run_at = now(), visible_at = now() WHERE status = 'queued'`);
  const outboundStatus = async (h: Harness) =>
    (
      await query<{ status: string; attempts: number }>(
        h.db,
        'SELECT status, attempts FROM outbound_messages ORDER BY id DESC LIMIT 1',
      )
    ).rows[0];

  it.each([
    ['an early text message', 1],
    ['the very last message', 4],
  ])(
    'when %s fails: webhook still 200, progress unchanged, retry delivers exactly once',
    async (_label, failAt) => {
      const h = await buildHarness({ pg: pgx.pool });
      await publishedCourse(h);
      await h.say('START 1');
      const base = h.sender.calls;
      h.sender.failIf = (_m, i) => i === base + failAt;

      const accepted = await h.say('NEXT', { sid: 'SMretry' });
      expect(accepted.res.status).toBe(200); // accepted durably; the failure is the worker's
      expect((await h.enrollments.find(h.orgId, USER, 1))?.lastDeliveredPosition).toBe(1); // NOT advanced
      expect((await outboundStatus(h))?.status).toBe('failed');

      // A Twilio-style redelivery of the same MessageSid is a duplicate: no new work.
      h.sender.failIf = undefined;
      const redelivery = await h.say('NEXT', { sid: 'SMretry' });
      expect(redelivery.res.status).toBe(200);
      expect(redelivery.messages).toHaveLength(0);

      // The scheduled retry (backoff passed) delivers the whole lesson once.
      await forceDue(h);
      await h.drain();
      expect((await h.enrollments.find(h.orgId, USER, 1))?.lastDeliveredPosition).toBe(2);
      // A4: per-item sent markers prevent re-sending already-delivered items.
      // Item 0 (header "Lesson 2 of 3") was sent in the first attempt and is NOT re-sent;
      // the retry continues from item 1, delivering items 1-4 once each.
      // Progress advances exactly once (position 1 -> 2); lesson 3 not started.
      expect(lessonCount(h, 'Lesson 2 of 3')).toBe(1);
      expect(lessonCount(h, 'Lesson 3 of 3')).toBe(0);
    },
  );

  it('A4: retry sends only unsent items (item 2 fails; items 2-3 retried, item 1 never repeated)', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    const course = await h.courses.createCourse(h.orgId, {
      title: 'ThreeItem',
      description: '',
      slug: 'three-item',
      lessons: [
        { title: 'One', items: [{ kind: 'text', text: 'Text of lesson one.' }] },
        { title: 'Two', items: [
          { kind: 'text', text: 'Text of item one.' },
          { kind: 'text', text: 'Text of item two.' },
          { kind: 'text', text: 'Text of item three.' },
        ] },
        { title: 'Three', items: [{ kind: 'text', text: 'Text of lesson three.' }] },
      ],
    });
    await h.courses.publish(h.orgId, course.id);
    await query(h.db, `INSERT INTO enrollments (org_id, user_id, course_id, status, last_delivered_position) VALUES ($1,$2,$3,'active',1)`, [h.orgId, USER, course.id]);

    const base = h.sender.calls;
    // Fail on item index 1 (second text item: "Text of item two.").
    h.sender.failIf = (_m, i) => i === base + 1;

    const accepted = await h.say('NEXT', { sid: 'SM3item' });
    expect(accepted.res.status).toBe(200);
    expect((await h.enrollments.find(h.orgId, USER, 1))?.lastDeliveredPosition).toBe(1);

    h.sender.failIf = undefined;
    const redelivery = await h.say('NEXT', { sid: 'SM3item' });
    expect(redelivery.res.status).toBe(200);
    expect(redelivery.messages).toHaveLength(0);

    await forceDue(h);
    await h.drain();

    expect((await h.enrollments.find(h.orgId, USER, 1))?.lastDeliveredPosition).toBe(2);
    // Item 0 ("Text of item one.") sent once in first attempt, never repeated.
    expect(h.sender.sent.filter((m) => m.body.includes('Text of item one.'))).toHaveLength(1);
    // Items 1 ("Text of item two.") and 2 ("Text of item three.") sent once each in retry.
    expect(h.sender.sent.filter((m) => m.body.includes('Text of item two.'))).toHaveLength(1);
    expect(h.sender.sent.filter((m) => m.body.includes('Text of item three.'))).toHaveLength(1);
  });

  it('a failed START leaves no enrolment behind until the retry succeeds', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h);
    h.sender.failIf = () => true;
    const accepted = await h.say('START 1');
    expect(accepted.res.status).toBe(200);
    expect((await h.enrollments.listForUser(h.orgId, USER))).toHaveLength(0);

    h.sender.failIf = undefined;
    await forceDue(h);
    await h.drain();
    expect((await h.enrollments.findActive(h.orgId, USER))?.lastDeliveredPosition).toBe(1);
  });

  it('a failed final lesson does not complete the course until the retry succeeds', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h);
    await h.say('START 1');
    await h.say('NEXT');
    h.sender.failIf = () => true;
    expect((await h.say('NEXT')).res.status).toBe(200);
    expect((await h.enrollments.find(h.orgId, USER, 1))).toMatchObject({
      status: 'active',
      lastDeliveredPosition: 2,
      completedAt: null,
    });

    h.sender.failIf = undefined;
    await forceDue(h);
    await h.drain();
    expect((await h.enrollments.find(h.orgId, USER, 1))?.status).toBe('completed');
  });
});

describe('unavailable media', () => {
  it('a rejected attachment becomes a text fallback with the link; the lesson still completes', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h);
    await h.say('START 1');
    h.sender.failIf = (m) => Boolean(m.mediaUrl); // Twilio rejects every media message

    const r = await h.say('NEXT');
    expect(r.res.status).toBe(200);
    expect(r.messages.some((m) => m.mediaUrl)).toBe(false);
    expect(r.all).toContain("couldn't send this attachment");
    expect(r.all).toContain('https://cdn.example.test/pic.png');
    expect(r.all).toContain('https://cdn.example.test/notes.pdf');
    expect(r.texts.at(-1)).toContain('Reply *NEXT* for lesson 3 of 3');
    expect((await h.enrollments.find(h.orgId, USER, 1))?.lastDeliveredPosition).toBe(2);
  });

  it('if even the fallback cannot be sent, nothing is recorded', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h);
    await h.say('START 1');
    h.sender.failIf = (m) => Boolean(m.mediaUrl) || m.body.includes("couldn't send");
    const r = await h.say('NEXT');
    expect(r.res.status).toBe(200); // accepted; the worker records the failure, not the webhook
    expect((await h.enrollments.find(h.orgId, USER, 1))?.lastDeliveredPosition).toBe(1);
  });
});

describe('restarts', () => {
  it('progress, pause state, completion and webhook de-duplication survive a restart', async () => {
    await buildHarness({ pg: pgx.pool }); // reset to pristine

    // --- first run
    const h1 = await buildHarness({ pg: pgx.pool, pgFresh: false });
    await publishedCourse(h1);
    await h1.say('START 1');
    await h1.say('NEXT', { sid: 'SMbeforeRestart' });
    await h1.say('PAUSE');

    // --- second run: brand-new app, services and connections on the same database
    const p2 = pgx.freshPool();
    const h2 = await buildHarness({ pg: p2, pgFresh: false });

    expect((await h2.say('PROGRESS')).all).toContain('2 of 3 lessons');
    expect((await h2.say('NEXT')).all).toContain('paused'); // still paused
    await h2.say('RESUME');

    // a retry of a pre-restart webhook is still recognised as a duplicate
    const dup = await h2.say('NEXT', { sid: 'SMbeforeRestart' });
    expect(dup.messages).toHaveLength(0);

    const last = await h2.say('NEXT');
    expect(last.all).toContain('Lesson 3 of 3'); // resumes at lesson 3, not 1 or 2
    expect(last.all).not.toContain('Lesson 2 of 3');
    await p2.end();

    // --- third run: completion persists
    const p3 = pgx.freshPool();
    const h3 = await buildHarness({ pg: p3, pgFresh: false });
    expect((await h3.say('NEXT')).all).toContain("You've completed *Alpha*");
    expect(((await h3.enrollments.find(h3.orgId, USER, 1)))?.status).toBe('completed');
    await p3.end();
  });
});
