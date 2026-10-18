import { describe, expect, it } from 'vitest';
import { buildHarness, publishedCourse, USER, type Harness } from './helpers';
import { pgFileContext } from './pg.helpers';
import { query } from '../src/db/pg';
import { drainJobs } from '../src/worker/processor';

const pgx = pgFileContext('item-sent');

const sentTexts = (h: Harness) => h.sender.sent.map((m) => m.body ?? '');
const itemMarkers = async (h: Harness, messageId: number) =>
  (
    await query<{ item_position: number }>(
      h.db,
      'SELECT item_position FROM outbound_message_items WHERE message_id = $1 ORDER BY item_position',
      [messageId],
    )
  ).rows.map((r) => r.item_position);

const latestOutbound = async (h: Harness) =>
  (
    await query<{ id: number; status: string; attempts: number }>(
      h.db,
      'SELECT id, status, attempts FROM outbound_messages ORDER BY id DESC LIMIT 1',
    )
  ).rows[0];

describe('per-item idempotent retry (A4)', () => {
  it('second of three items fails: retry sends only items 2 and 3, progress advances once', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    const course = await publishedCourse(h, {
      title: 'Three-Item',
      description: '',
      slug: `three-${Date.now()}`,
      lessons: [
        {
          title: 'One',
          items: [
            { kind: 'text', text: 'item one' },
            { kind: 'text', text: 'item two' },
            { kind: 'text', text: 'item three' },
          ],
        },
      ],
    });
    // Active enrollment at position 0, lesson 1 due.
    await query(
      h.db,
      `INSERT INTO enrollments (org_id, user_id, course_id, status, last_delivered_position) VALUES ($1,$2,$3,'active',0)`,
      [h.orgId, USER, course.id],
    );
    const { rows } = await query<{ id: number }>(
      h.db,
      'SELECT id FROM enrollments WHERE user_id = $1 AND course_id = $2',
      [USER, course.id],
    );
    const enrollmentId = rows[0]!.id;

    const { message } = await h.outbound.create({
      idempotencyKey: `item-test-${Date.now()}`,
      orgId: h.orgId,
      userId: USER,
      enrollmentId,
      courseId: course.id,
      lessonPosition: 1,
      kind: 'scheduled_lesson',
      messages: [
        { text: 'item one' },
        { text: 'item two' },
        { text: 'item three' },
      ],
    });
    await h.jobs.enqueue({
      kind: 'outbound_send',
      dedupeKey: `item-job-${message.id}`,
      refType: 'outbound_messages',
      refId: message.id,
      payload: {
        messageId: message.id,
        progressAction: {
          type: 'advance',
          orgId: h.orgId,
          enrollmentId,
          from: 0,
          to: 1,
          isFinal: false,
        },
      },
    });

    // Fail on the second item send (call index 1 within this drain).
    let call = 0;
    h.sender.failIf = () => {
      const i = call++;
      return i === 1;
    };
    await drainJobs(h.processor, 10);
    h.sender.failIf = undefined;

    const out = await latestOutbound(h);
    expect(out!.status).toBe('failed');
    expect(out!.attempts).toBe(1);
    // Only item 1 (index 0) has a marker; item 2 (index 1) does not.
    expect(await itemMarkers(h, out!.id)).toEqual([0]);
    expect(sentTexts(h)).toEqual(['item one']);

    // Retry: requeue the failed job and drain. Only items 2 and 3 sent.
    const { rows: jobs } = await query<{ id: number }>(
      h.db,
      "SELECT id FROM jobs WHERE kind = 'outbound_send' AND ref_id = $1 ORDER BY id DESC LIMIT 1",
      [out!.id],
    );
    await query(h.db, `UPDATE jobs SET run_at = now(), visible_at = now() WHERE id = $1`, [jobs[0]!.id]);
    await drainJobs(h.processor, 10);

    const after = sentTexts(h).slice(1); // skip 'item one'
    expect(after).toEqual(['item two', 'item three']);
    expect((await h.enrollments.find(h.orgId, USER, 1))?.lastDeliveredPosition).toBe(1);
    const finalOut = await latestOutbound(h);
    expect(finalOut!.status).toBe('sent');
    expect(await itemMarkers(h, out!.id)).toEqual([0, 1, 2]);
  });
});
