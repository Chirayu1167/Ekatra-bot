import { describe, expect, it, vi } from 'vitest';
import { CourseTutor, type LlmClient } from '../src/services/courseTutor';
import type { Lesson, EnrollmentSummary } from '../src/types/course';

const enrollment: EnrollmentSummary = {
  id: 1,
  orgId: 2,
  userId: 'learner-test',
  courseId: 3,
  status: 'active',
  lastDeliveredPosition: 1,
  startedAt: '',
  updatedAt: '',
  completedAt: null,
  consentAt: null,
  consentSource: null,
  consentAdminId: null,
  courseTitle: 'Water Safety',
  lessonCount: 1,
};

const lessons: Lesson[] = [{
  id: 4,
  courseId: 3,
  position: 1,
  title: 'Hydration',
  items: [
    { kind: 'text', text: 'Hydration balances water and supports health.' },
    { kind: 'quiz', caption: 'Which option is correct?', options: [{ label: 'secret answer', correct: true }, { label: 'other' }] },
  ],
}];

function tutor(llm: LlmClient, questionsPerHour = 20) {
  return new CourseTutor({
    llm,
    courses: { getAllLessons: vi.fn().mockResolvedValue(lessons) },
    questionsPerHour,
    now: () => 1_000_000,
  });
}

const question = 'How does hydration balance water for health?';

describe('course tutor operational bounds', () => {
  it('returns a safe fallback when the model times out', async () => {
    const llm = { complete: vi.fn().mockRejectedValue(new DOMException('Timed out', 'TimeoutError')) };
    const result = await tutor(llm).answer(enrollment, question);
    expect(result.kind).toBe('unavailable');
    expect(result.text).toContain("course isn't affected");
    expect(llm.complete).toHaveBeenCalledOnce();
  });

  it('returns a safe fallback when the model is unavailable', async () => {
    const llm = { complete: vi.fn().mockResolvedValue(null) };
    const result = await tutor(llm).answer(enrollment, question);
    expect(result.kind).toBe('unavailable');
    expect(result.text).toContain('send NEXT');
  });

  it('enforces the per-learner hourly usage limit before a second model call', async () => {
    const llm = { complete: vi.fn().mockResolvedValue('Hydration balances water.') };
    const bounded = tutor(llm, 1);
    expect((await bounded.answer(enrollment, question)).kind).toBe('answer');
    const limited = await bounded.answer(enrollment, question);
    expect(limited.kind).toBe('unavailable');
    expect(limited.text).toContain('last hour');
    expect(llm.complete).toHaveBeenCalledOnce();
  });
});
