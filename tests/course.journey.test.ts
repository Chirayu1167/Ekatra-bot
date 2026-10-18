import { describe, expect, it } from 'vitest';
import { COMMAND_HELP } from '../src/bot/courseBot';
import { REPLIES } from '../src/bot/chatbot';
import { courseCreateSchema, type CourseCreateInput } from '../src/types/course';
import {
  OTHER_USER,
  USER,
  alphaCourse,
  buildHarness,
  publishedCourse,
  singleLessonCourse,
} from './helpers';
import { pgFileContext } from './pg.helpers';
import { query } from '../src/db/pg';

const pgx = pgFileContext('course-journey');

describe('learner journey: list → start → every lesson → complete', () => {
  it('delivers the whole course in order, with media, and completes it once', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h);

    // 1. List
    const list = await h.say('COURSES');
    expect(list.res.status).toBe(200);
    expect(list.messages).toHaveLength(1);
    expect(list.all).toContain('1. *Alpha* — 3 lessons');
    expect(list.all).toContain('START 1');

    // 2. Start: intro + lesson 1
    const start = await h.say('START 1');
    expect(start.texts[0]).toContain('*Alpha*');
    expect(start.texts[0]).toContain('3 lessons');
    expect(start.texts[1]).toContain('📘 *Lesson 1 of 3: One*');
    expect(start.texts[1]).toContain('Text of lesson one.');
    expect(start.texts[1]).toContain('Reply *NEXT* for lesson 2 of 3.');
    expect((await h.enrollments.findActive(h.orgId, USER))).toMatchObject({
      lastDeliveredPosition: 1,
      status: 'active',
    });

    // 3. Lesson 2: text (+header), caption, image, document, then footer as its own message
    const two = await h.say('NEXT');
    expect(two.messages).toHaveLength(5);
    expect(two.messages[0]).toMatchObject({ body: expect.stringContaining('Lesson 2 of 3: Two') });
    expect(two.messages[1]).toEqual({ to: USER, body: 'A picture' });
    expect(two.messages[2]).toEqual({
      to: USER,
      body: '',
      mediaUrl: 'https://cdn.example.test/pic.png',
    });
    expect(two.messages[3]).toEqual({
      to: USER,
      body: '',
      mediaUrl: 'https://cdn.example.test/notes.pdf',
    });
    expect(two.messages[4]?.body).toContain('Reply *NEXT* for lesson 3 of 3.');

    // 4. Pause / resume in the middle
    expect((await h.say('PAUSE')).all).toContain('Paused *Alpha*');
    const whilePaused = await h.say('NEXT');
    expect(whilePaused.all).toContain('paused');
    expect((await h.enrollments.find(h.orgId, USER, 1))?.lastDeliveredPosition).toBe(2); // did not advance
    expect((await h.say('RESUME')).all).toContain('Welcome back to *Alpha*');
    expect((await h.say('PROGRESS')).all).toContain('2 of 3 lessons');

    // 5. Final lesson completes the course
    const three = await h.say('NEXT');
    expect(three.texts[0]).toContain('Text of lesson three.');
    expect(three.messages).toHaveLength(2);
    expect(three.texts[1]).toMatch(/^🔗 Further reading: https:\/\/example\.test\/read\n\n🎉/);
    expect(three.all).toContain("you've completed *Alpha*");
    const done = ((await h.enrollments.find(h.orgId, USER, 1)));
    expect(done).toMatchObject({ status: 'completed', lastDeliveredPosition: 3 });
    expect(done?.completedAt).toBeTruthy();
    const completedAt = done?.completedAt;

    // 6. Nothing more to send, and completion is not recorded again
    const after = await h.say('NEXT');
    expect(after.all).toContain("You've completed *Alpha*");
    expect(after.all).not.toContain('Lesson');
    expect((await h.enrollments.find(h.orgId, USER, 1))?.completedAt).toBe(completedAt);
    const rows = (await query<{ n: number }>(h.db, 'SELECT COUNT(*) AS n FROM enrollments')).rows;
    expect(Number(rows[0]?.n ?? 0)).toBe(1);
    expect((await h.say('PROGRESS')).all).toContain('(completed)');
  });

  it('a single-lesson course completes when its only lesson is delivered, exactly once', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h, singleLessonCourse());
    const start = await h.say('START tiny');
    expect(start.all).toContain("you've completed *Tiny*");
    expect((await h.enrollments.find(h.orgId, USER, 1))).toMatchObject({
      status: 'completed',
      lastDeliveredPosition: 1,
    });

    const again = await h.say('START tiny');
    expect(again.all).toContain('already completed *Tiny*');
    expect(h.sender.sent.filter((m) => m.body.includes('The only lesson.'))).toHaveLength(1);
  });

  it('keeps learners independent of each other', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h);
    await h.say('START 1');
    await h.say('NEXT');
    await h.say('START 1', { from: OTHER_USER });
    expect((await h.enrollments.findActive(h.orgId, USER))?.lastDeliveredPosition).toBe(2);
    expect((await h.enrollments.findActive(h.orgId, OTHER_USER))?.lastDeliveredPosition).toBe(1);
  });
});

describe('finding and starting courses', () => {
  it('accepts a number, slug or exact title (any case)', async () => {
    for (const ref of ['1', 'alpha', 'ALPHA']) {
      const h = await buildHarness({ pg: pgx.pool });
      await publishedCourse(h);
      const r = await h.say(`START ${ref}`);
      expect(r.texts[0], ref).toContain('*Alpha*');
    }
  });

  it('lists only published courses, with a friendly empty state', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    expect((await h.say('COURSES')).all).toContain('No courses are available yet');
    ((await h.courses.createCourse(h.orgId, alphaCourse()))); // draft
    expect((await h.say('COURSES')).all).toContain('No courses are available yet');
    ((await h.courses.publish(h.orgId, 1)));
    expect((await h.say('courses')).all).toContain('Alpha');
    expect((await h.say('1')).all).toContain('Available courses'); // menu option "1 - Start learning"
  });

  it('hides drafts from learners', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    ((await h.courses.createCourse(h.orgId, alphaCourse())));
    const r = await h.say('START 1');
    expect(r.all).toContain("couldn't find a course");
    expect((await h.enrollments.findActive(h.orgId, USER))).toBeUndefined();
  });

  it('only one active course at a time; pausing frees the learner to start another', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h);
    await publishedCourse(h, singleLessonCourse('Beta', 'beta')); // id 2
    await h.say('START 1');
    await h.say('NEXT');

    const blocked = await h.say('START beta');
    expect(blocked.all).toContain("You're currently taking *Alpha*");
    expect((await h.enrollments.find(h.orgId, USER, 2))).toBeUndefined();

    await h.say('PAUSE');
    expect((await h.say('START beta')).all).toContain('completed *Beta*');

    // Alpha is paused: START <paused course> resumes it where it stopped.
    const back = await h.say('START alpha');
    expect(back.all).toContain('Welcome back to *Alpha*');
    expect(back.all).toContain('Send *NEXT* for lesson 3');
  });

  it('lets learners finish a course that was unpublished after they joined, but not new learners', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h);
    await h.say('START 1');
    ((await h.courses.unpublish(h.orgId, 1)));
    expect((await h.say('NEXT')).all).toContain('Lesson 2 of 3');
    expect((await h.say('START 1', { from: OTHER_USER })).all).toContain("couldn't find a course");
  });
});

describe('invalid input is handled gracefully', () => {
  it.each([
    ['START', 'greeting'],
    ['start', 'greeting'],
    ['hello', 'greeting'],
    ['2', 'help'],
    ['what is this??', 'fallback'],
    ['next please', 'fallback'],
    ['', 'fallback'],
  ])('"%s" → original reply plus the course commands', async (text, kind) => {
    const h = await buildHarness({ pg: pgx.pool });
    const r = await h.say(text);
    expect(r.res.status).toBe(200);
    const original =
      kind === 'greeting' ? REPLIES.greeting : kind === 'help' ? REPLIES.help : REPLIES.fallback;
    expect(r.all).toBe(`${original}\n\n${COMMAND_HELP}`);
  });

  it.each(['START 999', 'START nonsense', 'START <number>', 'start 0'])(
    '"%s" → says it could not find the course and creates nothing',
    async (text) => {
      const h = await buildHarness({ pg: pgx.pool });
      await publishedCourse(h);
      const r = await h.say(text);
      expect(r.res.status).toBe(200);
      expect(r.all).toContain("couldn't find a course");
      expect(r.all).toContain('COURSES');
      expect((await h.enrollments.listForUser(h.orgId, USER))).toHaveLength(0);
    },
  );

  it('explains NEXT / PAUSE / RESUME / PROGRESS when there is no course', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h);
    expect((await h.say('NEXT')).all).toContain("haven't started a course");
    expect((await h.say('PAUSE')).all).toContain("don't have a course in progress");
    expect((await h.say('RESUME')).all).toContain('nothing to resume');
    expect((await h.say('PROGRESS')).all).toContain("haven't started a course");
  });

  it('is case/punctuation tolerant', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h);
    await h.say('  Start 1!  ');
    expect((await h.say('Next.')).all).toContain('Lesson 2 of 3');
    expect((await h.say('pause')).all).toContain('Paused');
  });
});

describe('repeated commands', () => {
  it('START twice does not re-enrol, resend, or reset progress', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h);
    await h.say('START 1');
    await h.say('NEXT');
    const before = h.sender.sent.length;
    const again = await h.say('START 1');
    expect(again.all).toContain('already taking *Alpha*');
    expect(again.all).toContain('2 of 3 lessons done');
    expect(h.sender.sent.length - before).toBe(1);
    expect((await h.enrollments.find(h.orgId, USER, 1))?.lastDeliveredPosition).toBe(2);
  });

  it('PAUSE and RESUME twice are harmless', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h);
    await h.say('START 1');
    await h.say('PAUSE');
    expect((await h.say('PAUSE')).all).toContain('already paused');
    await h.say('RESUME');
    expect((await h.say('RESUME')).all).toContain('already on *Alpha*');
    expect((await h.enrollments.find(h.orgId, USER, 1))?.status).toBe('active');
  });

  it('NEXT sent twice (two real messages) delivers two lessons, never the same one twice', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h);
    await h.say('START 1');
    const a = await h.say('NEXT');
    const b = await h.say('NEXT');
    expect(a.all).toContain('Lesson 2 of 3');
    expect(b.all).toContain('Lesson 3 of 3');
    expect((await h.enrollments.find(h.orgId, USER, 1))?.status).toBe('completed');
  });
});

describe('quiz gating', () => {
  const quizCourse = (): CourseCreateInput => ({
    title: 'Quizzy',
    description: '',
    slug: 'quizzy',
    lessons: [
      {
        title: 'First',
        items: [
          { kind: 'text', text: 'Learn this first.' },
          {
            kind: 'quiz',
            caption: 'Pick B.',
            options: [{ label: 'wrong' }, { label: 'right', correct: true }],
          },
        ],
      },
      { title: 'Second', items: [{ kind: 'text', text: 'Second lesson text.' }] },
    ],
  });

  it('NEXT is refused until the current lesson quiz is answered', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h, quizCourse());
    await h.say('START 1');
    const blocked = await h.say('NEXT');
    expect(blocked.all).toContain('answer the quiz');
    expect((await h.enrollments.find(h.orgId, USER, 1))?.lastDeliveredPosition).toBe(1);
  });

  it('a wrong answer gets feedback and still unlocks NEXT after any answer', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h, quizCourse());
    await h.say('START 1');
    const wrong = await h.say('A');
    expect(wrong.all).toContain('Not quite');
    expect(wrong.all).toContain('right');
    const next = await h.say('NEXT');
    expect(next.all).toContain('Lesson 2 of 2');
    expect((await h.enrollments.find(h.orgId, USER, 1))?.lastDeliveredPosition).toBe(2);
  });

  it('a correct answer is acknowledged and unlocks NEXT', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    await publishedCourse(h, quizCourse());
    await h.say('START 1');
    const right = await h.say('B');
    expect(right.texts).toEqual([
      '✅ Correct! The answer is *B) right*.\n\nSend *NEXT* for the next lesson.',
    ]);
    const next = await h.say('NEXT');
    expect(next.all).toContain('Lesson 2 of 2');
  });

  it('appends a stored quiz explanation to existing correct and incorrect feedback', async () => {
    const h = await buildHarness({ pg: pgx.pool });
    const course = courseCreateSchema.parse({
      ...quizCourse(),
      lessons: [
        {
          title: 'First',
          items: [
            {
              kind: 'quiz',
              caption: 'Pick B.',
              explanation: 'Review the example before moving on.',
              options: [{ label: 'wrong' }, { label: 'right', correct: true }],
            },
          ],
        },
        { title: 'Second', items: [{ kind: 'text', text: 'Second lesson text.' }] },
      ],
    });
    await publishedCourse(h, course);
    await h.say('START 1');

    const wrong = await h.say('A');
    expect(wrong.messages).toHaveLength(1);
    expect(wrong.all).toContain('Not quite');
    expect(wrong.all).toContain('Review the example before moving on.');
    expect(wrong.all.match(/Review the example before moving on\./g)).toHaveLength(1);
    const correct = await h.say('B');
    expect(correct.messages).toHaveLength(1);
    expect(correct.all).toContain('Correct');
    expect(correct.all).toContain('Review the example before moving on.');
    expect(correct.all.match(/Review the example before moving on\./g)).toHaveLength(1);
  });
});
