import { describe, expect, it, vi } from 'vitest';
import { Chatbot } from '../src/bot/chatbot';
import { CourseBot, buttonStateForStatuses } from '../src/bot/courseBot';
import { parseCommand } from '../src/bot/commands';
import { loadEnv } from '../src/config/env';
import { silentLogger } from '../src/logger';
import {
  COURSE_BUTTON_TEMPLATES,
  ensureButtonTemplates,
  type ContentApi,
} from '../src/services/buttonTemplates';
import { deliverMessages } from '../src/services/delivery';
import { query } from '../src/db/pg';
import { TwilioWhatsAppService, type TwilioMessagesClient } from '../src/services/whatsapp.service';
import { BOT, FakeSender, USER, alphaCourse, buildHarness, publishedCourse } from './helpers';
import { pgFileContext } from './pg.helpers';

const pgx = pgFileContext('buttons');

const NAV = 'HX' + 'a'.repeat(32);
const RESUME = 'HX' + 'b'.repeat(32);
const COURSES = 'HX' + 'c'.repeat(32);
const CMDS1 = 'HX' + 'd'.repeat(32);
const CMDS2 = 'HX' + 'e'.repeat(32);
const MAIN_MENU = 'HX' + 'f'.repeat(32);
const ALL = { next: NAV, resume: RESUME, courses: COURSES };
const ALL_WITH_CMDS = { next: NAV, resume: RESUME, courses: COURSES, cmds1: CMDS1, cmds2: CMDS2 };

const buttonBody = (m: { contentVariables?: Record<string, string> } | undefined) =>
  m?.contentVariables?.['1'] ?? '';

const buttonMessages = (messages: { contentSid?: string }[]) =>
  messages.filter((m) => m.contentSid);

describe('lesson buttons', () => {
  it('START ends with a Next/Pause button message instead of the typed footer', async () => {
    const h = await buildHarness({ pg: pgx.pool, buttons: ALL });
    await publishedCourse(h);
    const r = await h.say('START 1');

    expect(r.messages).toHaveLength(3); // intro, lesson text, buttons
    expect(r.texts[1]).toContain('Text of lesson one.');
    expect(r.texts[1]).not.toContain('Reply *NEXT*');
    expect(r.messages[2]).toEqual({
      to: USER,
      body: '',
      contentSid: NAV,
      contentVariables: { '1': 'Ready for lesson 2 of 3? Tap Next or reply NEXT.' },
    });
  });

  it('with media: the buttons come last, after the image and the PDF', async () => {
    const h = await buildHarness({ pg: pgx.pool, buttons: ALL });
    await publishedCourse(h);
    await h.say('START 1');
    const two = await h.say('NEXT');

    expect(
      two.messages.map((m) => (m.contentSid ? 'buttons' : m.mediaUrl ? 'media' : 'text')),
    ).toEqual(['text', 'text', 'media', 'media', 'buttons']);
    expect(two.messages.at(-1)?.contentVariables?.['1']).toContain('lesson 3 of 3');
  });

  it('the last lesson ends with a Courses button, and the course completes', async () => {
    const h = await buildHarness({ pg: pgx.pool, buttons: ALL });
    await publishedCourse(h);
    await h.say('START 1');
    await h.say('NEXT');
    const last = await h.say('NEXT');

    const btn = buttonMessages(last.messages);
    expect(btn).toHaveLength(1);
    expect(btn[0]).toMatchObject({ contentSid: COURSES });
    expect(last.messages.at(-1)?.contentVariables?.['1']).toContain("you've completed *Alpha*");
    expect((await h.enrollments.find(h.orgId, USER, 1))?.status).toBe('completed');
  });

  it('PAUSE and NEXT-while-paused offer a single-line Resume button', async () => {
    const h = await buildHarness({ pg: pgx.pool, buttons: ALL });
    await publishedCourse(h);
    await h.say('START 1');

    const paused = await h.say('PAUSE');
    expect(paused.messages).toHaveLength(1);
    expect(paused.messages[0]).toMatchObject({ contentSid: RESUME });
    expect(paused.messages[0]?.contentVariables?.['1']).toContain('Tap Resume');
    expect(paused.messages[0]?.contentVariables?.['1']).not.toContain('\n');

    expect((await h.say('NEXT')).messages[0]).toMatchObject({ contentSid: RESUME });
  });

  it('opting back in with a paused course offers Resume', async () => {
    const h = await buildHarness({ pg: pgx.pool, buttons: ALL });
    await publishedCourse(h);
    await h.say('START 1');
    await h.say('STOP');
    expect((await h.say('START')).messages[0]).toMatchObject({ contentSid: RESUME });
  });

  it('each button set is independent: only the ones configured are used', async () => {
    const h = await buildHarness({ pg: pgx.pool, buttons: { next: NAV } });
    await publishedCourse(h);
    const start = await h.say('START 1');
    expect(buttonMessages(start.messages)).toHaveLength(1);

    const pause = await h.say('PAUSE');
    expect(pause.messages[0]?.contentSid).toBeUndefined();
    expect(pause.all).toContain('Send RESUME'); // typed fallback wording
  });

  it('with no templates configured nothing changes: typed footers, no buttons', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h);
    const r = await h.say('START 1');
    expect(buttonMessages(r.messages)).toHaveLength(0);
    expect(r.texts[1]).toContain('Reply *NEXT* for lesson 2 of 3.');
  });
});

describe('tapping a button', () => {
  it('arrives as ButtonPayload and works exactly like typing the command', async () => {
    const h = await buildHarness({ pg: pgx.pool, buttons: ALL });
    await publishedCourse(h);
    await h.say('START 1');
    const tap = await h.say('Next', { payload: 'NEXT' });
    expect(tap.res.status).toBe(200);
    expect(tap.all).toContain('Lesson 2 of 3');
    expect((await h.enrollments.find(h.orgId, USER, 1))?.lastDeliveredPosition).toBe(2);
  });

  it('the payload wins over a differently worded Body; an empty payload falls back to Body', async () => {
    const h = await buildHarness({ pg: pgx.pool, buttons: ALL });
    await publishedCourse(h);
    await h.say('START 1');
    expect((await h.say('Next lesson please', { payload: 'NEXT' })).all).toContain('Lesson 2 of 3');
    const paused = await h.say('pause', { payload: '' });
    expect(paused.messages[0]?.contentVariables?.['1']).toContain('Paused');
    // Resume success keeps its text as the button body (cmds1, or Courses fallback).
    expect((await h.say('Resume', { payload: 'RESUME' })).messages[0]?.contentVariables?.['1']).toContain(
      'Welcome back',
    );
  });

  it('a double-tap (same MessageSid) is handled once', async () => {
    const h = await buildHarness({ pg: pgx.pool, buttons: ALL });
    await publishedCourse(h);
    await h.say('START 1');
    await h.say('Next', { payload: 'NEXT', sid: 'SMtap' });
    const again = await h.say('Next', { payload: 'NEXT', sid: 'SMtap' });
    expect(again.messages).toHaveLength(0);
    expect((await h.enrollments.find(h.orgId, USER, 1))?.lastDeliveredPosition).toBe(2);
  });

  it('typed commands keep working when buttons are on', async () => {
    const h = await buildHarness({ pg: pgx.pool, buttons: ALL });
    await publishedCourse(h);
    await h.say('START 1');
    expect((await h.say('next')).all).toContain('Lesson 2 of 3');
  });

  it('COURSES tap and typed COURSES both list courses after completion', async () => {
    const h = await buildHarness({ pg: pgx.pool, buttons: ALL_WITH_CMDS });
    await publishedCourse(h);
    await h.say('START 1');
    await h.say('NEXT');
    await h.say('NEXT');
    expect((await h.enrollments.find(h.orgId, USER, 1))?.status).toBe('completed');

    // A completed learner browsing the list gets plain text: the typed START <n>
    // instruction is the interface, and Next/Pause would be dead ends.
    const typed = await h.say('COURSES');
    expect(typed.res.status).toBe(200);
    expect(typed.messages).toHaveLength(1);
    expect(typed.messages[0]?.contentSid).toBeUndefined();
    expect(typed.messages[0]?.body).toContain('Available courses');
    expect(typed.messages[0]?.body).toContain('Alpha');
    expect(typed.messages[0]?.body).toContain('START 1');

    const tapped = await h.say('Courses', { payload: 'COURSES' });
    expect(tapped.res.status).toBe(200);
    expect(tapped.messages).toHaveLength(1);
    expect(tapped.messages[0]?.contentSid).toBeUndefined();
    expect(tapped.messages[0]?.body).toContain('Available courses');
    expect(tapped.messages[0]?.body).toContain('Alpha');
  });

  it('every button id is a command the bot understands', () => {
    for (const spec of COURSE_BUTTON_TEMPLATES) {
      const maxButtons = 3; // every template, including the quiz (A, B, C), fits the in-session limit
      expect(spec.buttons.length, spec.friendlyName).toBeLessThanOrEqual(maxButtons);
      for (const b of spec.buttons) {
        expect(parseCommand(b.id), b.id).not.toBeNull(); // tapping works via ButtonPayload
        expect(b.title.length).toBeLessThanOrEqual(20); // WhatsApp button title limit
      }
    }
  });
});

describe('regression: command buttons keep the real content', () => {
  it('active learner listing courses gets cmds1 with the list intact', async () => {
    const h = await buildHarness({ pg: pgx.pool, buttons: ALL_WITH_CMDS });
    await publishedCourse(h);
    await h.say('START 1');
    const r = await h.say('COURSES');
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]).toMatchObject({ contentSid: CMDS1 });
    const body = buttonBody(r.messages[0]);
    expect(body).toContain('Available courses');
    expect(body).toContain('Alpha');
    expect(body).toContain('START 1');
  });

  it('new learner listing courses gets plain text (Next/Pause would be dead ends)', async () => {
    const h = await buildHarness({ pg: pgx.pool, buttons: ALL_WITH_CMDS });
    await publishedCourse(h);
    const r = await h.say('COURSES');
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]?.contentSid).toBeUndefined();
    expect(r.messages[0]?.body).toContain('Available courses');
    expect(r.messages[0]?.body).toContain('START 1');
  });

  it('PROGRESS button body contains progress lines, not a generic prompt', async () => {
    const h = await buildHarness({ pg: pgx.pool, buttons: ALL_WITH_CMDS });
    await publishedCourse(h);
    await h.say('START 1');
    const r = await h.say('PROGRESS');
    expect(r.messages[0]).toMatchObject({ contentSid: CMDS1 });
    const body = buttonBody(r.messages[0]);
    expect(body).toContain('Your progress');
    expect(body).toContain('Alpha');
    expect(body).not.toContain('What would you like to do?');
  });

  it('unknown input keeps the help text in the button body', async () => {
    const h = await buildHarness({ pg: pgx.pool, buttons: ALL_WITH_CMDS });
    await publishedCourse(h);
    const r = await h.say('hello');
    expect(r.messages[0]).toMatchObject({ contentSid: COURSES });
    const body = buttonBody(r.messages[0]);
    expect(body).toContain('Welcome to Ekatra');
    expect(body).toContain('COURSES');
  });
});

describe('state-aware action selection', () => {
  it('maps enrollment statuses to button states with active > paused > completed > new', async () => {
    expect(buttonStateForStatuses([])).toBe('new');
    expect(buttonStateForStatuses(['completed'])).toBe('completed');
    expect(buttonStateForStatuses(['completed', 'completed'])).toBe('completed');
    expect(buttonStateForStatuses(['paused'])).toBe('paused');
    expect(buttonStateForStatuses(['completed', 'paused'])).toBe('paused');
    expect(buttonStateForStatuses(['active'])).toBe('active');
    expect(buttonStateForStatuses(['completed', 'active'])).toBe('active');
  });

  it('greeting buttons follow state: new/completed get Courses, active gets cmds1, paused gets cmds2', async () => {
    // new
    {
      const h = await buildHarness({ pg: pgx.pool, buttons: ALL_WITH_CMDS });
      await publishedCourse(h);
      const r = await h.say('hello');
      expect(r.messages).toHaveLength(1);
      expect(r.messages[0]).toMatchObject({ contentSid: COURSES });
      expect(buttonBody(r.messages[0])).toContain('Welcome to Ekatra');
    }
    // active
    {
      const h = await buildHarness({ pg: pgx.pool, buttons: ALL_WITH_CMDS });
      await publishedCourse(h);
      await h.say('START 1');
      const r = await h.say('hello');
      expect(r.messages).toHaveLength(1);
      expect(r.messages[0]).toMatchObject({ contentSid: CMDS1 });
      expect(buttonBody(r.messages[0])).toContain('Welcome to Ekatra');
    }
    // paused
    {
      const h = await buildHarness({ pg: pgx.pool, buttons: ALL_WITH_CMDS });
      await publishedCourse(h);
      await h.say('START 1');
      await h.say('PAUSE');
      const r = await h.say('hello');
      expect(r.messages).toHaveLength(1);
      expect(r.messages[0]).toMatchObject({ contentSid: CMDS2 });
    }
    // completed only
    {
      const h = await buildHarness({ pg: pgx.pool, buttons: ALL_WITH_CMDS });
      await publishedCourse(h);
      await h.say('START 1');
      await h.say('NEXT');
      await h.say('NEXT');
      const r = await h.say('hello');
      expect(r.messages).toHaveLength(1);
      expect(r.messages[0]).toMatchObject({ contentSid: COURSES });
    }
  });

  it('PROGRESS buttons follow state: active cmds1, paused cmds2, completed/empty Courses', async () => {
    // active
    {
      const h = await buildHarness({ pg: pgx.pool, buttons: ALL_WITH_CMDS });
      await publishedCourse(h);
      await h.say('START 1');
      const r = await h.say('PROGRESS');
      expect(r.messages[0]).toMatchObject({ contentSid: CMDS1 });
      expect(buttonBody(r.messages[0])).toContain('Your progress');
    }
    // paused
    {
      const h = await buildHarness({ pg: pgx.pool, buttons: ALL_WITH_CMDS });
      await publishedCourse(h);
      await h.say('START 1');
      await h.say('PAUSE');
      const r = await h.say('PROGRESS');
      expect(r.messages[0]).toMatchObject({ contentSid: CMDS2 });
      expect(buttonBody(r.messages[0])).toContain('Your progress');
    }
    // completed only
    {
      const h = await buildHarness({ pg: pgx.pool, buttons: ALL_WITH_CMDS });
      await publishedCourse(h);
      await h.say('START 1');
      await h.say('NEXT');
      await h.say('NEXT');
      const r = await h.say('PROGRESS');
      expect(r.messages[0]).toMatchObject({ contentSid: COURSES });
      expect(buttonBody(r.messages[0])).toContain('(completed)');
    }
    // empty (new learner)
    {
      const h = await buildHarness({ pg: pgx.pool, buttons: ALL_WITH_CMDS });
      await publishedCourse(h);
      const r = await h.say('PROGRESS');
      expect(r.messages[0]).toMatchObject({ contentSid: COURSES });
      expect(buttonBody(r.messages[0])).toContain("haven't started");
    }
  });

  it('active-state replies (busy, already-taking, resume success) use cmds1', async () => {
    const h = await buildHarness({ pg: pgx.pool, buttons: ALL_WITH_CMDS });
    await publishedCourse(h, alphaCourse());
    ((await h.courses.createCourse(h.orgId, {
      title: 'Beta',
      description: '',
      slug: 'beta',
      lessons: [{ title: 'One', items: [{ kind: 'text', text: 'Beta lesson.' }] }],
    })));
    ((await h.courses.publish(h.orgId, 2)));
    await h.say('START 1');

    const busy = await h.say('START 2');
    expect(busy.messages[0]).toMatchObject({ contentSid: CMDS1 });
    expect(buttonBody(busy.messages[0])).toContain('currently taking');

    const taking = await h.say('START 1');
    expect(taking.messages[0]).toMatchObject({ contentSid: CMDS1 });
    expect(buttonBody(taking.messages[0])).toContain('already taking');

    await h.say('PAUSE');
    const resumed = await h.say('RESUME');
    expect(resumed.messages[0]).toMatchObject({ contentSid: CMDS1 });
    expect(buttonBody(resumed.messages[0])).toContain('Welcome back');
  });

  it('pause/no-course, resume-with-nothing and already-subscribed offer a Courses button', async () => {
    const h = await buildHarness({ pg: pgx.pool, buttons: ALL_WITH_CMDS });
    await publishedCourse(h);

    const pause = await h.say('PAUSE');
    expect(pause.messages).toHaveLength(2);
    expect(pause.messages[0]?.body).toContain("don't have a course");
    expect(pause.messages[1]).toMatchObject({ contentSid: COURSES });

    const resume = await h.say('RESUME');
    expect(resume.messages).toHaveLength(2);
    expect(resume.messages[0]?.body).toContain('nothing to resume');
    expect(resume.messages[1]).toMatchObject({ contentSid: COURSES });

    const sub = await h.say('SUBSCRIBE');
    expect(sub.messages).toHaveLength(2);
    expect(sub.messages[0]?.body).toContain('already subscribed');
    expect(sub.messages[1]).toMatchObject({ contentSid: COURSES });
  });

  it('without any button SIDs every state stays plain typed text', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h);
    await h.say('START 1');
    await h.say('NEXT');
    await h.say('NEXT'); // completed
    for (const text of ['hello', 'COURSES', 'PROGRESS', 'NEXT', 'PAUSE']) {
      const r = await h.say(text);
      expect(r.messages.every((m) => m.contentSid === undefined), text).toBe(true);
    }
    expect((await h.say('COURSES')).all).toContain('START 1');
  });

  it('main-menu buttons pass through when nothing better is configured', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h);
    const bot = new CourseBot({
      courses: h.courses,
      enrollments: h.enrollments,
      optOuts: h.optOuts,
      orgs: h.orgs,
      fallback: new Chatbot({ mainMenuButtonSid: MAIN_MENU }),
      buttons: {},
    });
    const r = await bot.handleMessage({ userId: USER, text: 'hello' });
    expect(r).toMatchObject({ contentSid: MAIN_MENU });
  });
});

describe('regression: duplicate webhooks with buttons enabled', () => {
  it('same-MessageSid NEXT advances once and sends the button prompt once', async () => {
    const h = await buildHarness({ pg: pgx.pool, buttons: ALL_WITH_CMDS });
    await publishedCourse(h);
    await h.say('START 1');

    const first = await h.say('NEXT', { sid: 'SMdup-btn' });
    const sentAfterFirst = h.sender.sent.length;
    const second = await h.say('NEXT', { sid: 'SMdup-btn' });

    expect(first.res.status).toBe(200);
    expect(second.res.status).toBe(200);
    expect(second.messages).toHaveLength(0);
    expect(h.sender.sent.length).toBe(sentAfterFirst);
    expect((await h.enrollments.find(h.orgId, USER, 1))?.lastDeliveredPosition).toBe(2);
    const prompts = h.sender.sent.filter((m) =>
      m.contentVariables?.['1']?.includes('Ready for lesson 3 of 3'),
    );
    expect(prompts).toHaveLength(1);
  });

  it('same-MessageSid final NEXT completes once and sends the Courses button once', async () => {
    const h = await buildHarness({ pg: pgx.pool, buttons: ALL_WITH_CMDS });
    await publishedCourse(h);
    await h.say('START 1');
    await h.say('NEXT');

    const first = await h.say('NEXT', { sid: 'SMdup-final' });
    const sentAfterFirst = h.sender.sent.length;
    const second = await h.say('NEXT', { sid: 'SMdup-final' });

    expect(first.res.status).toBe(200);
    expect(second.messages).toHaveLength(0);
    expect(h.sender.sent.length).toBe(sentAfterFirst);
    expect((await h.enrollments.find(h.orgId, USER, 1))?.status).toBe('completed');
    const completions = h.sender.sent.filter((m) =>
      m.contentVariables?.['1']?.includes("you've completed *Alpha*"),
    );
    expect(completions).toHaveLength(1);
  });

  it('exact reported sequence, fresh user, typed: Hi -> Courses -> Next', async () => {
    const h = await buildHarness({ pg: pgx.pool, buttons: ALL_WITH_CMDS });
    await publishedCourse(h);

    // 1. Hi returns the welcome message and creates no enrollment.
    // New learner => single Courses action (Next/Pause would be dead ends).
    const hi = await h.say('Hi');
    expect(hi.res.status).toBe(200);
    expect(hi.messages).toHaveLength(1);
    expect(hi.messages[0]).toMatchObject({ contentSid: COURSES });
    expect(buttonBody(hi.messages[0])).toContain('Welcome to Ekatra');
    expect((await h.enrollments.listForUser(h.orgId, USER))).toHaveLength(0);

    // 2. Courses lists courses (never the greeting again). New learner => plain text:
    // the typed START <number> instruction is the interface.
    const courses = await h.say('Courses');
    expect(courses.messages).toHaveLength(1);
    expect(courses.messages[0]?.contentSid).toBeUndefined();
    expect(courses.messages[0]?.body).toContain('Available courses');
    expect(courses.messages[0]?.body).toContain('Alpha');
    expect(courses.messages[0]?.body).not.toContain('Welcome to Ekatra');

    // 3. Next with no active course is helpful and offers a Courses button.
    const next = await h.say('Next');
    expect(next.messages).toHaveLength(2);
    expect(next.messages[0]?.body).toContain("haven't started a course yet");
    expect(next.messages[1]).toMatchObject({ contentSid: COURSES });
    expect(buttonBody(next.messages[1])).toContain('Tap Courses');
    expect((await h.enrollments.listForUser(h.orgId, USER))).toHaveLength(0);
  });

  it('exact reported sequence, fresh user, button payloads: Courses/NEXT taps', async () => {
    const h = await buildHarness({ pg: pgx.pool, buttons: ALL_WITH_CMDS });
    await publishedCourse(h);
    await h.say('Hi');

    const courses = await h.say('Courses', { payload: 'COURSES' });
    expect(courses.messages).toHaveLength(1);
    expect(courses.messages[0]?.contentSid).toBeUndefined();
    expect(courses.messages[0]?.body).toContain('Available courses');
    expect(courses.messages[0]?.body).toContain('Alpha');

    const next = await h.say('Next', { payload: 'NEXT' });
    expect(next.messages).toHaveLength(2);
    expect(next.messages[0]?.body).toContain("haven't started a course yet");
    expect(next.messages[1]).toMatchObject({ contentSid: COURSES });
  });

  it('exact reported sequence after completion: Hi -> Courses -> Next', async () => {
    const h = await buildHarness({ pg: pgx.pool, buttons: ALL_WITH_CMDS });
    await publishedCourse(h);
    await h.say('START 1');
    await h.say('NEXT');
    await h.say('NEXT');
    expect((await h.enrollments.find(h.orgId, USER, 1))?.status).toBe('completed');

    // Hi is still just the greeting; it neither resumes nor resets the enrollment.
    // Completed-only learner => single Courses action.
    const hi = await h.say('Hi');
    expect(hi.messages[0]).toMatchObject({ contentSid: COURSES });
    expect(buttonBody(hi.messages[0])).toContain('Welcome to Ekatra');
    expect((await h.enrollments.find(h.orgId, USER, 1))).toMatchObject({ status: 'completed' });

    // Courses (typed and tapped) lists the courses as plain text.
    for (const opts of [{}, { payload: 'COURSES' } as const]) {
      const courses = await h.say('Courses', opts);
      expect(courses.messages).toHaveLength(1);
      expect(courses.messages[0]?.contentSid).toBeUndefined();
      expect(courses.messages[0]?.body).toContain('Available courses');
      expect(courses.messages[0]?.body).toContain('Alpha');
    }

    // Next reports the remembered completion and offers a Courses button.
    const next = await h.say('Next');
    expect(next.messages).toHaveLength(2);
    expect(next.messages[0]?.body).toContain("You've completed *Alpha*");
    expect(next.messages[1]).toMatchObject({ contentSid: COURSES });
    expect(buttonBody(next.messages[1])).toContain('Tap Courses');
    expect((await h.enrollments.find(h.orgId, USER, 1))?.status).toBe('completed');
  });

  it('failed send with buttons on: accepted 200, no progress, retry resends fully and advances once', async () => {
    const h = await buildHarness({ pg: pgx.pool, buttons: ALL_WITH_CMDS });
    await publishedCourse(h);
    await h.say('START 1');
    const base = h.sender.calls;
    // Fail the first text message of lesson 2 (index base+0).
    h.sender.failIf = (_m, i) => i === base;

    const accepted = await h.say('NEXT', { sid: 'SMretry-btn' });
    expect(accepted.res.status).toBe(200); // accepted durably; the failure is the worker's
    expect((await h.enrollments.find(h.orgId, USER, 1))?.lastDeliveredPosition).toBe(1);

    // Same-sid redelivery is a duplicate: no new work.
    h.sender.failIf = undefined;
    const redelivery = await h.say('NEXT', { sid: 'SMretry-btn' });
    expect(redelivery.res.status).toBe(200);
    expect(redelivery.messages).toHaveLength(0);

    // The scheduled retry delivers fully and advances once.
    await query(h.db, `UPDATE jobs SET run_at = now(), visible_at = now() WHERE status = 'queued'`);
    await h.drain();
    expect((await h.enrollments.find(h.orgId, USER, 1))?.lastDeliveredPosition).toBe(2);
    const prompts = h.sender.sent.filter((m) =>
      m.contentVariables?.['1']?.includes('Ready for lesson 3 of 3'),
    );
    expect(prompts).toHaveLength(1);
    expect(h.sender.sent.filter((m) => m.body.includes('Lesson 2 of 3'))).toHaveLength(1);
  });
});

describe('when the button message cannot be sent', () => {
  it('falls back to plain text with the typed command, and the lesson still counts as delivered', async () => {
    const h = await buildHarness({ pg: pgx.pool, buttons: ALL });
    await publishedCourse(h);
    h.sender.failIf = (m) => Boolean(m.contentSid);

    const r = await h.say('START 1');
    expect(r.res.status).toBe(200);
    expect(buttonMessages(r.messages)).toHaveLength(0);
    expect(r.texts.at(-1)).toBe('Reply *NEXT* for lesson 2 of 3.');
    expect((await h.enrollments.findActive(h.orgId, USER))?.lastDeliveredPosition).toBe(1);
  });

  it('a failing fallback is accepted but records nothing until the retry succeeds', async () => {
    const h = await buildHarness({ pg: pgx.pool, buttons: ALL });
    await publishedCourse(h);
    h.sender.failIf = (m) => Boolean(m.contentSid) || m.body.startsWith('Reply *NEXT*');
    const r = await h.say('START 1');
    expect(r.res.status).toBe(200); // accepted; the worker records the failure, not the webhook
    expect((await h.enrollments.findActive(h.orgId, USER))).toBeUndefined();
  });
});

describe('deliverMessages with buttons', () => {
  it('flattens line breaks, because template variables must be single-line', async () => {
    const sender = new FakeSender();
    await deliverMessages(sender, USER, [{ text: 'a\n\nb\n c', contentSid: NAV }], silentLogger);
    expect(sender.sent[0]?.contentVariables).toEqual({ '1': 'a b c' });
  });
});

describe('TwilioWhatsAppService content templates', () => {
  it('sends contentSid + JSON contentVariables and no body', async () => {
    const create = vi.fn().mockResolvedValue({ sid: 'SM1' });
    const client: TwilioMessagesClient = { messages: { create } };
    await new TwilioWhatsAppService(client, BOT, silentLogger).sendWhatsAppMessage({
      to: USER,
      body: '',
      contentSid: NAV,
      contentVariables: { '1': 'Ready?' },
    });
    expect(create).toHaveBeenCalledWith({
      from: BOT,
      to: USER,
      contentSid: NAV,
      contentVariables: '{"1":"Ready?"}',
    });
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('body');
  });
});

describe('ensureButtonTemplates (npm run buttons:setup)', () => {
  const fakeApi = (existing: { sid: string; friendlyName: string }[] = []) => {
    const create = vi.fn(async (p: { friendlyName: string }) => ({ sid: `HX${p.friendlyName}` }));
    const api: ContentApi = { list: async () => existing, create };
    return { api, create };
  };

  it('creates all nine templates as quick-reply with {{1}} body', async () => {
    const { api, create } = fakeApi();
    const result = await ensureButtonTemplates(api);
    expect(result.map((r) => [r.spec.envVar, r.created])).toEqual([
      ['TWILIO_CONTENT_SID_MAIN_MENU', true],
      ['TWILIO_CONTENT_SID_NAV', true],
      ['TWILIO_CONTENT_SID_RESUME', true],
      ['TWILIO_CONTENT_SID_START_COURSE', true],
      ['TWILIO_CONTENT_SID_COURSES', true],
      ['TWILIO_CONTENT_SID_CMDS_1', true],
      ['TWILIO_CONTENT_SID_CMDS_2', true],
      ['TWILIO_CONTENT_SID_QUIZ', true],
      ['TWILIO_CONTENT_SID_WELCOME', true],
    ]);
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      friendlyName: 'ekatra_main_menu',
      language: 'en',
      types: {
        'twilio/quick-reply': {
          body: '{{1}}',
          actions: [
            { title: '1', id: '1', type: 'QUICK_REPLY' },
            { title: '2', id: '2', type: 'QUICK_REPLY' },
          ],
        },
      },
    });
  });

  it('is idempotent: reuses templates that already exist by name', async () => {
    const { api, create } = fakeApi([{ sid: 'HXexisting', friendlyName: 'ekatra_resume' }]);
    const result = await ensureButtonTemplates(api);
    expect(create).toHaveBeenCalledTimes(8);
    expect(result.find((r) => r.spec.friendlyName === 'ekatra_resume')).toMatchObject({
      sid: 'HXexisting',
      created: false,
    });
  });
});

describe('configuration', () => {
  const base = {
    TWILIO_ACCOUNT_SID: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    TWILIO_AUTH_TOKEN: 'secret-token',
    TWILIO_WHATSAPP_FROM: 'whatsapp:+14155238886',
    DATABASE_URL: 'postgres://localhost:5432/ekatra',
  };

  it('accepts valid Content SIDs and leaves them optional', () => {
    expect(loadEnv(base).TWILIO_CONTENT_SID_NAV).toBeUndefined();
    expect(loadEnv({ ...base, TWILIO_CONTENT_SID_NAV: NAV }).TWILIO_CONTENT_SID_NAV).toBe(NAV);
  });

  it('rejects a malformed Content SID', () => {
    expect(() => loadEnv({ ...base, TWILIO_CONTENT_SID_NAV: 'not-a-sid' })).toThrow(/Content SID/);
  });
});
