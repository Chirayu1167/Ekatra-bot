import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { SchedulerService } from '../src/services/scheduler.service';
import { ADMIN_KEY } from './helpers';
import { pgFileContext } from './pg.helpers';
import { query } from '../src/db/pg';
import { buildHarness } from './helpers';

const pgx = pgFileContext('console-smoke');
const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });

describe('admin console API-level operation smoke', () => {
  it('runs a scheduled send, failure and replay, and limits instructor routes', async () => {
    const h = await buildHarness({ pg: pgx.pool, autoDrain: false });
    const platform = bearer(ADMIN_KEY);
    const orgAdmin = await request(h.app)
      .post('/admin/users')
      .set(platform)
      .send({ org: 'default', name: 'Smoke admin', role: 'org_admin' });
    expect(orgAdmin.status).toBe(201);
    const adminKey = orgAdmin.body.apiKey as string;
    const instructor = await request(h.app)
      .post('/admin/users')
      .set(platform)
      .send({ org: 'default', name: 'Smoke instructor', role: 'instructor' });
    expect(instructor.status).toBe(201);
    const instructorKey = instructor.body.apiKey as string;

    const created = await request(h.app)
      .post('/admin/courses')
      .set(bearer(adminKey))
      .send({
        title: 'Console Smoke',
        description: 'API-level fake sender verification',
        lessons: [
          { title: 'First lesson', items: [{ kind: 'text', text: 'Scheduled smoke lesson one.' }] },
          { title: 'Second lesson', items: [{ kind: 'text', text: 'Scheduled smoke lesson two.' }] },
          { title: 'Third lesson', items: [{ kind: 'text', text: 'Replay smoke lesson three.' }] },
        ],
      });
    expect(created.status).toBe(201);
    const courseId = created.body.course.id as number;
    expect((await request(h.app).post(`/admin/courses/${courseId}/publish`).set(bearer(adminKey))).status).toBe(200);

    const enrollment = await request(h.app)
      .post('/admin/enrollments')
      .set(bearer(adminKey))
      .send({ phone: 'whatsapp:+15555550123', courseId, consent: true });
    expect(enrollment.status).toBe(201);
    const enrollmentId = enrollment.body.enrollment.id as number;
    const time = new Date(Date.now() - 60_000).toISOString().slice(11, 16);
    const schedule = await request(h.app)
      .put(`/admin/courses/${courseId}/schedule`)
      .set(bearer(adminKey))
      .send({ kind: 'daily', timezone: 'UTC', dailyTime: time, slots: [] });
    expect(schedule.status).toBe(200);

    const start = await h.post('START COURSE', { from: 'whatsapp:+15555550123', sid: 'SMOKE-START' });
    expect(start.status).toBe(200);
    await h.drain();
    expect(h.sender.sent.some((message) => message.body.includes('Scheduled smoke lesson one.'))).toBe(true);

    const scheduler = new SchedulerService(h.db);
    const tick = await scheduler.tick(Date.now());
    expect(tick.enqueued).toBe(1);
    await h.drain();
    expect(h.sender.sent.some((message) => message.body.includes('Scheduled smoke lesson one.'))).toBe(true);
    expect((await h.enrollments.find(h.orgId, 'whatsapp:+15555550123', courseId))?.lastDeliveredPosition).toBe(2);

    h.sender.failAll = true;
    const inbound = await h.post('NEXT', { from: 'whatsapp:+15555550123', sid: 'SMOKE-NEXT' });
    expect(inbound.status).toBe(200);
    await h.drain();
    for (let attempt = 0; attempt < 8; attempt++) {
      await query(h.db, `UPDATE jobs SET run_at = now(), visible_at = now() WHERE status = 'queued'`);
      await h.drain();
    }
    const failures = await request(h.app).get('/admin/failures').set(bearer(adminKey));
    expect(failures.status).toBe(200);
    const failure = failures.body.failures.find((item: { kind: string; reasonCode: string }) =>
      item.kind === 'outbound' && item.reasonCode !== 'unknown_outcome',
    );
    expect(failure).toBeTruthy();

    h.sender.failAll = false;
    const replay = await request(h.app)
      .post(`/admin/failures/${failure.id}/replay`)
      .set(bearer(adminKey))
      .send({});
    expect(replay.status).toBe(200);
    await h.drain();
    expect(h.sender.sent.some((message) => message.body.includes('Replay smoke lesson three.'))).toBe(true);
    expect((await h.enrollments.find(h.orgId, 'whatsapp:+15555550123', courseId))?.lastDeliveredPosition).toBe(3);
    const delivered = await request(h.app).get('/admin/delivery').set(bearer(adminKey));
    expect(delivered.body.messages).toContainEqual(expect.objectContaining({ id: replay.body.messageId, status: 'sent' }));
    const replayedFailures = await request(h.app).get('/admin/failures?status=replayed').set(bearer(adminKey));
    expect(replayedFailures.body.failures).toContainEqual(expect.objectContaining({ id: failure.id, status: 'replayed' }));

    const instructorAuth = bearer(instructorKey);
    expect((await request(h.app).get('/admin/courses').set(instructorAuth)).status).toBe(200);
    const learners = await request(h.app).get('/admin/learners?search=0123').set(instructorAuth);
    expect(learners.status).toBe(200);
    expect(learners.body.learners).toHaveLength(1);
    expect((await request(h.app).get(`/admin/learners/${learners.body.learners[0].id}`).set(instructorAuth)).status).toBe(200);
    expect((await request(h.app).get('/admin/enrollments').set(instructorAuth)).status).toBe(200);
    expect((await request(h.app).post('/admin/enrollments').set(instructorAuth).send({ phone: 'whatsapp:+15555550999', courseId, consent: true })).status).toBe(403);
    expect((await request(h.app).put(`/admin/courses/${courseId}/schedule`).set(instructorAuth).send({ kind: 'daily', timezone: 'UTC', dailyTime: time })).status).toBe(403);
    for (const path of ['/admin/delivery', '/admin/failures', '/admin/certificates', '/admin/users', '/admin/audit']) {
      expect((await request(h.app).get(path).set(instructorAuth)).status, path).toBe(403);
    }
    expect((await request(h.app).post(`/admin/enrollments/${enrollmentId}/pause`).set(instructorAuth)).status).toBe(403);
  });
});
