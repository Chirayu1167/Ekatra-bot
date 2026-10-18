import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { query } from '../src/db/pg';
import { runCleanup } from '../src/scripts/cleanup';
import { OptOutGuardSender, OptedOutError } from '../src/services/optOutGuard';
import { OptOutService, hashPhonePlain } from '../src/services/optout.service';
import { alphaCourse, buildHarness, publishedCourse, USER, ADMIN_KEY } from './helpers';
import { harness as journeyHarness, LEARNER } from './journey.helpers';
import { pgFileContext, resetDb } from './pg.helpers';

const pgx = pgFileContext('learner-data');

describe('central opt-out guard', () => {
  it('blocks every send path while opted out; only the STOP confirmation goes out', async () => {
    const h = await journeyHarness(pgx.pool);
    await request(h.app).post('/register').send({
      name: 'Asha Rao',
      phoneNumber: '+91 98765 43210',
      courseId: h.course.id,
      consent: true,
    });
    await h.say('START_COURSE');
    h.sender.clear();

    await h.say('STOP');
    expect(h.sender.sent).toHaveLength(1); // the STOP confirmation only
    h.sender.clear();

    // Every subsequent path is silent: no lesson, no tutor answer, no certificate, no menu.
    for (const text of ['NEXT', 'What does spaced repetition mean?', 'CERTIFICATE', 'COURSES', 'hello']) {
      await h.say(text);
    }
    expect(h.sender.sent).toHaveLength(0);

    // START restores sending.
    await h.say('START');
    expect(h.sender.sent.length).toBeGreaterThan(0);
  });

  it('the guard fails closed even if bot logic slips: direct sender calls are blocked', async () => {
    await resetDb(pgx.pool);
    const optOuts = new OptOutService(pgx.pool, undefined);
    const sent: unknown[] = [];
    const inner = {
      sendWhatsAppMessage: async (m: unknown) => {
        sent.push(m);
        return { sid: 'SM1' };
      },
    };
    const guard = new OptOutGuardSender(inner, optOuts);
    await optOuts.optOut(USER);
    const err = await guard.sendWhatsAppMessage({ to: USER, body: 'lesson' }).catch((e) => e);
    expect(err).toBeInstanceOf(OptedOutError);
    expect((err as OptedOutError).code).toBe('opted_out_suppressed');
    expect(sent).toHaveLength(0);
    // The STOP confirmation is the single exception.
    await guard.sendWhatsAppMessage({ to: USER, body: "You're unsubscribed", optOutConfirmation: true });
    expect(sent).toHaveLength(1);
  });

  it('opt-out survives learner deletion (hashed) and restarts', async () => {
    await resetDb(pgx.pool);
    const h1 = await buildHarness({ pg: pgx.pool, pgFresh: false });
    await publishedCourse(h1);
    await h1.say('START 1');
    await h1.say('STOP');
    expect(await h1.optOuts.isOptedOut(USER)).toBe(true);

    // Delete all learner data, then reopen: the number must still be blocked.
    const del = await request(h1.app)
      .delete(`/admin/learners/${encodeURIComponent(USER)}`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(del.status).toBe(200);

    const p2 = pgx.freshPool();
    const h2 = await buildHarness({ pg: p2, pgFresh: false });
    expect(await h2.optOuts.isOptedOut(USER)).toBe(true);
    const before = h2.sender.sent.length;
    await h2.say('NEXT');
    expect(h2.sender.sent.length).toBe(before); // silent
    await p2.end();
  });
});

describe('learner export and delete (org_admin+, scoped, audited)', () => {
  it('returns 404 for an org with no enrollment despite a shared global learner profile', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    const course = await publishedCourse(h);
    await h.enrollments.createPending(h.orgId, USER, course.id);
    await h.learners.upsert(USER, 'Shared profile name');
    const other = await h.orgs.create({ slug: 'export-other', name: 'Other' });
    const otherUser = await request(h.app)
      .post('/admin/users')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ org: other.slug, name: 'Other admin', role: 'org_admin' });
    expect(otherUser.status).toBe(201);
    const auth = `Bearer ${String(otherUser.body.apiKey)}`;

    const exported = await request(h.app)
      .get(`/admin/learners/${encodeURIComponent(USER)}/export`)
      .set('Authorization', auth);
    const deleted = await request(h.app)
      .delete(`/admin/learners/${encodeURIComponent(USER)}`)
      .set('Authorization', auth);
    expect(exported.status).toBe(404);
    expect(deleted.status).toBe(404);
    expect(await h.learners.getName(USER)).toBe('Shared profile name');
    expect(await h.enrollments.countEnrollments(USER)).toBe(1);
  });

  it('scopes inbound export and deletion when a phone is enrolled in two organisations', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    const courseA = await publishedCourse(h);
    const orgA = await h.orgs.getById(h.orgId);
    if (!orgA) throw new Error('default organisation missing');
    const orgB = await h.orgs.create({ slug: 'shared-learner-b', name: 'Org B' });
    const courseB = await h.courses.createCourse(orgB.id, {
      ...alphaCourse(),
      slug: 'shared-learner-b-course',
    });
    await h.courses.publish(orgB.id, courseB.id);
    await h.enrollments.createPending(orgA.id, USER, courseA.id);
    await h.enrollments.createPending(orgB.id, USER, courseB.id);
    await h.learners.upsert(USER, 'Shared learner');
    await query(
      h.db,
      `INSERT INTO inbound_events (org_id, message_sid, from_user, to_user, body)
       VALUES ($1, 'SMorg-a', $2, 'whatsapp:+14155238886', 'A-only inbound'),
              ($3, 'SMorg-b', $2, 'whatsapp:+14155238886', 'B-only inbound')`,
      [orgA.id, USER, orgB.id],
    );
    const createOrgAdmin = async (org: string, name: string) => {
      const response = await request(h.app)
        .post('/admin/users')
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send({ org, name, role: 'org_admin' });
      expect(response.status).toBe(201);
      return `Bearer ${String(response.body.apiKey)}`;
    };
    const authA = await createOrgAdmin(orgA.slug, 'Admin A');
    const authB = await createOrgAdmin(orgB.slug, 'Admin B');
    const exportFor = (auth: string) =>
      request(h.app)
        .get(`/admin/learners/${encodeURIComponent(USER)}/export`)
        .set('Authorization', auth);

    const [dataA, dataB] = await Promise.all([exportFor(authA), exportFor(authB)]);
    expect(dataA.status).toBe(200);
    expect(dataA.body.messages.map((message: { body: string }) => message.body)).toEqual([
      'A-only inbound',
    ]);
    expect(dataB.status).toBe(200);
    expect(dataB.body.messages.map((message: { body: string }) => message.body)).toEqual([
      'B-only inbound',
    ]);

    const deleted = await request(h.app)
      .delete(`/admin/learners/${encodeURIComponent(USER)}`)
      .set('Authorization', authA);
    expect(deleted.status).toBe(200);
    expect(deleted.body.profileDeleted).toBe(false);
    expect((await exportFor(authA)).status).toBe(404);
    const afterB = await exportFor(authB);
    expect(afterB.status).toBe(200);
    expect(afterB.body.learner.name).toBe('Shared learner');
    expect(afterB.body.messages.map((message: { body: string }) => message.body)).toEqual([
      'B-only inbound',
    ]);
    const eventRows = await query<{ message_sid: string; body: string }>(
      h.db,
      `SELECT message_sid, body FROM inbound_events WHERE message_sid IN ('SMorg-a', 'SMorg-b')
       ORDER BY message_sid`,
    );
    expect(eventRows.rows).toEqual([
      { message_sid: 'SMorg-a', body: '[redacted]' },
      { message_sid: 'SMorg-b', body: 'B-only inbound' },
    ]);
  });

  it('exports one learner as JSON; instructor gets 403; cross-org gets 404', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h);
    await h.say('START 1');
    await h.say('NEXT');

    const res = await request(h.app)
      .get(`/admin/learners/${encodeURIComponent(USER)}/export`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(200);
    expect(res.body.learner.phone).toBe(USER);
    expect(res.body.enrollments.length).toBeGreaterThan(0);
    expect(res.body).toHaveProperty('optOut');
    expect(res.body).toHaveProperty('certificates');
    expect(res.body).toHaveProperty('storedMessages');

    const audits = (
      await query<{ action: string }>(h.db, "SELECT action FROM audit_log WHERE action = 'learner.export'")
    ).rows;
    expect(audits).toHaveLength(1);

    // Instructor is blocked from export.
    const ins = await request(h.app)
      .post('/admin/users')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ name: 'Ins', role: 'instructor' });
    expect(
      (
        await request(h.app)
          .get(`/admin/learners/${encodeURIComponent(USER)}/export`)
          .set('Authorization', `Bearer ${ins.body.apiKey}`)
      ).status,
    ).toBe(403);

    // Another org's admin sees nothing (404, nothing revealed).
    await request(h.app)
      .post('/admin/orgs')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ slug: 'other', name: 'Other' });
    const otherAdmin = await request(h.app)
      .post('/admin/users')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ org: 'other', name: 'O', role: 'org_admin' });
    expect(
      (
        await request(h.app)
          .get(`/admin/learners/${encodeURIComponent(USER)}/export`)
          .set('Authorization', `Bearer ${otherAdmin.body.apiKey}`)
      ).status,
    ).toBe(404);
  });

  it('delete erases learner data but keeps the opt-out block; unknown learner is 404', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h);
    await h.say('START 1');
    await h.say('STOP');

    const res = await request(h.app)
      .delete(`/admin/learners/${encodeURIComponent(USER)}`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(200);
    expect(await h.optOuts.isOptedOut(USER)).toBe(true); // still blocked via hash
    expect(
      (await query<{ n: number }>(h.db, 'SELECT COUNT(*) AS n FROM learners WHERE user_id = $1', [USER])).rows,
    ).toEqual([{ n: 0 }]);

    expect(
      (await request(h.app).delete('/admin/learners/whatsapp%3A%2B910000000000').set('Authorization', `Bearer ${ADMIN_KEY}`)).status,
    ).toBe(404);
    const audits = (
      await query<{ action: string }>(h.db, "SELECT action FROM audit_log WHERE action = 'learner.delete'")
    ).rows;
    expect(audits).toHaveLength(1);
  });
});

describe('learner data lifecycle covers new tables (A3)', () => {
  it('delete-then-export shows nothing identifiable; opt-out block survives as hash', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h);
    await h.learners.upsert(USER, 'Asha Rao');
    await h.say('START 1'); // inbound event + outbound message + enrollment
    await h.say('STOP'); // opted out so the block survives deletion

    // Before delete: export carries name, enrollment, message and delivery history.
    const before = await request(h.app)
      .get(`/admin/learners/${encodeURIComponent(USER)}/export`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(before.status).toBe(200);
    expect(before.body.learner.name).toBeTruthy();
    expect(before.body.enrollments.length).toBeGreaterThan(0);
    expect(before.body.messages.length).toBeGreaterThan(0);
    expect(before.body.delivery.length).toBeGreaterThan(0);

    const del = await request(h.app)
      .delete(`/admin/learners/${encodeURIComponent(USER)}`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(del.status).toBe(200);

    // Opt-out block survives as a hash (HMAC-SHA-256 when OPTOUT_HASH_SECRET is set;
    // plain SHA-256 in tests/dev where no secret is configured; not keyed here).
    expect(await h.optOuts.isOptedOut(USER)).toBe(true);

    // After delete: export shows no name, no enrollments, no messages, no delivery history.
    const after = await request(h.app)
      .get(`/admin/learners/${encodeURIComponent(USER)}/export`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(after.status).toBe(404);

    // Identifiable content is irreversibly masked in the durable tables.
    const inbound = await query<{ body: string; from_user: string }>(
      h.db,
      "SELECT body, from_user FROM inbound_events WHERE from_user = $1 OR to_user = $1",
      [USER],
    );
    for (const row of inbound.rows) {
      expect(row.body).toBe('[redacted]');
      expect(row.from_user).not.toBe(USER);
      expect(row.from_user).toMatch(/^anon:/);
    }
    const outbound = await query<{ user_id: string; messages: string }>(
      h.db,
      "SELECT user_id, messages FROM outbound_messages WHERE user_id = $1",
      [USER],
    );
    for (const row of outbound.rows) {
      expect(row.user_id).not.toBe(USER);
      expect(row.user_id).toMatch(/^anon:/);
      expect(row.messages).toBe('[]');
    }
  });

  it('delete-then-still-opted-out: a deleted learner cannot be messaged', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h);
    await h.say('START 1');
    await h.say('STOP');
    expect(await h.optOuts.isOptedOut(USER)).toBe(true);

    const del = await request(h.app)
      .delete(`/admin/learners/${encodeURIComponent(USER)}`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(del.status).toBe(200);
    expect(await h.optOuts.isOptedOut(USER)).toBe(true); // block survives

    // Sending is still silent after deletion.
    const before = h.sender.sent.length;
    await h.say('NEXT');
    expect(h.sender.sent.length).toBe(before);
  });
});

describe('retention cleanup', () => {
  it('prunes old processed-message ids and audit rows, keeps the rest', async () => {
    await resetDb(pgx.pool);
    const db = pgx.pool;
    await query(db, "INSERT INTO processed_messages (message_sid, claimed_at) VALUES ('old', '2001-01-01T00:00:00Z')");
    await query(db, "INSERT INTO processed_messages (message_sid) VALUES ('fresh')");
    await query(db, "INSERT INTO audit_log (action, created_at) VALUES ('x', '2001-01-01T00:00:00Z')");
    await query(db, "INSERT INTO audit_log (action) VALUES ('y')");
    const out = await runCleanup(db, { processedDays: 30, auditDays: 365 });
    expect(out.processedMessages).toBe(1);
    expect(out.auditLog).toBe(1);
    expect((await query<{ s: string }>(db, 'SELECT message_sid AS s FROM processed_messages')).rows).toEqual([
      { s: 'fresh' },
    ]);
    expect((await query<{ a: string }>(db, 'SELECT action AS a FROM audit_log')).rows).toEqual([{ a: 'y' }]);
    expect(LEARNER).toBe('whatsapp:+919876543210');
  });

  it('retention removes only expired durable-delivery rows', async () => {
    await resetDb(pgx.pool);
    const db = pgx.pool;
    const old = '2001-01-01T00:00:00Z';
    const fresh = new Date().toISOString();

    // Jobs: old completed pruned, fresh kept; in-flight (queued) never pruned.
    await query(db, "INSERT INTO jobs (kind, dedupe_key, status, updated_at) VALUES ('outbound_send','j-old','completed',$1)", [old]);
    await query(db, "INSERT INTO jobs (kind, dedupe_key, status, updated_at) VALUES ('outbound_send','j-fresh','completed',$1)", [fresh]);
    await query(db, "INSERT INTO jobs (kind, dedupe_key, status, updated_at) VALUES ('outbound_send','j-queued','queued',$1)", [old]);

    // Attempts: old pruned, fresh kept.
    await query(db, "INSERT INTO outbound_messages (idempotency_key, user_id, messages, status) VALUES ('m-old','u','[]','sent')");
    await query(db, "INSERT INTO outbound_messages (idempotency_key, user_id, messages, status) VALUES ('m-fresh','u','[]','sent')");
    const msgRows = await query<{ id: number }>(db, "SELECT id FROM outbound_messages WHERE idempotency_key LIKE 'm-%' ORDER BY id");
    const oldMsg = msgRows.rows[0]!.id;
    const freshMsg = msgRows.rows[1]!.id;
    await query(db, 'INSERT INTO outbound_attempts (message_id, attempt_no, status, created_at) VALUES ($1,1,\'failed\',$2)', [oldMsg, old]);
    await query(db, 'INSERT INTO outbound_attempts (message_id, attempt_no, status, created_at) VALUES ($1,1,\'sent\',$2)', [freshMsg, fresh]);

    // Inbound events: old completed pruned, fresh kept; in-flight never pruned.
    await query(db, "INSERT INTO inbound_events (message_sid, from_user, status, updated_at) VALUES ('sid-old','u','completed',$1)", [old]);
    await query(db, "INSERT INTO inbound_events (message_sid, from_user, status, updated_at) VALUES ('sid-fresh','u','completed',$1)", [fresh]);
    await query(db, "INSERT INTO inbound_events (message_sid, from_user, status, updated_at) VALUES ('sid-processing','u','processing',$1)", [old]);

    // Dead letters: old discarded pruned, fresh kept; open never pruned.
    await query(db, "INSERT INTO dead_letters (kind, ref_id, reason, status, created_at) VALUES ('outbound',1,'r-old','discarded',$1)", [old]);
    await query(db, "INSERT INTO dead_letters (kind, ref_id, reason, status, created_at) VALUES ('outbound',2,'r-fresh','discarded',$1)", [fresh]);
    await query(db, "INSERT INTO dead_letters (kind, ref_id, reason, status, created_at) VALUES ('outbound',3,'r-open','open',$1)", [old]);

    const out = await runCleanup(db, {
      processedDays: 30,
      auditDays: 365,
      jobDays: 30,
      attemptDays: 30,
      inboundDays: 30,
      deadLetterDays: 30,
    });
    expect(out.jobs).toBe(1);
    expect(out.attempts).toBe(1);
    expect(out.inboundEvents).toBe(1);
    expect(out.deadLetters).toBe(1);

    // Only expired rows removed; fresh and in-flight kept.
    expect(
      (await query<{ s: string }>(db, "SELECT dedupe_key AS s FROM jobs WHERE dedupe_key = 'j-fresh'")).rows,
    ).toEqual([{ s: 'j-fresh' }]);
    expect(
      (await query<{ s: string }>(db, "SELECT dedupe_key AS s FROM jobs WHERE dedupe_key = 'j-queued'")).rows,
    ).toEqual([{ s: 'j-queued' }]);
    expect(
      (await query<{ s: string }>(db, "SELECT message_sid AS s FROM inbound_events WHERE message_sid = 'sid-fresh'")).rows,
    ).toEqual([{ s: 'sid-fresh' }]);
    expect(
      (await query<{ s: string }>(db, "SELECT message_sid AS s FROM inbound_events WHERE message_sid = 'sid-processing'")).rows,
    ).toEqual([{ s: 'sid-processing' }]);
    expect(
      (await query<{ s: string }>(db, "SELECT reason AS s FROM dead_letters WHERE reason = 'r-fresh'")).rows,
    ).toEqual([{ s: 'r-fresh' }]);
    expect(
      (await query<{ s: string }>(db, "SELECT reason AS s FROM dead_letters WHERE reason = 'r-open'")).rows,
    ).toEqual([{ s: 'r-open' }]);
  });

  describe('opt-out HMAC (keyed hash)', () => {
    const SECRET = 'test-optout-secret-0123456789abcdef';

    it('STOP blocks via HMAC when secret is configured', async () => {
      const h = await buildHarness({ pg: pgx.pool });
      const optOutsHmac = new OptOutService(h.db, SECRET);
      await optOutsHmac.optOut(USER);
      expect(await optOutsHmac.isOptedOut(USER)).toBe(true);

      // The stored hash is HMAC, not plain SHA-256.
      const row = await query<{ phone_hash: string }>(
        h.db,
        'SELECT phone_hash FROM opt_outs WHERE user_id = $1',
        [USER],
      );
      expect(row.rows[0]!.phone_hash).not.toBe(hashPhonePlain(USER));
    });

    it('legacy plain-hash row still blocks and upgrades to HMAC on next contact', async () => {
      const h = await buildHarness({ pg: pgx.pool });
      const optOutsHmac = new OptOutService(h.db, SECRET);

      // Insert a legacy plain-hash row directly.
      await query(
        h.db,
        'INSERT INTO opt_outs (user_id, phone_hash) VALUES ($1, $2)',
        [USER, hashPhonePlain(USER)],
      );
      expect(await optOutsHmac.isOptedOut(USER)).toBe(true); // legacy still blocks

      // Next optOut contact upgrades to HMAC.
      await optOutsHmac.optOut(USER);
      const row = await query<{ phone_hash: string }>(
        h.db,
        'SELECT phone_hash FROM opt_outs WHERE user_id = $1',
        [USER],
      );
      expect(row.rows[0]!.phone_hash).toBe(optOutsHmac['hmacHash'](USER));
    });

    it('delete-then-still-blocked: HMAC block survives learner deletion', async () => {
      const h = await buildHarness({ pg: pgx.pool });
      const course = await publishedCourse(h);
      await h.enrollments.createPending(h.orgId, USER, course.id);
      const optOutsHmac = new OptOutService(h.db, SECRET);
      await optOutsHmac.optOut(USER);
      expect(await optOutsHmac.isOptedOut(USER)).toBe(true);

      const del = await request(h.app)
        .delete(`/admin/learners/${encodeURIComponent(USER)}`)
        .set('Authorization', `Bearer ${ADMIN_KEY}`);
      expect(del.status).toBe(200);
      expect(await optOutsHmac.isOptedOut(USER)).toBe(true); // block survives via HMAC
    });

    it('isOptedOut matches both HMAC and legacy plain hash', async () => {
      const h = await buildHarness({ pg: pgx.pool });
      const optOutsHmac = new OptOutService(h.db, SECRET);

      // Insert both a plain-hash row and an HMAC row for different users.
      await query(h.db, 'INSERT INTO opt_outs (user_id, phone_hash) VALUES ($1, $2)', [
        'whatsapp:+911111111111',
        hashPhonePlain('whatsapp:+911111111111'),
      ]);
      await optOutsHmac.optOut('whatsapp:+912222222222');

      expect(await optOutsHmac.isOptedOut('whatsapp:+911111111111')).toBe(true); // legacy plain
      expect(await optOutsHmac.isOptedOut('whatsapp:+912222222222')).toBe(true); // HMAC
      expect(await optOutsHmac.isOptedOut('whatsapp:+913333333333')).toBe(false); // neither
    });
  });
});
