import crypto from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { silentLogger } from '../src/logger';
import { query } from '../src/db/pg';
import { CourseService } from '../src/services/course.service';
import { EnrollmentService } from '../src/services/enrollment.service';
import { LearnerService } from '../src/services/learner.service';
import { OrganisationsService } from '../src/services/organisations.service';
import { AdminAuthService } from '../src/services/adminAuth.service';
import { InboundEventService } from '../src/services/inboundEvents.service';
import { JobService } from '../src/services/jobs.service';
import { OutboundService } from '../src/services/outbound.service';
import { OptOutService } from '../src/services/optout.service';
import { pgFileContext, resetDb } from './pg.helpers';

const pgx = pgFileContext('admin-rbac');

const BOOTSTRAP = 'test-bootstrap-key-0123456789abcdef';

async function setup() {
  await resetDb(pgx.pool);
  const db = pgx.pool;
  const orgs = new OrganisationsService(db);
  const courses = new CourseService(db);
  const enrollments = new EnrollmentService(db);
  const learners = new LearnerService(db);
  const optOuts = new OptOutService(db);
  const auth = new AdminAuthService(db);
  const app = createApp({
    env: {
      TWILIO_AUTH_TOKEN: 'test_auth_token',
      TWILIO_WEBHOOK_VALIDATE: false,
      PUBLIC_BASE_URL: 'https://example.test',
    },
    db,
    inbound: new InboundEventService(db),
    jobs: new JobService(db),
    statusCallback: {
      reconcile: { db, outbound: new OutboundService(db), enrollments },
      logger: silentLogger,
    },
    logger: silentLogger,
    admin: { db, courses, orgs, auth, enrollments, learners, optOuts, bootstrapKey: BOOTSTRAP },
  });
  const api = (key?: string) => {
    const r = request(app).get('/admin/courses');
    return key ? r.set('Authorization', `Bearer ${key}`) : r;
  };
  return { db, app, api, orgs, courses, enrollments, learners, auth };
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

describe('admin RBAC', () => {
  it('allows instructors to read courses but blocks every course and lesson mutation', async () => {
    const { app } = await setup();
    const createUserKey = async (name: string, role: string) => {
      const response = await request(app)
        .post('/admin/users')
        .set('Authorization', `Bearer ${BOOTSTRAP}`)
        .send({ org: 'default', name, role });
      expect(response.status).toBe(201);
      return String(response.body.apiKey);
    };
    const adminKey = await createUserKey('Course admin', 'org_admin');
    const instructorKey = await createUserKey('Course instructor', 'instructor');
    const created = await request(app)
      .post('/admin/courses')
      .set('Authorization', `Bearer ${adminKey}`)
      .send({
        title: 'Read only course',
        description: '',
        lessons: [{ title: 'Lesson one', items: [{ kind: 'text', text: 'Hello' }] }],
      });
    expect(created.status).toBe(201);
    const courseId = created.body.course.id as number;
    const lessonId = created.body.course.lessons[0].id as number;
    expect(
      (await request(app).get('/admin/courses').set('Authorization', `Bearer ${instructorKey}`)).status,
    ).toBe(200);
    expect(
      (await request(app).get(`/admin/courses/${courseId}`).set('Authorization', `Bearer ${instructorKey}`)).status,
    ).toBe(200);
    const mutations = await Promise.all([
      request(app).post('/admin/courses').set('Authorization', `Bearer ${instructorKey}`).send({ title: 'Forbidden' }),
      request(app).patch(`/admin/courses/${courseId}`).set('Authorization', `Bearer ${instructorKey}`).send({ title: 'Forbidden' }),
      request(app).delete(`/admin/courses/${courseId}`).set('Authorization', `Bearer ${instructorKey}`),
      request(app).post(`/admin/courses/${courseId}/publish`).set('Authorization', `Bearer ${instructorKey}`),
      request(app).post(`/admin/courses/${courseId}/unpublish`).set('Authorization', `Bearer ${instructorKey}`),
      request(app).post(`/admin/courses/${courseId}/lessons`).set('Authorization', `Bearer ${instructorKey}`).send({ title: 'Forbidden', items: [] }),
      request(app).put(`/admin/courses/${courseId}/lessons/${lessonId}`).set('Authorization', `Bearer ${instructorKey}`).send({ title: 'Forbidden', items: [] }),
      request(app).delete(`/admin/courses/${courseId}/lessons/${lessonId}`).set('Authorization', `Bearer ${instructorKey}`),
    ]);
    expect(mutations.map((response) => response.status)).toEqual(Array(8).fill(403));

    const adminEdit = await request(app)
      .patch(`/admin/courses/${courseId}`)
      .set('Authorization', `Bearer ${adminKey}`)
      .send({ title: 'Org admin edit' });
    expect(adminEdit.status).toBe(200);
  });

  it('lists only key metadata and updates it after revoke for org admins', async () => {
    const { app } = await setup();
    const created = await request(app)
      .post('/admin/users')
      .set('Authorization', `Bearer ${BOOTSTRAP}`)
      .send({ org: 'default', name: 'Key owner', role: 'instructor' });
    expect(created.status).toBe(201);
    const adminKey = (
      await request(app)
        .post('/admin/users')
        .set('Authorization', `Bearer ${BOOTSTRAP}`)
        .send({ org: 'default', name: 'Org admin', role: 'org_admin' })
    ).body.apiKey as string;

    const list = await request(app).get('/admin/users').set('Authorization', `Bearer ${adminKey}`);
    expect(list.status).toBe(200);
    const owner = list.body.users.find((user: { id: number }) => user.id === created.body.user.id);
    expect(owner.keys).toHaveLength(1);
    expect(owner.keys[0]).toMatchObject({ prefix: created.body.prefix, revokedAt: null });
    expect(JSON.stringify(owner)).not.toContain(created.body.apiKey);
    expect(JSON.stringify(owner)).not.toContain('key_hash');

    const revoked = await request(app)
      .delete(`/admin/users/${owner.id}/keys/${owner.keys[0].id}`)
      .set('Authorization', `Bearer ${adminKey}`);
    expect(revoked.status).toBe(204);
    const after = await request(app).get('/admin/users').set('Authorization', `Bearer ${adminKey}`);
    const updated = after.body.users.find((user: { id: number }) => user.id === owner.id);
    expect(updated.keys[0].revokedAt).toBeTruthy();
  });

  it('bootstrap key acts as platform_admin: creates an org, then a user with a shown-once key', async () => {
    const { app, db, orgs } = await setup();
    const orgRes = await request(app)
      .post('/admin/orgs')
      .set('Authorization', `Bearer ${BOOTSTRAP}`)
      .send({ slug: 'acme', name: 'Acme' });
    expect(orgRes.status).toBe(201);
    expect((await orgs.getBySlug('acme'))).toBeDefined();

    const userRes = await request(app)
      .post('/admin/users')
      .set('Authorization', `Bearer ${BOOTSTRAP}`)
      .send({ org: 'acme', name: 'Asha', role: 'org_admin' });
    expect(userRes.status).toBe(201);
    const key = userRes.body.apiKey as string;
    expect(typeof key).toBe('string');
    expect(key.length).toBeGreaterThan(30);

    // Only the hash is stored — the plaintext appears nowhere in the database.
    const rows = (await query<{ key_hash: string }>(db, 'SELECT key_hash FROM admin_api_keys')).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.key_hash).toBe(sha256(key));
    const dump = JSON.stringify(
      (await query<Record<string, unknown>>(db, 'SELECT * FROM admin_api_keys')).rows,
    );
    expect(dump).not.toContain(key);

    // The new key works for its org's courses.
    const list = await request(app)
      .get('/admin/courses')
      .set('Authorization', `Bearer ${key}`);
    expect(list.status).toBe(200);
  });

  it('org A credentials against org B resources get 404 and change nothing', async () => {
    const { app } = await setup();
    const adminA = await request(app)
      .post('/admin/users')
      .set('Authorization', `Bearer ${BOOTSTRAP}`)
      .send({ org: 'default', name: 'A', role: 'org_admin' });
    const keyA = adminA.body.apiKey as string;
    await request(app)
      .post('/admin/orgs')
      .set('Authorization', `Bearer ${BOOTSTRAP}`)
      .send({ slug: 'other', name: 'Other' });

    // Course created in default org is invisible from the other org, even for platform key.
    const created = await request(app)
      .post('/admin/courses')
      .set('Authorization', `Bearer ${BOOTSTRAP}`)
      .send({ title: 'Secret', description: '', lessons: [] });
    const id = created.body.course.id as number;

    const cross = await request(app)
      .get(`/admin/courses/${id}?org=other`)
      .set('Authorization', `Bearer ${BOOTSTRAP}`);
    expect(cross.status).toBe(404);

    // org_admin of default cannot touch org=other at all.
    const forbidden = await request(app)
      .get(`/admin/courses?org=other`)
      .set('Authorization', `Bearer ${keyA}`);
    expect(forbidden.status).toBe(404);
  });

  it('instructor can read own-org learners and enrollments but cannot manage users', async () => {
      const { app, orgs, enrollments, learners } = await setup();
    const made = await request(app)
      .post('/admin/users')
      .set('Authorization', `Bearer ${BOOTSTRAP}`)
      .send({ org: 'default', name: 'Ins', role: 'instructor' });
    const key = made.body.apiKey as string;

    const course = await request(app)
      .post('/admin/courses')
      .set('Authorization', `Bearer ${BOOTSTRAP}`)
      .send({ title: 'T', description: '', lessons: [] });
    expect(course.status).toBe(201);
    const orgId = await orgs.getDefaultId();
    const learnerPhone = 'whatsapp:+919876543210';
    await learners.upsert(learnerPhone, 'Asha Rao');
    const enrollment = await enrollments.createPending(orgId, learnerPhone, course.body.course.id);

    const learnerList = await request(app).get('/admin/learners').set('Authorization', `Bearer ${key}`);
    expect(learnerList.status).toBe(200);
    expect(learnerList.body.learners[0].phone).toBe('whatsapp:+***3210');
    const learnerDetail = await request(app)
      .get(`/admin/learners/${enrollment.id}`)
      .set('Authorization', `Bearer ${key}`);
    expect(learnerDetail.status).toBe(200);
    expect(learnerDetail.body.phone).toBe('whatsapp:+***3210');
    expect(learnerDetail.body.fullPhone).toBeUndefined();
    const enrollmentList = await request(app).get('/admin/enrollments').set('Authorization', `Bearer ${key}`);
    expect(enrollmentList.status).toBe(200);
    expect(enrollmentList.body.enrollments[0].userId).toBe('whatsapp:+***3210');

    expect(
      (await request(app).get('/admin/users').set('Authorization', `Bearer ${key}`)).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post('/admin/users')
          .set('Authorization', `Bearer ${key}`)
          .send({ name: 'x', role: 'instructor' })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post('/admin/orgs')
          .set('Authorization', `Bearer ${key}`)
          .send({ slug: 'nope', name: 'Nope' })
      ).status,
    ).toBe(403);
  });

  it('org_admin manages own users and audit; instructor is locked out of audit', async () => {
    const { app } = await setup();
    const mk = (name: string, role: string, org?: string) =>
      request(app)
        .post('/admin/users')
        .set('Authorization', `Bearer ${BOOTSTRAP}`)
        .send(org ? { org, name, role } : { name, role });
    const adminKey = (await mk('A', 'org_admin', 'default')).body.apiKey as string;
    const insKey = (await mk('I', 'instructor', 'default')).body.apiKey as string;

    // Positive: org_admin lists own org users and reads own audit.
    expect(
      (await request(app).get('/admin/users').set('Authorization', `Bearer ${adminKey}`)).status,
    ).toBe(200);
    expect(
      (await request(app).get('/admin/audit').set('Authorization', `Bearer ${adminKey}`)).status,
    ).toBe(200);
    // Positive: platform_admin reads the full audit log.
    expect(
      (await request(app).get('/admin/audit').set('Authorization', `Bearer ${BOOTSTRAP}`)).status,
    ).toBe(200);
    // Negative: instructor gets 403 on audit.
    expect(
      (await request(app).get('/admin/audit').set('Authorization', `Bearer ${insKey}`)).status,
    ).toBe(403);
  });

  it('missing, malformed, revoked and expired credentials get 401', async () => {
    const { app, auth, orgs } = await setup();
    expect((await request(app).get('/admin/courses')).status).toBe(401);
    expect(
      (await request(app).get('/admin/courses').set('Authorization', 'Bearer nope')).status,
    ).toBe(401);
    expect(
      (await request(app).get('/admin/courses').set('Authorization', 'Basic abc')).status,
    ).toBe(401);

    const user = await auth.createUser(await orgs.getDefaultId(), 'Temp', 'org_admin');
    const live = ((await auth.issueKey(user.id)));
    expect(
      (await request(app).get('/admin/courses').set('Authorization', `Bearer ${live.plaintext}`))
        .status,
    ).toBe(200);
    ((await auth.revokeKey(live.id)));
    expect(
      (await request(app).get('/admin/courses').set('Authorization', `Bearer ${live.plaintext}`))
        .status,
    ).toBe(401);

    const expired = ((await auth.issueKey(user.id, new Date(Date.now() - 1000).toISOString())));
    expect(
      (
        await request(app)
          .get('/admin/courses')
          .set('Authorization', `Bearer ${expired.plaintext}`)
      ).status,
    ).toBe(401);
  });

  it('rotating a key invalidates the old one; last_used_at is recorded', async () => {
    const { app, auth, orgs, db } = await setup();
    const user = await auth.createUser(await orgs.getDefaultId(), 'R', 'org_admin');
    const first = ((await auth.issueKey(user.id)));
    expect(
      (await request(app).get('/admin/courses').set('Authorization', `Bearer ${first.plaintext}`))
        .status,
    ).toBe(200);
    const rotated = await request(app)
      .post(`/admin/users/${user.id}/keys`)
      .set('Authorization', `Bearer ${BOOTSTRAP}`)
      .send({});
    expect(rotated.status).toBe(201);
    expect(
      (await request(app).get('/admin/courses').set('Authorization', `Bearer ${first.plaintext}`))
        .status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .get('/admin/courses')
          .set('Authorization', `Bearer ${rotated.body.apiKey}`)
      ).status,
    ).toBe(200);
    const row = (
      await query<{ last_used_at: Date | string | null }>(
        db,
        'SELECT last_used_at FROM admin_api_keys WHERE id = $1',
        [first.id],
      )
    ).rows[0];
    expect(row?.last_used_at).toBeTruthy();
  });

  it('platform_admin recovers a lost org_admin key; the loss is audit-logged', async () => {
    const { app, auth, orgs, db } = await setup();
    const user = await auth.createUser(await orgs.getDefaultId(), 'Lost', 'org_admin');
    const res = await request(app)
      .post(`/admin/users/${user.id}/recover`)
      .set('Authorization', `Bearer ${BOOTSTRAP}`)
      .send({});
    expect(res.status).toBe(200);
    expect(typeof res.body.apiKey).toBe('string');
    const audits = (
      await query<{ action: string }>(db, "SELECT action FROM audit_log WHERE action = 'key.recover'")
    ).rows;
    expect(audits.length).toBeGreaterThan(0);
  });

  it('admin keys and certificate codes are never interchangeable', async () => {
    const { app } = await setup();
    // A certificate-shaped code as a Bearer key is unknown -> 401.
    expect(
      (
        await request(app)
          .get('/admin/courses')
          .set('Authorization', 'Bearer 12-AbCdEfGhIjKlMnOp')
      ).status,
    ).toBe(401);
    // An admin key as a certificate code fails the code format -> 404.
    expect((await request(app).get(`/certificates/${BOOTSTRAP}`)).status).toBe(404);
  });

  it('sensitive admin actions are audit-logged without key values', async () => {
    const { app, db } = await setup();
    const key = (
      await request(app)
        .post('/admin/users')
        .set('Authorization', `Bearer ${BOOTSTRAP}`)
        .send({ org: 'default', name: 'Aud', role: 'instructor' })
    ).body.apiKey as string;
    const rows = (
      await query<{ action: string; target: string }>(db, 'SELECT action, target FROM audit_log')
    ).rows;
    const actions = rows.map((r) => r.action);
    expect(actions).toContain('user.create');
    expect(actions).toContain('key.issue');
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(key);
    expect(dump).not.toContain(BOOTSTRAP);
  });
});
