import { describe, expect, it } from 'vitest';
import { createPool, query } from '../src/db/pg';
import { silentLogger } from '../src/logger';
import { USER, buildHarness, publishedCourse } from './helpers';
import { pgFileContext } from './pg.helpers';

const pgx = pgFileContext('pg-resilience');

describe('parallel duplicate webhooks', () => {
  it('the same MessageSid twice at once advances progress exactly once', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h);
    await h.say('START 1');
    const before = h.sender.sent.length;
    const [first, second] = await Promise.all([
      h.say('NEXT', { sid: 'SMparallel-dup' }),
      h.say('NEXT', { sid: 'SMparallel-dup' }),
    ]);
    expect(first.res.status).toBe(200);
    expect(second.res.status).toBe(200);
    // Exactly one claim wins (proven at the store level); per-call slices interleave under
    // concurrency, so assert on totals: one lesson-2 delivery, one advance.
    const fresh = h.sender.sent.slice(before);
    expect(fresh.filter((m) => m.body.includes('Lesson 2 of 3'))).toHaveLength(1);
    expect((await h.enrollments.find(h.orgId, USER, 1))?.lastDeliveredPosition).toBe(2);
  });
});

describe('concurrent STOP and lesson send', () => {
  it('no corruption whichever wins: paused with position 1 or 2, never skipped or duplicated', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h);
    await h.say('START 1');
    const [stop, next] = await Promise.all([h.say('STOP'), h.say('NEXT')]);
    expect(stop.res.status).toBe(200);
    expect(next.res.status).toBe(200);
    const enr = await h.enrollments.find(h.orgId, USER, 1);
    // STOP always wins the status (it pauses whatever is active, or finds it paused);
    // NEXT either delivered lesson 2 first (pos 2) or found it paused (pos 1, silent).
    expect(enr?.status).toBe('paused');
    expect([1, 2]).toContain(enr?.lastDeliveredPosition);
    expect(await h.optOuts.isOptedOut(USER)).toBe(true);
  });
});

describe('pool exhaustion and connection loss', () => {
  it('an unreachable database gives a clear connection error', async () => {
    const bad = createPool(
      {
        connectionString: 'postgres://postgres:postgres@127.0.0.1:1/ekatra',
        max: 1,
        ssl: false,
        statementTimeoutMs: 2000,
        idleTimeoutMs: 2000,
      },
      silentLogger,
    );
    await expect(query(bad, 'SELECT 1')).rejects.toThrow(/ECONNREFUSED|connect/i);
    await bad.end();
  });

  it('a runaway statement is cancelled with a clear timeout error, then the pool recovers', async () => {
    const tight = createPool(
      {
        connectionString: `postgres://postgres:postgres@127.0.0.1:${pgx.port}/${pgx.dbName}`,
        max: 5,
        ssl: false,
        statementTimeoutMs: 300,
        idleTimeoutMs: 10000,
      },
      silentLogger,
    );
    try {
      await expect(query(tight, 'SELECT pg_sleep(5)')).rejects.toThrow(/statement timeout/i);
      const { rows } = await query<{ one: number }>(tight, 'SELECT 1 AS one');
      expect(rows[0]?.one).toBe(1); // recovered: the pool serves queries again
    } finally {
      await tight.end();
    }
  });

  it('a saturated pool queues instead of deadlocking', async () => {
    const solo = createPool(
      {
        connectionString: `postgres://postgres:postgres@127.0.0.1:${pgx.port}/${pgx.dbName}`,
        max: 1,
        ssl: false,
        statementTimeoutMs: 10000,
        idleTimeoutMs: 10000,
      },
      silentLogger,
    );
    try {
      const held = await solo.connect();
      const queued = query(solo, 'SELECT 2 AS two');
      await new Promise((r) => setTimeout(r, 100));
      held.release();
      const { rows } = await queued;
      expect(rows[0]).toEqual({ two: 2 });
    } finally {
      await solo.end();
    }
  });
});
