import { describe, expect, it } from 'vitest';
import { COMMAND_HELP } from '../src/bot/courseBot';
import { REPLIES } from '../src/bot/chatbot';
import { parseKeyword } from '../src/bot/commands';
import { OTHER_USER, USER, buildHarness, publishedCourse } from './helpers';
import { pgFileContext } from './pg.helpers';

const pgx = pgFileContext('optout');

describe('parseKeyword', () => {
  it.each(['stop', 'STOP', 'Stop.', ' stopall ', 'unsubscribe!', 'cancel', 'END', 'quit'])(
    '%j is an opt-out',
    (text) => expect(parseKeyword(text)).toEqual({ kind: 'stop' }),
  );

  it.each([
    ['start', 'start'],
    ['UNSTOP', 'unstop'],
    ['Subscribe.', 'subscribe'],
  ])('%j is an opt-in', (text, word) =>
    expect(parseKeyword(text)).toEqual({ kind: 'optin', word }),
  );

  it.each(['stop the lesson', 'please stop', 'start 1', 'stopping', 'next', '', 'the end'])(
    '%j is neither (only the whole message counts)',
    (text) => expect(parseKeyword(text)).toBeNull(),
  );
});

describe('STOP opt-out', () => {
  it('unsubscribes, pauses the active course, keeps progress, and confirms once', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h);
    await h.say('START 1');
    await h.say('NEXT');

    const stop = await h.say('STOP');
    expect(stop.res.status).toBe(200);
    expect(stop.messages).toHaveLength(1);
    expect(stop.all).toContain("You're unsubscribed");
    expect(stop.all).toContain('Send START');
    expect((await h.optOuts.isOptedOut(USER))).toBe(true);
    expect((await h.enrollments.find(h.orgId, USER, 1))).toMatchObject({
      status: 'paused',
      lastDeliveredPosition: 2,
    });
  });

  it('is silent while opted out: no lessons, no notices, no state changes (STOP confirm only)', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h);
    await h.say('START 1');
    await h.say('STOP');
    const before = h.sender.sent.length;

    for (const text of [
      'NEXT',
      'COURSES',
      'START 1',
      'RESUME',
      'PROGRESS',
      'hello',
      '1',
      'whatever',
    ]) {
      const r = await h.say(text);
      expect(r.res.status, text).toBe(200);
      expect(r.messages, text).toHaveLength(0); // silence: only STOP gets a confirmation
    }
    expect(h.sender.sent.length - before).toBe(0);
    expect((await h.enrollments.find(h.orgId, USER, 1))).toMatchObject({
      status: 'paused',
      lastDeliveredPosition: 1,
    });
  });

  it('STOP twice is harmless', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await h.say('STOP');
    const again = await h.say('stop');
    expect(again.all).toContain('already unsubscribed');
    expect((await h.optOuts.isOptedOut(USER))).toBe(true);
  });

  it('opting back in does not resume by itself, and the course continues where it stopped', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h);
    await h.say('START 1');
    await h.say('NEXT');
    await h.say('STOP');

    const back = await h.say('START');
    expect(back.all).toContain('subscribed again');
    expect(back.all).toContain('RESUME');
    expect(back.all).toContain('*Alpha*');
    expect((await h.optOuts.isOptedOut(USER))).toBe(false);
    expect((await h.enrollments.find(h.orgId, USER, 1))?.status).toBe('paused'); // not auto-resumed

    await h.say('RESUME');
    const next = await h.say('NEXT');
    expect(next.all).toContain('Lesson 3 of 3'); // not 1 or 2
    expect((await h.enrollments.find(h.orgId, USER, 1))?.status).toBe('completed');
  });

  it.each(['unstop', 'SUBSCRIBE'])('"%s" also opts back in', async (word) => {
    const h = await buildHarness({ pg: pgx.pool });
    await h.say('STOP');
    expect((await h.say(word)).all).toContain('subscribed again');
    expect((await h.optOuts.isOptedOut(USER))).toBe(false);
  });

  it('opting in from a learner who never opted out: bare START is still the greeting', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    const r = await h.say('START');
    expect(r.all).toBe(`${REPLIES.greeting}\n\n${COMMAND_HELP}`);
  });

  it('UNSTOP / SUBSCRIBE from a subscribed learner is a harmless no-op', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    expect((await h.say('subscribe')).all).toContain('already subscribed');
    expect((await h.optOuts.isOptedOut(USER))).toBe(false);
  });

  it('only the whole message opts out: "stop the lesson" and "START 1" are not keywords', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h);
    await h.say('stop the lesson');
    expect((await h.optOuts.isOptedOut(USER))).toBe(false);

    await h.say('STOP');
    const r = await h.say('START 1'); // a course start is not an opt-in
    expect(r.messages).toHaveLength(0); // silence while opted out
    expect((await h.enrollments.find(h.orgId, USER, 1))).toBeUndefined();
  });

  it('is per learner', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h);
    await h.say('STOP');
    const other = await h.say('START 1', { from: OTHER_USER });
    expect(other.texts[0]).toContain('*Alpha*');
    expect((await h.optOuts.isOptedOut(OTHER_USER))).toBe(false);
  });

  it('a duplicate STOP webhook is ignored', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await h.say('STOP', { sid: 'SMstop' });
    const sent = h.sender.sent.length;
    const dup = await h.say('STOP', { sid: 'SMstop' });
    expect(dup.messages).toHaveLength(0);
    expect(h.sender.sent.length).toBe(sent);
  });

  it('survives a restart', async () => {
    await buildHarness({ pg: pgx.pool }); // reset to pristine
    const h1 = await buildHarness({ pg: pgx.pool, pgFresh: false });
    await publishedCourse(h1);
    await h1.say('START 1');
    await h1.say('STOP');

    // New connections to the same database (simulates a process restart).
    const h2 = await buildHarness({ pg: pgx.freshPool(), pgFresh: false });
    const quiet = await h2.say('NEXT');
    expect(quiet.messages).toHaveLength(0); // silence survives restarts too
    expect(h2.sender.sent.some((m) => m.body.includes('Lesson 2'))).toBe(false);
    await h2.pool.end();
  });
});
