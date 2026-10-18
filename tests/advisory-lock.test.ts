import { describe, expect, it } from 'vitest';
import { LOCK_CLASS } from '../src/services/lockNamespaces';

describe('advisory-lock namespaces (A2)', () => {
  it('class ids are distinct so namespaces cannot collide', () => {
    const ids = Object.values(LOCK_CLASS) as number[];
    expect(ids).toHaveLength(new Set(ids).size);
    expect(LOCK_CLASS.migration).not.toBe(LOCK_CLASS.scheduler);
    expect(LOCK_CLASS.scheduler).not.toBe(LOCK_CLASS.learner);
    expect(LOCK_CLASS.migration).not.toBe(LOCK_CLASS.learner);
    // Documented values.
    expect(LOCK_CLASS.migration).toBe(1);
    expect(LOCK_CLASS.scheduler).toBe(2);
    expect(LOCK_CLASS.learner).toBe(3);
  });
});
