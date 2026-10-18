import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { USER, buildHarness, publishedCourse, ADMIN_KEY } from './helpers';
import { pgFileContext } from './pg.helpers';
import { query } from '../src/db/pg';
import {
  SchedulerService,
  evaluateDue,
  wallParts,
  zonedWallToUtcMs,
  type EffectiveSchedule,
} from '../src/services/scheduler.service';

/**
 * Phase 3 Task 4 — scheduler acceptance.
 * 09:30 means 09:30 in the learner's timezone, never UTC. Catch-up sends at
 * most ONE missed lesson per enrollment per tick; expired windows are consumed
 * without sending (grace default 6h).
 */
const pgx = pgFileContext('scheduler');

const daily = (timezone: string, dailyTime: string): EffectiveSchedule => ({
  timezone,
  dailyTime,
  slots: [],
});

// 2026-06-15T04:00:00Z == 09:30 IST (UTC+5:30, no DST).
const MONDAY_0930_IST = Date.UTC(2026, 5, 15, 4, 0, 0);

describe('evaluateDue (pure timezone logic)', () => {
  it('09:30 fires at 09:30 IST, not at 09:30 UTC', () => {
    const due = evaluateDue(MONDAY_0930_IST, daily('Asia/Kolkata', '09:30'), null, 6);
    expect(due.action).toBe('send');
    if (due.action === 'send') expect(due.slot.slotKey).toBe('2026-06-15T09:30');

    // Same instant: 04:00 UTC and 21:00 (prev day) in Los Angeles — not due.
    expect(evaluateDue(MONDAY_0930_IST, daily('UTC', '09:30'), null, 6).action).toBe('none');
    expect(evaluateDue(MONDAY_0930_IST, daily('America/Los_Angeles', '09:30'), null, 6).action).toBe(
      'none',
    );
  });

  it('09:30 UTC and 09:30 America/Los_Angeles each fire in their own zone', () => {
    // 09:30 UTC.
    const atUtc = Date.UTC(2026, 5, 15, 9, 30, 0);
    expect(evaluateDue(atUtc, daily('UTC', '09:30'), null, 6).action).toBe('send');
    // Los Angeles is at 02:30 (future slot) — not due.
    expect(evaluateDue(atUtc, daily('America/Los_Angeles', '09:30'), null, 6).action).toBe('none');
    // Kolkata's 09:30 slot is 5.5h old here: still inside grace, so it also
    // sends — grace windows legitimately overlap across zones.
    expect(evaluateDue(atUtc, daily('Asia/Kolkata', '09:30'), null, 6).action).toBe('send');

    // 09:30 PDT (UTC-7 in June) = 16:30Z.
    const atLa = Date.UTC(2026, 5, 15, 16, 30, 0);
    const due = evaluateDue(atLa, daily('America/Los_Angeles', '09:30'), null, 6);
    expect(due.action).toBe('send');
    if (due.action === 'send') expect(due.slot.slotKey).toBe('2026-06-15T09:30');
  });

  it('a DST spring-forward day still fires 09:30 (and the gap hour never crashes)', () => {
    // America/Los_Angeles springs forward on 2026-03-08 (02:00 -> 03:00).
    const morning = Date.UTC(2026, 2, 8, 16, 35, 0); // 09:35 PDT
    expect(evaluateDue(morning, daily('America/Los_Angeles', '09:30'), null, 6).action).toBe('send');
    // A schedule inside the nonexistent hour resolves deterministically (no throw, one slot max).
    const gap = evaluateDue(morning, daily('America/Los_Angeles', '02:30'), null, 6);
    expect(['send', 'skip', 'none']).toContain(gap.action);
    // The day after is normal again.
    const next = Date.UTC(2026, 2, 9, 16, 35, 0);
    expect(evaluateDue(next, daily('America/Los_Angeles', '09:30'), null, 6).action).toBe('send');
  });

  it('date boundaries: 00:15 IST fires at 18:45Z the previous UTC day', () => {
    // 2026-06-14T18:50:00Z == 2026-06-15 00:20 IST.
    const now = Date.UTC(2026, 5, 14, 18, 50, 0);
    const due = evaluateDue(now, daily('Asia/Kolkata', '00:15'), null, 6);
    expect(due.action).toBe('send');
    if (due.action === 'send') expect(due.slot.slotKey).toBe('2026-06-15T00:15');
    // Same instant in UTC: 18:50, far from 00:15.
    expect(evaluateDue(now, daily('UTC', '00:15'), null, 6).action).toBe('none');
  });

  it('slots past the grace window are skipped (consumed, not sent)', () => {
    const slot = zonedWallToUtcMs(2026, 6, 15, 9, 30, 'Asia/Kolkata');
    // 7h later: window (6h) fully passed. The cursor sits on the previous
    // day's slot, so the expired slot is consumed forward without sending.
    const late = evaluateDue(
      slot + 7 * 3600_000,
      daily('Asia/Kolkata', '09:30'),
      '2026-06-14T09:30',
      6,
    );
    expect(late.action).toBe('skip');
    if (late.action === 'skip') expect(late.consumeUpTo).toBe('2026-06-15T09:30');
    // 5h59m later: still inside grace.
    expect(evaluateDue(slot + (6 * 3600 - 60) * 1000, daily('Asia/Kolkata', '09:30'), null, 6).action).toBe(
      'send',
    );
  });

  it('an already-consumed slot never refires; custom slots match their weekday', () => {
    expect(evaluateDue(MONDAY_0930_IST, daily('Asia/Kolkata', '09:30'), '2026-06-15T09:30', 6).action).toBe(
      'none',
    );
    const dow = wallParts(MONDAY_0930_IST, 'Asia/Kolkata').dow;
    const custom: EffectiveSchedule = {
      timezone: 'Asia/Kolkata',
      dailyTime: null,
      slots: [{ dow, time: '09:30' }],
    };
    expect(evaluateDue(MONDAY_0930_IST, custom, null, 6).action).toBe('send');
    const other: EffectiveSchedule = {
      timezone: 'Asia/Kolkata',
      dailyTime: null,
      slots: [{ dow: (dow + 1) % 7, time: '09:30' }],
    };
    expect(evaluateDue(MONDAY_0930_IST, other, null, 6).action).toBe('none');
  });

  it('daily + custom at the same wall time collapse to one slot (no double send)', () => {
    const dow = wallParts(MONDAY_0930_IST, 'Asia/Kolkata').dow;
    const both: EffectiveSchedule = {
      timezone: 'Asia/Kolkata',
      dailyTime: '09:30',
      slots: [{ dow, time: '09:30' }],
    };
    // Custom wins when present; either way exactly one send verdict, one key.
    const due = evaluateDue(MONDAY_0930_IST, both, null, 6);
    expect(due.action).toBe('send');
    if (due.action === 'send') expect(due.slot.slotKey).toBe('2026-06-15T09:30');
  });
});

describe('scheduler tick (integration)', () => {
  async function scheduledHarness(dailyTime = '09:30', timezone = 'Asia/Kolkata') {
    const h = await buildHarness({ pg: pgx.pool });
    const course = await publishedCourse(h);
    await h.say('START 1'); // active, position 1 of 3
    const sched = new SchedulerService(h.db);
    await sched.setCourseSchedule(h.orgId, course.id, { kind: 'daily', dailyTime, timezone });
    return { h, sched, course };
  }

  const nowAt = (y: number, mo: number, d: number, hh: number, mm: number, tz: string) =>
    zonedWallToUtcMs(y, mo, d, hh, mm, tz) + 5 * 60_000; // 5 minutes into the window

  it('a due enrollment gets exactly one lesson per tick (idempotent slot = one job)', async () => {
    const { h, sched } = await scheduledHarness();
    const r = await sched.tick(nowAt(2026, 6, 15, 9, 30, 'Asia/Kolkata'));
    expect(r.led).toBe(true);
    expect(r.enqueued).toBe(1);
    // Same tick again (or a racing tick): nothing more — the slot is claimed.
    const r2 = await sched.tick(nowAt(2026, 6, 15, 9, 30, 'Asia/Kolkata'));
    expect(r2.enqueued).toBe(0);

    await h.drain();
    expect((await h.enrollments.find(h.orgId, USER, 1))?.lastDeliveredPosition).toBe(2);
    expect(h.sender.sent.some((m) => m.body.includes('Lesson 2 of 3'))).toBe(true);
  });

  it('two schedulers racing never create duplicate jobs', async () => {
    const { h, sched } = await scheduledHarness();
    const now = nowAt(2026, 6, 15, 9, 30, 'Asia/Kolkata');
    const [a, b] = await Promise.all([sched.tick(now), sched.tick(now)]);
    expect(a.enqueued + b.enqueued).toBe(1);
    const jobs = (
      await query<{ n: number }>(
        h.db,
        "SELECT COUNT(*) AS n FROM jobs WHERE kind = 'outbound_send' AND dedupe_key LIKE 'sched:%'",
      )
    ).rows;
    expect(Number(jobs[0]?.n ?? 0)).toBe(1);
    await h.drain();
    expect((await h.enrollments.find(h.orgId, USER, 1))?.lastDeliveredPosition).toBe(2);
  });

  it('releases the two-key scheduler advisory lock after each tick', async () => {
    const { h, sched } = await scheduledHarness();
    await sched.tick(nowAt(2026, 6, 15, 9, 30, 'Asia/Kolkata'));
    const locks = await query<{ count: string }>(
      h.db,
      `SELECT COUNT(*)::text AS count FROM pg_locks
       WHERE locktype = 'advisory' AND classid = $1::oid
         AND objid = hashtext($2)::oid AND granted`,
      [2, 'ekatra_scheduler_tick'],
    );
    expect(locks.rows[0]?.count).toBe('0');
  });

  it('rolls back a claimed schedule slot when inserting its job fails', async () => {
    const { h, sched } = await scheduledHarness();
    const enrollment = await h.enrollments.findActive(h.orgId, USER);
    expect(enrollment).toBeDefined();
    await query(h.db, 'DROP TRIGGER IF EXISTS fail_scheduled_job_insert ON jobs');
    await query(h.db, 'DROP FUNCTION IF EXISTS fail_scheduled_job_insert()');
    await query(
      h.db,
      `CREATE FUNCTION fail_scheduled_job_insert() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.dedupe_key LIKE 'sched:%' THEN RAISE EXCEPTION 'injected schedule insert failure'; END IF;
         RETURN NEW;
       END $$`,
    );
    await query(
      h.db,
      `CREATE TRIGGER fail_scheduled_job_insert BEFORE INSERT ON jobs
       FOR EACH ROW EXECUTE FUNCTION fail_scheduled_job_insert()`,
    );
    const now = nowAt(2026, 6, 15, 9, 30, 'Asia/Kolkata');
    try {
      await expect(sched.tick(now)).rejects.toThrow('injected schedule insert failure');
      const beforeRetry = await query<{ last_slot_key: string | null }>(
        h.db,
        'SELECT last_slot_key FROM enrollment_schedules WHERE enrollment_id = $1',
        [enrollment!.id],
      );
      expect(beforeRetry.rows[0]?.last_slot_key ?? null).toBeNull();
    } finally {
      await query(h.db, 'DROP TRIGGER IF EXISTS fail_scheduled_job_insert ON jobs');
      await query(h.db, 'DROP FUNCTION IF EXISTS fail_scheduled_job_insert()');
    }

    const retry = await sched.tick(now);
    expect(retry.enqueued).toBe(1);
    const jobs = await query<{ count: string }>(
      h.db,
      "SELECT COUNT(*)::text AS count FROM jobs WHERE kind = 'outbound_send' AND dedupe_key LIKE 'sched:%'",
    );
    expect(jobs.rows[0]?.count).toBe('1');
  });

  it('restart catch-up: expired windows are consumed, at most one lesson is sent', async () => {
    const { h, sched } = await scheduledHarness();
    // Three days of downtime, ticking outside any grace window (09:30 + 6.5h):
    // every window long past grace -> consumed, nothing sent.
    const r = await sched.tick(nowAt(2026, 6, 18, 16, 0, 'Asia/Kolkata'));
    expect(r.enqueued).toBe(0);
    await h.drain();
    expect((await h.enrollments.find(h.orgId, USER, 1))?.lastDeliveredPosition).toBe(1);
    expect(h.sender.sent).toHaveLength(2); // only START 1's intro + lesson 1
    // Next morning back in-window: exactly ONE lesson goes out (no burst for the missed days).
    const r2 = await sched.tick(nowAt(2026, 6, 19, 9, 35, 'Asia/Kolkata'));
    expect(r2.enqueued).toBe(1);
    await h.drain();
    expect((await h.enrollments.find(h.orgId, USER, 1))?.lastDeliveredPosition).toBe(2);
  });

  it('paused, opted-out, completed and unpublished learners are never sent scheduled lessons', async () => {
    // paused
    {
      const { h, sched } = await scheduledHarness();
      await h.say('PAUSE');
      const r = await sched.tick(nowAt(2026, 6, 15, 9, 30, 'Asia/Kolkata'));
      expect(r.enqueued).toBe(0);
    }
    // opted out
    {
      const { h, sched } = await scheduledHarness();
      await h.optOuts.optOut(USER);
      const r = await sched.tick(nowAt(2026, 6, 15, 9, 30, 'Asia/Kolkata'));
      expect(r.enqueued).toBe(0);
      await h.drain();
      expect((await h.enrollments.find(h.orgId, USER, 1))?.lastDeliveredPosition).toBe(1);
    }
    // completed
    {
      const { h, sched } = await scheduledHarness();
      await h.say('NEXT');
      await h.say('NEXT');
      expect((await h.enrollments.find(h.orgId, USER, 1))?.status).toBe('completed');
      const r = await sched.tick(nowAt(2026, 6, 15, 9, 30, 'Asia/Kolkata'));
      expect(r.enqueued).toBe(0);
    }
    // unpublished course
    {
      const { h, sched, course } = await scheduledHarness();
      await h.courses.unpublish(h.orgId, course.id);
      const r = await sched.tick(nowAt(2026, 6, 15, 9, 30, 'Asia/Kolkata'));
      expect(r.enqueued).toBe(0);
    }
  });

  it('NEXT still works for scheduled learners (self-paced preserved)', async () => {
    const { h } = await scheduledHarness();
    const r = await h.say('NEXT');
    expect(r.res.status).toBe(200);
    expect((await h.enrollments.find(h.orgId, USER, 1))?.lastDeliveredPosition).toBe(2);
  });

  it('enrollment custom schedule overrides the course daily (precedence)', async () => {
    const { h, sched, course } = await scheduledHarness('09:35', 'Asia/Kolkata');
    const enrollment = (await h.enrollments.find(h.orgId, USER, course.id))!;
    const dow = wallParts(nowAt(2026, 6, 15, 9, 30, 'Asia/Kolkata'), 'Asia/Kolkata').dow;
    // Enrollment custom slot later today: the due course slot must NOT fire through it.
    await sched.setEnrollmentSchedule(h.orgId, enrollment.id, {
      timezone: 'Asia/Kolkata',
      slots: [{ dow, time: '10:30' }],
    });
    const now = nowAt(2026, 6, 15, 9, 36, 'Asia/Kolkata'); // course 09:35 due, enrollment 10:30 not
    const r = await sched.tick(now);
    expect(r.enqueued).toBe(0);
    // …but at 10:31 the enrollment slot fires exactly once.
    const r2 = await sched.tick(nowAt(2026, 6, 15, 10, 30, 'Asia/Kolkata'));
    expect(r2.enqueued).toBe(1);
    await h.drain();
    expect((await h.enrollments.find(h.orgId, USER, course.id))?.lastDeliveredPosition).toBe(2);
  });
});

describe('schedule admin API', () => {
  const auth = (key: string) => ({ Authorization: `Bearer ${key}` });

  it('course schedules and enrollment/defaults are restricted to management roles', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    const course = await publishedCourse(h);

    // org_admin key.
    const userRes = await request(h.app)
      .post('/admin/users')
      .set(auth(ADMIN_KEY))
      .send({ org: 'default', name: 'Asha', role: 'org_admin' });
    expect(userRes.status).toBe(201);
    const orgAdminKey = userRes.body.apiKey as string;

    // Instructor key.
    const insRes = await request(h.app)
      .post('/admin/users')
      .set(auth(ADMIN_KEY))
      .send({ org: 'default', name: 'Dev', role: 'instructor' });
    const instructorKey = insRes.body.apiKey as string;

    // Course schedule: org_admin sets daily.
    const put = await request(h.app)
      .put(`/admin/courses/${course.id}/schedule`)
      .set(auth(orgAdminKey))
      .send({ kind: 'daily', dailyTime: '09:30', timezone: 'Asia/Kolkata' });
    expect(put.status).toBe(200);
    expect(put.body.schedule.daily_time).toBe('09:30');

    // Instructor course access is read/write for course content only, not schedules.
    const instructorPut = await request(h.app)
      .put(`/admin/courses/${course.id}/schedule`)
      .set(auth(instructorKey))
      .send({ kind: 'custom', slots: [{ dow: 1, time: '10:00' }], timezone: 'UTC' });
    expect(instructorPut.status).toBe(403);
    expect((await request(h.app).get(`/admin/courses/${course.id}/schedule`).set(auth(instructorKey))).status).toBe(403);

    const got = await request(h.app)
      .get(`/admin/courses/${course.id}/schedule`)
      .set(auth(orgAdminKey));
    expect(got.status).toBe(200);
    expect(got.body.schedule.kind).toBe('daily');

    // Validation: bad time / bad timezone / bad course.
    expect(
      (
        await request(h.app)
          .put(`/admin/courses/${course.id}/schedule`)
          .set(auth(orgAdminKey))
          .send({ kind: 'daily', dailyTime: '25:00' })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(h.app)
          .put(`/admin/courses/${course.id}/schedule`)
          .set(auth(orgAdminKey))
          .send({ kind: 'daily', dailyTime: '09:30', timezone: 'Mars/Olympus' })
      ).status,
    ).toBe(400);
    expect(
      (await request(h.app).get('/admin/courses/9999/schedule').set(auth(orgAdminKey))).status,
    ).toBe(404);

    // Enrollment schedule: org_admin ok, instructor forbidden (403).
    await h.say('START 1');
    const enrollment = (await h.enrollments.find(h.orgId, USER, course.id))!;
    const es = await request(h.app)
      .put(`/admin/enrollments/${enrollment.id}/schedule`)
      .set(auth(orgAdminKey))
      .send({ timezone: 'UTC', dailyTime: '08:00', enabled: true });
    expect(es.status).toBe(200);
    expect(es.body.schedule.timezone).toBe('UTC');
    expect(
      (
        await request(h.app)
          .put(`/admin/enrollments/${enrollment.id}/schedule`)
          .set(auth(instructorKey))
          .send({ timezone: 'UTC' })
      ).status,
    ).toBe(403);
    // Cross-org enrollment is invisible.
    expect(
      (await request(h.app).get('/admin/enrollments/99999/schedule').set(auth(orgAdminKey))).status,
    ).toBe(404);

    // Org defaults: org_admin ok, instructor forbidden.
    const def = await request(h.app).put('/admin/schedule-defaults').set(auth(orgAdminKey)).send({
      timezone: 'Asia/Kolkata',
      dailyTime: '09:30',
      graceHours: 6,
    });
    expect(def.status).toBe(200);
    expect(def.body.defaults.dailyTime).toBe('09:30');
    expect(
      (await request(h.app).put('/admin/schedule-defaults').set(auth(instructorKey)).send({})).status,
    ).toBe(403);

    // Audit trail recorded the schedule changes.
    const audit = await request(h.app).get('/admin/audit').set(auth(ADMIN_KEY));
    const actions = (audit.body.entries ?? audit.body.audit ?? []).map(
      (e: { action: string }) => e.action,
    );
    expect(actions).toContain('schedule.set');
  });
});
