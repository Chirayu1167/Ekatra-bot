import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { parseCommand } from '../src/bot/commands';
import { renderLesson } from '../src/bot/lessonRenderer';
import { query, withTransaction, type PgDb } from '../src/db/pg';
import { seedSampleCourses } from '../src/db/seed';
import { ConfigError, loadEnv } from '../src/config/env';
import { silentLogger } from '../src/logger';
import { CourseService } from '../src/services/course.service';
import { OrganisationsService } from '../src/services/organisations.service';
import { deliverMessages } from '../src/services/delivery';
import { PgIdempotencyStore } from '../src/services/idempotency.pg';
import { KeyedMutex } from '../src/services/keyedMutex';
import { TwilioWhatsAppService, type TwilioMessagesClient } from '../src/services/whatsapp.service';
import { InboundEventService } from '../src/services/inboundEvents.service';
import { JobService } from '../src/services/jobs.service';
import { OutboundService } from '../src/services/outbound.service';
import { EnrollmentService } from '../src/services/enrollment.service';
import { LIMITS } from '../src/types/course';
import { BOT, FakeSender, USER, buildHarness } from './helpers';
import { pgFileContext, resetDb } from './pg.helpers';

const pgx = pgFileContext('infra');

// Postgres-backed tests share the file database; reset to pristine before each one.
beforeEach(() => resetDb(pgx.pool));

describe('migrations', () => {
  // The SQLite v1..v7 chain this replaced is covered by tests/orgs.isolation.test.ts (raw-SQL
  // upgrade check) and the Postgres ledger by tests/pg.foundation.test.ts.

  it('the database itself enforces one active course per learner per org, and one enrolment per course', async () => {
    const db = pgx.pool;
    const orgs = new OrganisationsService(db);
    const orgId = ((await orgs.getDefaultId()));
    const otherOrg = ((await orgs.create({ slug: 'other', name: 'Other' }))).id;
    const course = new CourseService(db);
    const a = await course.createCourse(orgId, { title: 'A', description: '', lessons: [] });
    const b = await course.createCourse(orgId, { title: 'B', description: '', lessons: [] });
    const ins = (o: number, u: string, c: number, s: string) =>
      query(db, 'INSERT INTO enrollments (org_id, user_id, course_id, status) VALUES ($1, $2, $3, $4)', [
        o,
        u,
        c,
        s,
      ]);
    await ins(orgId, USER, a.id, 'active');
    await expect(ins(orgId, USER, b.id, 'active')).rejects.toThrow(/duplicate key|UNIQUE/);
    await ins(orgId, USER, b.id, 'paused'); // allowed
    await expect(ins(orgId, USER, a.id, 'paused')).rejects.toThrow(/duplicate key|UNIQUE/);
    // ...but the same learner may be active in another org (one sender, many tenants).
    const c = await course.createCourse(otherOrg, { title: 'C', description: '', lessons: [] });
    await expect(ins(otherOrg, USER, c.id, 'active')).resolves.toBeDefined();
  });
});

describe('transactions and foreign keys', () => {
  it('withTransaction commits on success and rolls everything back on error', async () => {
    const db = pgx.pool;
    const orgId = await new OrganisationsService(db).getDefaultId();
    let n = 0;
    const insertOn = (tx: PgDb) =>
      query(tx, 'INSERT INTO courses (org_id, slug, title) VALUES ($1, $2, $3)', [
        orgId,
        `s${Date.now().toString(36)}${(n += 1)}`,
        't',
      ]);
    // Statements must run on the tx client (not the pool) to take part in the transaction.
    expect(await withTransaction(db, (tx) => insertOn(tx).then(() => 'ok' as const))).toBe('ok');
    expect(await pgCount(db, 'courses')).toBe(1);

    await expect(
      withTransaction(db, async (tx) => {
        await insertOn(tx);
        await insertOn(tx);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await pgCount(db, 'courses')).toBe(1); // both inserts undone
    await withTransaction(db, (tx) => insertOn(tx).then(() => undefined)); // connection still usable
    expect(await pgCount(db, 'courses')).toBe(2);
  });

  it('createCourse is all-or-nothing: a failure part-way leaves no half-created course', async () => {
    const db = pgx.pool;
    const orgId = await new OrganisationsService(db).getDefaultId();
    const courses = new CourseService(db);
    const broken = {
      title: 'Broken',
      description: '',
      lessons: [
        { title: 'Fine', items: [{ kind: 'text', text: 'ok' }] },
        { title: 'Bad', items: [{ kind: 'bogus', text: 'rejected by the database CHECK' }] },
      ],
    } as unknown as Parameters<CourseService['createCourse']>[1];
    await expect(courses.createCourse(orgId, broken)).rejects.toThrow();
    expect(await pgCount(db, 'courses')).toBe(0);
    expect(await pgCount(db, 'lessons')).toBe(0);
    expect(await pgCount(db, 'lesson_items')).toBe(0);
  });

  it('foreign keys are enforced: a course with learners cannot be deleted, lessons cascade', async () => {
    const db = pgx.pool;
    const courses = new CourseService(db);
    const orgId = await new OrganisationsService(db).getDefaultId();
    const course = ((await courses.createCourse(orgId, {
      title: 'A',
      description: '',
      lessons: [{ title: 'L', items: [{ kind: 'text', text: 't' }] }],
    })));
    await query(db, "INSERT INTO enrollments (org_id, user_id, course_id, status) VALUES ($1, $2, $3, 'active')", [
      orgId,
      USER,
      course.id,
    ]);
    await expect(query(db, 'DELETE FROM courses WHERE id = $1', [course.id])).rejects.toThrow(
      /foreign key|violates/i,
    );

    await query(db, 'DELETE FROM enrollments', []);
    await query(db, 'DELETE FROM courses WHERE id = $1', [course.id]);
    expect(await pgCount(db, 'lessons')).toBe(0);
    expect(await pgCount(db, 'lesson_items')).toBe(0);
  });
});

async function pgCount(db: Parameters<typeof query>[0], table: string): Promise<number> {
  const { rows } = await query<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${table}`);
  return Number(rows[0]?.n ?? 0);
}

describe('PgIdempotencyStore', () => {
  it('claims once, reports duplicates, and can release a claim', async () => {
    const store = new PgIdempotencyStore(pgx.pool);
    expect(await store.claim('SM1')).toBe(true);
    expect(await store.claim('SM1')).toBe(false);
    expect(await store.claim('SM2')).toBe(true);
    await store.release('SM1');
    expect(await store.claim('SM1')).toBe(true);
  });

  it('prunes only old claims', async () => {
    const db = pgx.pool;
    const store = new PgIdempotencyStore(db);
    await store.claim('new');
    await query(
      db,
      "INSERT INTO processed_messages (message_sid, claimed_at) VALUES ('old', now() - make_interval(days => 40))",
    );
    expect(await store.prune(30)).toBe(1);
    expect(await store.claim('old')).toBe(true);
    expect(await store.claim('new')).toBe(false);
  });
});

describe('KeyedMutex', () => {
  it('runs tasks for one key strictly in order, and different keys in parallel', async () => {
    const mutex = new KeyedMutex();
    const log: string[] = [];
    const task = (name: string, ms: number) => async () => {
      log.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`${name}:end`);
    };
    await Promise.all([
      mutex.run('a', task('a1', 20)),
      mutex.run('a', task('a2', 1)),
      mutex.run('b', task('b1', 5)),
    ]);
    expect(log.indexOf('a1:end')).toBeLessThan(log.indexOf('a2:start'));
    expect(log.indexOf('b1:start')).toBeLessThan(log.indexOf('a1:end')); // b not blocked by a
  });

  it('a failing task does not block the next one, and still rejects to its caller', async () => {
    const mutex = new KeyedMutex();
    const failing = mutex.run('k', async () => {
      throw new Error('boom');
    });
    const next = mutex.run('k', async () => 'ok');
    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ok');
  });
});

describe('deliverMessages', () => {
  it('sends in order and returns the sids', async () => {
    const sender = new FakeSender();
    const sids = await deliverMessages(
      sender,
      USER,
      [{ text: 'a' }, { text: '', mediaUrl: 'https://x.test/a.png' }, { text: 'c' }],
      silentLogger,
    );
    expect(sender.sent.map((m) => m.body)).toEqual(['a', '', 'c']);
    expect(sids).toHaveLength(3);
  });

  it('does not log media URLs with their query strings (they may hold tokens)', async () => {
    const sender = new FakeSender();
    sender.failIf = (m) => Boolean(m.mediaUrl);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await deliverMessages(
      sender,
      USER,
      [{ text: '', mediaUrl: 'https://x.test/a.png?token=SECRET' }],
      logger,
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('SECRET');
  });

  it('rethrows non-media failures', async () => {
    const sender = new FakeSender();
    sender.failIf = () => true;
    await expect(
      deliverMessages(sender, USER, [{ text: 'hi' }], silentLogger),
    ).rejects.toMatchObject({ status: 502 });
  });
});

describe('TwilioWhatsAppService media support', () => {
  const make = () => {
    const create = vi.fn().mockResolvedValue({ sid: 'SM1' });
    const client: TwilioMessagesClient = { messages: { create } };
    return { create, service: new TwilioWhatsAppService(client, BOT, silentLogger) };
  };

  it('sends media as a one-element mediaUrl array and omits an empty body', async () => {
    const { create, service } = make();
    await service.sendWhatsAppMessage({ to: USER, body: '', mediaUrl: 'https://x.test/a.pdf' });
    expect(create).toHaveBeenCalledWith({
      from: BOT,
      to: USER,
      mediaUrl: ['https://x.test/a.pdf'],
    });
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('body');
  });

  it('plain text messages are sent exactly as before', async () => {
    const { create, service } = make();
    await service.sendWhatsAppMessage({ to: USER, body: 'hello' });
    expect(create.mock.calls[0]?.[0]).toStrictEqual({ from: BOT, to: USER, body: 'hello' });
  });
});

describe('parseCommand', () => {
  it.each([
    ['COURSES', 'courses', ''],
    ['courses!', 'courses', ''],
    ['1', 'courses', ''],
    ['START 1', 'start', '1'],
    ['  start   my course. ', 'start', 'my course'],
    ['Next', 'next', ''],
    ['PAUSE', 'pause', ''],
    ['resume?', 'resume', ''],
    ['Progress', 'progress', ''],
  ])('%j → %s', (text, name, arg) => {
    expect(parseCommand(text)).toEqual({ name, arg });
  });

  it.each(['start', 'hello', '2', 'help', '', 'next lesson', 'courses please', 'nextt', 'stop'])(
    '%j is not a command',
    (text) => {
      expect(parseCommand(text)).toBeNull();
    },
  );
});

describe('renderLesson', () => {
  const ctx = { courseTitle: 'C', lessonNumber: 1, lessonCount: 3, lessonTitle: 'T' };

  it('merges header and footer into text messages; media always stands alone', () => {
    const msgs = renderLesson(ctx, [
      { kind: 'text', text: 'hi' },
      { kind: 'document', url: 'https://x.test/a.pdf', caption: 'read me' },
    ]);
    expect(msgs).toEqual([
      { text: '📘 *Lesson 1 of 3: T*\n\nhi' },
      { text: 'read me' },
      { text: '', mediaUrl: 'https://x.test/a.pdf' },
      { text: 'Reply *NEXT* for lesson 2 of 3.' },
    ]);
  });

  it('puts the header in its own message when the lesson starts with media', () => {
    const msgs = renderLesson(ctx, [{ kind: 'image', url: 'https://x.test/a.png' }]);
    expect(msgs.map((m) => m.mediaUrl)).toEqual([undefined, 'https://x.test/a.png', undefined]);
    expect(msgs[0]?.text).toContain('Lesson 1 of 3: T');
  });

  it('final lesson ends with the completion note instead of NEXT', () => {
    const msgs = renderLesson({ ...ctx, lessonNumber: 3 }, [{ kind: 'text', text: 'bye' }]);
    expect(msgs[0]?.text).toContain("you've completed *C*");
    expect(msgs[0]?.text).not.toContain('NEXT');
  });

  it('worst-case content still fits in a 1600-character WhatsApp message', () => {
    const longTitle = 'T'.repeat(LIMITS.lessonTitleMax);
    const msgs = renderLesson(
      {
        courseTitle: 'C'.repeat(LIMITS.courseTitleMax),
        lessonNumber: 50,
        lessonCount: 50,
        lessonTitle: longTitle,
      },
      [{ kind: 'text', text: 'x'.repeat(LIMITS.textMax) }],
    );
    expect(msgs).toHaveLength(1);
    expect((msgs[0]?.text ?? '').length).toBeLessThan(1600);
  });
});

describe('seed data', () => {
  it('creates and publishes sample courses, and is idempotent', async () => {
    const db = pgx.pool;
    const orgId = await new OrganisationsService(db).getDefaultId();
    const courses = new CourseService(db);
    const first = await seedSampleCourses(orgId, courses, 'https://example.test');
    expect(first.created).toEqual(['welcome-to-ekatra', 'study-habits', 'demo-1', 'demo-2', 'python-basics']);
    const again = await seedSampleCourses(orgId, courses, 'https://example.test');
    expect(again).toEqual({
      created: [],
      skipped: ['welcome-to-ekatra', 'study-habits', 'demo-1', 'demo-2', 'python-basics'],
    });
    expect((await courses.listCourses(orgId, { status: 'published' }))).toHaveLength(5);
  });

  it('python-basics lessons each carry exactly one scored quiz', async () => {
    const db = pgx.pool;
    const orgId = await new OrganisationsService(db).getDefaultId();
    const courses = new CourseService(db);
    await seedSampleCourses(orgId, courses, 'https://example.test');
    const py = ((await courses.getCourseBySlug(orgId, 'python-basics')));
    expect(py?.lessonCount).toBe(10);
    const detail = ((await courses.getCourseDetail(orgId, py!.id)))!;
    for (const lesson of detail.lessons) {
      const quizzes = lesson.items.filter((i) => i.kind === 'quiz');
      expect(quizzes.length).toBeGreaterThanOrEqual(1);
      for (const q of quizzes) {
        expect(q.options.length).toBeLessThanOrEqual(3);
        expect(q.options.filter((o) => o.correct === true)).toHaveLength(1);
      }
    }
  });

  it('only includes media pointing at the public base URL, and none without one', async () => {
    const withUrlDb = pgx.pool;
    const withUrlOrg = await new OrganisationsService(withUrlDb).getDefaultId();
    const withUrl = new CourseService(withUrlDb);
    await seedSampleCourses(withUrlOrg, withUrl, 'https://example.test');
    const media = (
      await withUrl.getLessonAt(withUrlOrg, 1, 3)
    )?.items
      .filter((i) => 'url' in i)
      .map((i) => 'url' in i && i.url);
    expect(media).toEqual([
      'https://example.test/media/sample.png',
      'https://example.test/media/sample.pdf',
    ]);

    await resetDb(pgx.pool);
    const withoutDb = pgx.pool;
    const withoutOrg = await new OrganisationsService(withoutDb).getDefaultId();
    const without = new CourseService(withoutDb);
    await seedSampleCourses(withoutOrg, without);
    expect(
      (await without.getLessonAt(withoutOrg, 1, 3))?.items.every((i) => i.kind === 'text'),
    ).toBe(true);
  });

  it('both demo courses can be taken start to finish, Demo 2 with its image and PDF', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await seedSampleCourses(h.orgId, h.courses, 'https://example.test');

    await h.say('START demo-1');
    await h.say('NEXT');
    expect((await h.say('NEXT')).all).toContain("you've completed *Demo 1*");

    const two = await h.say('START demo-2');
    expect(two.all).toContain('*Demo 2*');
    const media = (await h.say('NEXT')).messages.map((m) => m.mediaUrl).filter(Boolean);
    expect(media).toEqual([
      'https://example.test/media/sample.png',
      'https://example.test/media/sample.pdf',
    ]);
    expect((await h.say('NEXT')).all).toContain("you've completed *Demo 2*");
    expect(((await h.enrollments.listForUser(h.orgId, USER))).map((e) => e.status)).toEqual([
      'completed',
      'completed',
    ]);
  });

  it('the seeded course can be completed end to end through the bot', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await seedSampleCourses(h.orgId, h.courses, 'https://example.test');
    await h.say('START welcome-to-ekatra');
    await h.say('NEXT');
    const last = await h.say('NEXT');
    expect(last.messages.some((m) => m.mediaUrl === 'https://example.test/media/sample.pdf')).toBe(
      true,
    );
    expect(((await h.enrollments.find(h.orgId, USER, 1)))?.status).toBe('completed');
  });
});

describe('/media static hosting', () => {
  const app = (mediaDir?: string) =>
createApp({
        env: {
          TWILIO_AUTH_TOKEN: 't',
          TWILIO_WEBHOOK_VALIDATE: false,
          PUBLIC_BASE_URL: 'https://example.test',
        },
        db: pgx.pool,
        inbound: new InboundEventService(pgx.pool),
        jobs: new JobService(pgx.pool),
        statusCallback: {
          reconcile: {
            db: pgx.pool,
            outbound: new OutboundService(pgx.pool),
            enrollments: new EnrollmentService(pgx.pool),
          },
          logger: silentLogger,
        },
        logger: silentLogger,
        ...(mediaDir && { mediaDir }),
      });

  it('serves the sample files with the right Content-Type (Twilio checks it)', async () => {
    const a = app('./media');
    const pdf = await request(a).get('/media/sample.pdf');
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toContain('sample.pdf');
    const png = await request(a).get('/media/sample.png');
    expect(png.headers['content-type']).toBe('image/png');
  });

  it('does not list the folder, serve outside it, or exist when not configured', async () => {
    const a = app('./media');
    expect((await request(a).get('/media/')).status).toBe(404);
    expect([403, 404]).toContain((await request(a).get('/media/%2e%2e/package.json')).status);
    expect((await request(a).get('/media/../package.json')).status).toBe(404);
    expect((await request(app()).get('/media/sample.pdf')).status).toBe(404);
  });
});

describe('configuration', () => {
  const base = {
    TWILIO_ACCOUNT_SID: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    TWILIO_AUTH_TOKEN: 'secret-token',
    TWILIO_WHATSAPP_FROM: 'whatsapp:+14155238886',
  };
  const baseWithDb = { ...base, DATABASE_URL: 'postgres://localhost:5432/ekatra' };

  it('defaults: pool, timeouts, media folder, admin API off; DATABASE_URL required', () => {
    expect(() => loadEnv(base)).toThrow(/DATABASE_URL/);
    const env = loadEnv(baseWithDb);
    expect(env.DATABASE_POOL_MAX).toBe(10);
    expect(env.DATABASE_SSL).toBe('off');
    expect(env.DATABASE_STATEMENT_TIMEOUT_MS).toBe(10000);
    expect(env.DATABASE_IDLE_TIMEOUT_MS).toBe(30000);
    expect(env.MEDIA_DIR).toBe('./media');
    expect(env.ADMIN_API_KEY).toBeUndefined();
  });

  it('rejects a short admin key without echoing it', () => {
    expect.assertions(3);
    try {
      loadEnv({ ...baseWithDb, ADMIN_API_KEY: 'short-secret' });
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toContain('ADMIN_API_KEY must be at least 16 characters');
      expect((err as Error).message).not.toContain('short-secret');
    }
  });

  it('accepts a long admin key', () => {
    expect(loadEnv({ ...baseWithDb, ADMIN_API_KEY: 'a-sufficiently-long-key' }).ADMIN_API_KEY).toBe(
      'a-sufficiently-long-key',
    );
  });
});
