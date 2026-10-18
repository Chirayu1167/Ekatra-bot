import { describe, expect, it } from 'vitest';
import { buildHarness, publishedCourse, USER, type Harness } from './helpers';
import { pgFileContext } from './pg.helpers';
import { query } from '../src/db/pg';

const pgx = pgFileContext('schedule-template');

const forceWindow = async (db: Harness['db'], closed: boolean) => {
  if (closed) {
    // No recent inbound: any historical event is older than 24h.
    await query(
      db,
      `INSERT INTO inbound_events (message_sid, from_user, to_user, body, raw, created_at, updated_at, visible_at)
       VALUES ('SMold', $1, 'whatsapp:+14155238886', 'old', '{}', now() - interval '30 hours', now() - interval '30 hours', now() - interval '30 hours')`,
      [USER],
    );
  } else {
    await query(
      db,
      `INSERT INTO inbound_events (message_sid, from_user, to_user, body, raw, created_at, updated_at, visible_at)
       VALUES ('SMnew', $1, 'whatsapp:+14155238886', 'hi', '{}', now(), now(), now())`,
      [USER],
    );
  }
};

const enqueueScheduledLesson = async (h: Harness, enrollmentId: number, courseId: number, position: number) => {
  await h.jobs.enqueue({
    kind: 'outbound_send',
    dedupeKey: `sched:${enrollmentId}:slot:${position}`,
    refType: 'enrollments',
    refId: enrollmentId,
    payload: {
      scheduledLesson: {
        enrollmentId,
        orgId: h.orgId,
        courseId,
        userId: USER,
        position,
        isFinal: false,
        slotKey: `slot:${position}`,
        timezone: 'Asia/Kolkata',
      },
    },
  });
};

const positionOf = async (h: Harness, courseId: number) =>
  Number(
    (
      await query<{ last_delivered_position: number }>(
        h.db,
        'SELECT last_delivered_position FROM enrollments WHERE user_id = $1 AND course_id = $2',
        [USER, courseId],
      )
    ).rows[0]?.last_delivered_position ?? 0,
  );

const sentBodies = (h: Harness) => h.sender.sent.map((m) => m.body ?? '');
const hasTemplate = (h: Harness) => h.sender.sent.some((m) => Boolean(m.contentSid));
const lessonTwoSent = (h: Harness) => sentBodies(h).some((b) => b.includes('Text of lesson two.'));

describe('scheduled lessons outside the 24-hour window (A1)', () => {
  it('window open: sends the lesson normally and advances progress', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    const course = await publishedCourse(h);
    await query(h.db, `INSERT INTO enrollments (org_id, user_id, course_id, status, last_delivered_position) VALUES ($1, $2, $3, 'active', 1)`, [h.orgId, USER, course.id]);
    const { rows } = await query<{ id: number }>(h.db, 'SELECT id FROM enrollments WHERE user_id = $1 AND course_id = $2', [USER, course.id]);
    const enrollmentId = rows[0]!.id;

    await forceWindow(h.db, false); // recent inbound => window open
    await enqueueScheduledLesson(h, enrollmentId, course.id, 2);
    await h.drain();

    expect(hasTemplate(h)).toBe(false); // a real lesson, not a template
    expect(h.sender.sent.length).toBeGreaterThan(0);
    expect(lessonTwoSent(h)).toBe(true);
    expect(await positionOf(h, course.id)).toBe(2); // progress advanced
  });

  it('window closed with template: sends the template only, no progress advance', async () => {
    const h = await buildHarness({ pg: pgx.pool, templateSid: 'HX' + 'a'.repeat(32) });
    const course = await publishedCourse(h);
    await query(h.db, `INSERT INTO enrollments (org_id, user_id, course_id, status, last_delivered_position) VALUES ($1, $2, $3, 'active', 1)`, [h.orgId, USER, course.id]);
    const { rows } = await query<{ id: number }>(h.db, 'SELECT id FROM enrollments WHERE user_id = $1 AND course_id = $2', [USER, course.id]);
    const enrollmentId = rows[0]!.id;

    await forceWindow(h.db, true); // window closed
    await enqueueScheduledLesson(h, enrollmentId, course.id, 2);
    await h.drain();

    expect(h.sender.sent.length).toBe(1); // only the template
    expect(hasTemplate(h)).toBe(true);
    expect(h.sender.sent[0]!.contentSid).toBeTruthy();
    expect(lessonTwoSent(h)).toBe(false);
    expect(await positionOf(h, course.id)).toBe(1); // no advance
  });

  it('window closed without template: visible permanent failure (dead letter)', async () => {
    const h = await buildHarness({ pg: pgx.pool }); // no templateSid
    const course = await publishedCourse(h);
    await query(h.db, `INSERT INTO enrollments (org_id, user_id, course_id, status, last_delivered_position) VALUES ($1, $2, $3, 'active', 1)`, [h.orgId, USER, course.id]);
    const { rows } = await query<{ id: number }>(h.db, 'SELECT id FROM enrollments WHERE user_id = $1 AND course_id = $2', [USER, course.id]);
    const enrollmentId = rows[0]!.id;

    await forceWindow(h.db, true); // window closed
    await enqueueScheduledLesson(h, enrollmentId, course.id, 2);
    await h.drain();

    expect(h.sender.sent).toHaveLength(0); // nothing sent
    const out = (
      await query<{ status: string; error_code: string | null }>(
        h.db,
        'SELECT status, error_code FROM outbound_messages WHERE user_id = $1 ORDER BY id DESC LIMIT 1',
        [USER],
      )
    ).rows[0]!;
    expect(out.status).toBe('dead_letter');
    expect(out.error_code).toBe('template_required');
    const dl = await query<{ reason_code: string }>(h.db, "SELECT reason_code FROM dead_letters WHERE reason_code = 'template_required'");
    expect(dl.rows).toHaveLength(1);
    expect(await positionOf(h, course.id)).toBe(1);
  });

  it('reply after template delivers the lesson exactly once', async () => {
    const h = await buildHarness({ pg: pgx.pool, templateSid: 'HX' + 'a'.repeat(32) });
    const course = await publishedCourse(h);
    await query(h.db, `INSERT INTO enrollments (org_id, user_id, course_id, status, last_delivered_position) VALUES ($1, $2, $3, 'active', 1)`, [h.orgId, USER, course.id]);
    const { rows } = await query<{ id: number }>(h.db, 'SELECT id FROM enrollments WHERE user_id = $1 AND course_id = $2', [USER, course.id]);
    const enrollmentId = rows[0]!.id;

    await forceWindow(h.db, true);
    await enqueueScheduledLesson(h, enrollmentId, course.id, 2);
    await h.drain();
    expect(hasTemplate(h)).toBe(true);
    const templatesBefore = h.sender.sent.filter((m) => Boolean(m.contentSid)).length;
    expect(await positionOf(h, course.id)).toBe(1);

    const res = await h.say('NEXT'); // learner taps the template button / sends NEXT
    expect(res.res.status).toBe(200);
    expect(await positionOf(h, course.id)).toBe(2); // lesson delivered, advanced once
    // Exactly one template total (the reply delivered the lesson, not another template).
    expect(h.sender.sent.filter((m) => Boolean(m.contentSid)).length).toBe(templatesBefore);
    expect(lessonTwoSent(h)).toBe(true);
  });

  it('opted-out learner never receives the template', async () => {
    const h = await buildHarness({ pg: pgx.pool, templateSid: 'HX' + 'a'.repeat(32) });
    await h.optOuts.optOut(USER);
    const course = await publishedCourse(h);
    await query(h.db, `INSERT INTO enrollments (org_id, user_id, course_id, status, last_delivered_position) VALUES ($1, $2, $3, 'active', 1)`, [h.orgId, USER, course.id]);
    const { rows } = await query<{ id: number }>(h.db, 'SELECT id FROM enrollments WHERE user_id = $1 AND course_id = $2', [USER, course.id]);
    const enrollmentId = rows[0]!.id;

    await forceWindow(h.db, true);
    await enqueueScheduledLesson(h, enrollmentId, course.id, 2);
    await h.drain();

    expect(h.sender.sent).toHaveLength(0); // opted out: silent
    const count = await query<{ n: number }>(h.db, 'SELECT COUNT(*) AS n FROM outbound_messages WHERE user_id = $1', [USER]);
    expect(Number(count.rows[0]?.n ?? 0)).toBe(0);
  });
});
