import type { CourseService } from '../services/course.service';
import { sampleCourses } from './sampleCourses';

export interface SeedResult {
  created: string[];
  skipped: string[];
}

/**
 * Create and publish the sample courses into one org (the default org in production seeds).
 * Idempotent: a course whose slug exists in that org is skipped.
 */
export async function seedSampleCourses(
  orgId: number,
  courses: CourseService,
  mediaBaseUrl?: string,
): Promise<SeedResult> {
  const result: SeedResult = { created: [], skipped: [] };
  for (const input of sampleCourses(mediaBaseUrl)) {
    const slug = input.slug ?? '';
    if (await courses.getCourseBySlug(orgId, slug)) {
      result.skipped.push(slug);
      continue;
    }
    const course = await courses.createCourse(orgId, input);
    await courses.publish(orgId, course.id);
    result.created.push(slug);
  }
  return result;
}
