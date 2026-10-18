import { describe, expect, it } from 'vitest';
import { CourseService } from '../src/services/course.service';
import { EnrollmentService } from '../src/services/enrollment.service';
import { OrganisationsService } from '../src/services/organisations.service';
import { OTHER_USER, USER, alphaCourse, singleLessonCourse } from './helpers';
import { pgFileContext, resetDb } from './pg.helpers';

const pgx = pgFileContext('enrollment-service');

async function setup() {
  await resetDb(pgx.pool);
  const orgId = await new OrganisationsService(pgx.pool).getDefaultId();
  const courses = new CourseService(pgx.pool);
  const enrollments = new EnrollmentService(pgx.pool);
  const alpha = ((await courses.createCourse(orgId, alphaCourse()))); // 3 lessons
  const beta = ((await courses.createCourse(orgId, singleLessonCourse('Beta', 'beta'))));
  return { courses, enrollments, orgId, alpha, beta };
}

describe('EnrollmentService.begin', () => {
  it('creates an active enrolment at lesson 1, and a repeat is a no-op', async () => {
    const { enrollments, orgId, alpha } = await setup();
    expect((await enrollments.begin(orgId, USER, alpha.id, 1, false))).toBe(true);
    expect((await enrollments.begin(orgId, USER, alpha.id, 1, false))).toBe(false);
    expect((await enrollments.find(orgId, USER, alpha.id))).toMatchObject({
      status: 'active',
      lastDeliveredPosition: 1,
      completedAt: null,
    });
    expect((await enrollments.listForUser(orgId, USER))).toHaveLength(1);
  });

  it('a repeat can never reset or reopen a course', async () => {
    const { enrollments, orgId, beta } = await setup();
    ((await enrollments.begin(orgId, USER, beta.id, 1, true)));
    const done = ((await enrollments.find(orgId, USER, beta.id)));
    expect(done).toMatchObject({ status: 'completed' });
    expect((await enrollments.begin(orgId, USER, beta.id, 1, false))).toBe(false);
    expect((await enrollments.find(orgId, USER, beta.id))).toMatchObject({
      status: 'completed',
      completedAt: done?.completedAt,
    });
  });
});

describe('EnrollmentService.advance (compare-and-set)', () => {
  it('moves forward exactly one step from the expected position', async () => {
    const { enrollments, orgId, alpha } = await setup();
    ((await enrollments.begin(orgId, USER, alpha.id, 1, false)));
    const id = ((await enrollments.find(orgId, USER, alpha.id)))!.id;
    expect((await enrollments.advance(orgId, id, 1, 2, false))).toBe(true);
    expect(((await enrollments.find(orgId, USER, alpha.id)))?.lastDeliveredPosition).toBe(2);
  });

  it('a repeated or stale call changes nothing and never moves progress backwards', async () => {
    const { enrollments, orgId, alpha } = await setup();
    ((await enrollments.begin(orgId, USER, alpha.id, 1, false)));
    const id = ((await enrollments.find(orgId, USER, alpha.id)))!.id;
    ((await enrollments.advance(orgId, id, 1, 2, false)));
    ((await enrollments.advance(orgId, id, 2, 3, false)));

    expect((await enrollments.advance(orgId, id, 1, 2, false))).toBe(false); // stale: would be a regression 3 → 2
    expect((await enrollments.advance(orgId, id, 3, 3, false))).toBe(false); // no-op
    expect((await enrollments.advance(orgId, id, 0, 1, false))).toBe(false);
    expect(((await enrollments.find(orgId, USER, alpha.id)))?.lastDeliveredPosition).toBe(3);
  });

  it('cannot skip a lesson by claiming a later position', async () => {
    const { enrollments, orgId, alpha } = await setup();
    ((await enrollments.begin(orgId, USER, alpha.id, 1, false)));
    const id = ((await enrollments.find(orgId, USER, alpha.id)))!.id;
    expect((await enrollments.advance(orgId, id, 3, 4, false))).toBe(false); // caller believed progress was 3
    expect((await enrollments.advance(orgId, id, 1, 3, false))).toBe(false); // correct 'from', but jumps over lesson 2
    expect((await enrollments.advance(orgId, id, 1, 3, true))).toBe(false); // ...and cannot be used to complete early
    expect((await enrollments.find(orgId, USER, alpha.id))).toMatchObject({
      lastDeliveredPosition: 1,
      status: 'active',
    });
  });

  it('completes exactly once: the second completion attempt is rejected and completed_at is untouched', async () => {
    const { enrollments, orgId, alpha } = await setup();
    ((await enrollments.begin(orgId, USER, alpha.id, 1, false)));
    const id = ((await enrollments.find(orgId, USER, alpha.id)))!.id;
    ((await enrollments.advance(orgId, id, 1, 2, false)));
    expect((await enrollments.advance(orgId, id, 2, 3, true))).toBe(true);
    const completedAt = ((await enrollments.find(orgId, USER, alpha.id)))?.completedAt;
    expect(completedAt).toBeTruthy();

    await new Promise((r) => setTimeout(r, 5)); // so a rewritten timestamp would differ
    expect((await enrollments.advance(orgId, id, 2, 3, true))).toBe(false);
    expect((await enrollments.complete(orgId, id))).toBe(false);
    expect((await enrollments.find(orgId, USER, alpha.id))).toMatchObject({ status: 'completed', completedAt });
  });

  it('does not advance a paused enrolment', async () => {
    const { enrollments, orgId, alpha } = await setup();
    ((await enrollments.begin(orgId, USER, alpha.id, 1, false)));
    const id = ((await enrollments.find(orgId, USER, alpha.id)))!.id;
    ((await enrollments.pause(orgId, id)));
    expect((await enrollments.advance(orgId, id, 1, 2, false))).toBe(false);
    expect((await enrollments.find(orgId, USER, alpha.id))).toMatchObject({
      status: 'paused',
      lastDeliveredPosition: 1,
    });
  });
});

describe('EnrollmentService pause / resume / queries', () => {
  it('pause and resume only apply from the right state', async () => {
    const { enrollments, orgId, alpha } = await setup();
    ((await enrollments.begin(orgId, USER, alpha.id, 1, false)));
    const id = ((await enrollments.find(orgId, USER, alpha.id)))!.id;
    expect((await enrollments.resume(orgId, id))).toBe(false); // already active
    expect((await enrollments.pause(orgId, id))).toBe(true);
    expect((await enrollments.pause(orgId, id))).toBe(false); // already paused
    expect((await enrollments.resume(orgId, id))).toBe(true);
    expect(((await enrollments.findActive(orgId, USER)))?.id).toBe(id);
  });

  it('resume returns false (does not throw) when the learner has another active course', async () => {
    const { enrollments, orgId, alpha, beta } = await setup();
    ((await enrollments.begin(orgId, USER, alpha.id, 1, false)));
    const alphaId = ((await enrollments.find(orgId, USER, alpha.id)))!.id;
    ((await enrollments.pause(orgId, alphaId)));
    ((await enrollments.begin(orgId, USER, beta.id, 0, false))); // another active course
    expect((await enrollments.resume(orgId, alphaId))).toBe(false);
    expect(((await enrollments.find(orgId, USER, alpha.id)))?.status).toBe('paused');
  });

  it('never completes a paused course via complete()', async () => {
    const { enrollments, orgId, alpha } = await setup();
    ((await enrollments.begin(orgId, USER, alpha.id, 1, false)));
    const id = ((await enrollments.find(orgId, USER, alpha.id)))!.id;
    ((await enrollments.pause(orgId, id)));
    expect((await enrollments.complete(orgId, id))).toBe(false);
  });

  it('keeps each learner separate and reports course title and lesson count', async () => {
    const { enrollments, orgId, alpha } = await setup();
    ((await enrollments.begin(orgId, USER, alpha.id, 1, false)));
    expect((await enrollments.findActive(orgId, OTHER_USER))).toBeUndefined();
    expect((await enrollments.findActive(orgId, USER))).toMatchObject({ courseTitle: 'Alpha', lessonCount: 3 });
  });
});
