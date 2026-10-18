import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { ADMIN_KEY, USER, alphaCourse, buildHarness } from './helpers';
import { pgFileContext } from './pg.helpers';

const pgx = pgFileContext('admin-api');

const auth = { Authorization: `Bearer ${ADMIN_KEY}` };
const text = (t: string) => ({ kind: 'text' as const, text: t });

async function api() {
  const h = await buildHarness({ pg: pgx.pool });
  return {
    h,
    get: (url: string) => request(h.app).get(url).set(auth),
    post: (url: string, body?: object) => request(h.app).post(url).set(auth).send(body),
    put: (url: string, body?: object) => request(h.app).put(url).set(auth).send(body),
    patch: (url: string, body?: object) => request(h.app).patch(url).set(auth).send(body),
    del: (url: string) => request(h.app).delete(url).set(auth),
  };
}

describe('admin authentication', () => {
  it('rejects requests with no key, a wrong key, or a malformed header (401)', async () => {
    const { h } = await api();
    for (const headers of [
      {},
      { Authorization: 'Bearer wrong-key-wrong-key-1' },
      { Authorization: ADMIN_KEY },
      { Authorization: 'Bearer ' },
    ]) {
      const res = await request(h.app).get('/admin/courses').set(headers);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('unauthorized');
    }
  });

  it('does not leak the key in responses', async () => {
    const { h } = await api();
    const res = await request(h.app)
      .get('/admin/courses')
      .set('Authorization', 'Bearer nope-nope-nope-nope');
    expect(JSON.stringify(res.body)).not.toContain(ADMIN_KEY);
  });

  it('is switched off entirely (404) when no admin key is configured', async () => {
    const h = await buildHarness({ pg: pgx.pool, admin: false });
    expect((await request(h.app).get('/admin/courses').set(auth)).status).toBe(404);
  });
});

describe('course management', () => {
  it('create → list → view → update → publish → unpublish → delete', async () => {
    const a = await api();

    const created = await a.post('/admin/courses', {
      title: 'Intro to Farming',
      description: 'Basics',
    });
    expect(created.status).toBe(201);
    expect(created.headers['location']).toBe(`/admin/courses/${created.body.course.id}`);
    expect(created.body.course).toMatchObject({
      slug: 'intro-to-farming',
      status: 'draft',
      lessonCount: 0,
      lessons: [],
    });
    const id = created.body.course.id;

    expect((await a.get('/admin/courses')).body.courses).toHaveLength(1);
    expect((await a.get('/admin/courses?status=published')).body.courses).toHaveLength(0);
    expect((await a.get('/admin/courses?status=draft')).body.courses).toHaveLength(1);
    expect((await a.get('/admin/courses?status=bogus')).status).toBe(400);

    const updated = await a.patch(`/admin/courses/${id}`, { title: 'Farming 101' });
    expect(updated.body.course).toMatchObject({ title: 'Farming 101', description: 'Basics' });

    // cannot publish with no lessons
    const early = await a.post(`/admin/courses/${id}/publish`);
    expect(early.status).toBe(422);
    expect(early.body.error.code).toBe('unprocessable');

    await a.post(`/admin/courses/${id}/lessons`, { title: 'Soil', items: [text('Dig.')] });
    const published = await a.post(`/admin/courses/${id}/publish`);
    expect(published.status).toBe(200);
    expect(published.body.course.status).toBe('published');
    expect((await a.post(`/admin/courses/${id}/publish`)).status).toBe(200); // idempotent

    expect((await a.post(`/admin/courses/${id}/unpublish`)).body.course.status).toBe('draft');
    expect((await a.del(`/admin/courses/${id}`)).status).toBe(204);
    expect((await a.get(`/admin/courses/${id}`)).status).toBe(404);
  });

  it('creates a course with all its lessons and every content type in one call', async () => {
    const a = await api();
    const res = await a.post('/admin/courses', alphaCourse());
    expect(res.status).toBe(201);
    const lessons = res.body.course.lessons;
    expect(lessons.map((l: { position: number }) => l.position)).toEqual([1, 2, 3]);
    expect(lessons[1].items).toEqual([
      { kind: 'text', text: 'Text of lesson two.' },
      { kind: 'image', url: 'https://cdn.example.test/pic.png', caption: 'A picture' },
      { kind: 'document', url: 'https://cdn.example.test/notes.pdf' },
    ]);
    expect(lessons[2].items[1]).toEqual({
      kind: 'link',
      url: 'https://example.test/read',
      label: 'Further reading',
    });
  });

  it('trims, returns, and preserves quiz explanations through lesson edits', async () => {
    const a = await api();
    const created = await a.post('/admin/courses', {
      title: 'Quiz course',
      lessons: [
        {
          title: 'Quiz lesson',
          items: [
            {
              kind: 'quiz',
              caption: 'Question?',
              explanation: '  Explanation text.  ',
              options: [{ label: 'A' }, { label: 'B', correct: true }],
            },
          ],
        },
      ],
    });
    expect(created.status).toBe(201);
    const courseId = created.body.course.id;
    const lessonId = created.body.course.lessons[0].id;
    expect(created.body.course.lessons[0].items[0].explanation).toBe('Explanation text.');

    const unchangedItems = await a.put(`/admin/courses/${courseId}/lessons/${lessonId}`, {
      title: 'Renamed lesson',
    });
    expect(unchangedItems.body.course.lessons[0].items[0].explanation).toBe('Explanation text.');

    const replacedItems = await a.put(`/admin/courses/${courseId}/lessons/${lessonId}`, {
      items: [
        {
          kind: 'quiz',
          caption: 'Updated question?',
          explanation: 'Updated explanation.',
          options: [{ label: 'No' }, { label: 'Yes', correct: true }],
        },
      ],
    });
    expect(replacedItems.body.course.lessons[0].items[0]).toMatchObject({
      caption: 'Updated question?',
      explanation: 'Updated explanation.',
    });
  });

  it('makes slugs unique and rejects an explicit duplicate', async () => {
    const a = await api();
    await a.post('/admin/courses', { title: 'Same Title' });
    expect((await a.post('/admin/courses', { title: 'Same Title' })).body.course.slug).toBe(
      'same-title-2',
    );
    const dup = await a.post('/admin/courses', { title: 'x', slug: 'same-title' });
    expect(dup.status).toBe(409);
    expect((await a.post('/admin/courses', { title: 'Numeric', slug: '123' })).status).toBe(400);
  });

  it('manages lessons: add, edit, delete with renumbering', async () => {
    const a = await api();
    const id = (await a.post('/admin/courses', alphaCourse())).body.course.id;
    const lessonTwo = (await a.get(`/admin/courses/${id}`)).body.course.lessons[1].id;

    const edited = await a.put(`/admin/courses/${id}/lessons/${lessonTwo}`, {
      title: 'Two (v2)',
      items: [text('New text')],
    });
    expect(edited.body.course.lessons[1]).toMatchObject({
      title: 'Two (v2)',
      items: [{ kind: 'text', text: 'New text' }],
    });

    const after = await a.del(`/admin/courses/${id}/lessons/${lessonTwo}`);
    expect(after.status).toBe(200);
    expect(
      after.body.course.lessons.map((l: { position: number; title: string }) => [
        l.position,
        l.title,
      ]),
    ).toEqual([
      [1, 'One'],
      [2, 'Three'],
    ]);

    const added = await a.post(`/admin/courses/${id}/lessons`, {
      title: 'Four',
      items: [text('x')],
    });
    expect(added.body.course.lessons.map((l: { position: number }) => l.position)).toEqual([
      1, 2, 3,
    ]);
  });

  it('refuses structural changes once learners are enrolled, but still allows content edits and appends', async () => {
    const a = await api();
    const id = (await a.post('/admin/courses', alphaCourse())).body.course.id;
    await a.post(`/admin/courses/${id}/publish`);
    await a.h.say('START 1');
    expect(await a.h.enrollments.findActive(a.h.orgId, USER)).toBeDefined();
    const lessons = (await a.get(`/admin/courses/${id}`)).body.course.lessons;

    expect((await a.del(`/admin/courses/${id}`)).status).toBe(409);
    expect((await a.del(`/admin/courses/${id}/lessons/${lessons[0].id}`)).status).toBe(409);
    expect(
      (await a.put(`/admin/courses/${id}/lessons/${lessons[2].id}`, { title: 'Three!' })).status,
    ).toBe(200);
    expect(
      (await a.post(`/admin/courses/${id}/lessons`, { title: 'Four', items: [text('more')] }))
        .status,
    ).toBe(201);

    // the learner now sees 4 lessons and edited content
    const next = await a.h.say('NEXT');
    expect(next.all).toContain('Lesson 2 of 4');
  });

  it('will not delete the only lesson of a published course', async () => {
    const a = await api();
    const id = (
      await a.post('/admin/courses', {
        title: 'One',
        lessons: [{ title: 'L', items: [text('t')] }],
      })
    ).body.course.id;
    await a.post(`/admin/courses/${id}/publish`);
    const lessonId = (await a.get(`/admin/courses/${id}`)).body.course.lessons[0].id;
    expect((await a.del(`/admin/courses/${id}/lessons/${lessonId}`)).status).toBe(409);
  });

  it('returns 404 for unknown or malformed ids', async () => {
    const a = await api();
    expect((await a.get('/admin/courses/999')).status).toBe(404);
    expect((await a.get('/admin/courses/abc')).status).toBe(404);
    expect((await a.post('/admin/courses/999/publish')).status).toBe(404);
    const id = (await a.post('/admin/courses', alphaCourse())).body.course.id;
    expect((await a.put(`/admin/courses/${id}/lessons/9999`, { title: 'x' })).status).toBe(404);
  });
});

describe('content validation (400)', () => {
  const bad = async (items: unknown[], extra: object = {}) => {
    const a = await api();
    return a.post('/admin/courses', { title: 'T', lessons: [{ title: 'L', items }], ...extra });
  };

  it.each([
    [
      'http (non-https) media URL',
      [{ kind: 'image', url: 'http://cdn.example.test/a.png' }],
      /https/,
    ],
    [
      'localhost media URL',
      [{ kind: 'document', url: 'https://localhost/a.pdf' }],
      /publicly reachable/,
    ],
    [
      'private IP media URL',
      [{ kind: 'image', url: 'https://192.168.1.5/a.png' }],
      /publicly reachable/,
    ],
    ['not a URL at all', [{ kind: 'image', url: 'not a url' }], /https/],
    [
      'pdf declared as image',
      [{ kind: 'image', url: 'https://cdn.example.test/a.pdf' }],
      /not a supported image type/,
    ],
    [
      'unsupported document type',
      [{ kind: 'document', url: 'https://cdn.example.test/run.exe' }],
      /not a supported document type/,
    ],
    [
      'webp (sticker-only)',
      [{ kind: 'image', url: 'https://cdn.example.test/a.webp' }],
      /not a supported image type/,
    ],
    ['unknown kind', [{ kind: 'sticker', url: 'https://cdn.example.test/a.png' }], /./],
    ['empty text', [{ kind: 'text', text: '   ' }], /text/],
    ['over-long text', [{ kind: 'text', text: 'x'.repeat(1201) }], /at most 1200/],
    [
      'over-long caption',
      [{ kind: 'image', url: 'https://cdn.example.test/a.png', caption: 'x'.repeat(801) }],
      /caption/,
    ],
    [
      'over-long quiz explanation',
      [
        {
          kind: 'quiz',
          caption: 'Question?',
          explanation: 'x'.repeat(1001),
          options: [{ label: 'A' }, { label: 'B' }],
        },
      ],
      /explanation/,
    ],
    ['unknown field', [{ kind: 'text', text: 'hi', caption: 'nope' }], /./],
    ['javascript: link', [{ kind: 'link', url: 'javascript:alert(1)' }], /http/],
    ['no items', [], /at least one item/],
    [
      'too many items',
      Array.from({ length: 7 }, () => ({ kind: 'text', text: 'x' })),
      /at most 6 items/,
    ],
  ])('rejects %s', async (_name, items, message) => {
    const res = await bad(items);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_request');
    expect(res.body.error.message).toMatch(message);
  });

  it('accepts URLs with no extension (e.g. signed URLs) and http links', async () => {
    const res = await bad([
      { kind: 'image', url: 'https://cdn.example.test/download?token=abc' },
      { kind: 'link', url: 'http://example.test/page' },
    ]);
    expect(res.status).toBe(201);
  });

  it('rejects a missing title, extra fields and malformed JSON with a clean 400', async () => {
    const a = await api();
    expect((await a.post('/admin/courses', {})).status).toBe(400);
    expect((await a.post('/admin/courses', { title: 'T', surprise: 1 })).status).toBe(400);
    expect((await a.patch('/admin/courses/1', {})).status).toBe(400);
    const malformed = await request(a.h.app)
      .post('/admin/courses')
      .set(auth)
      .set('Content-Type', 'application/json')
      .send('{"title": ');
    expect(malformed.status).toBe(400);
    expect(JSON.stringify(malformed.body)).not.toMatch(/at JSON|Unexpected/);
  });
});
