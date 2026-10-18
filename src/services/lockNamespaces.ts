/**
 * Advisory-lock namespaces (two-integer form: pg_advisory_lock(classid, objectid)).
 *
 * Each namespace owns a distinct class id so the same object id can never collide
 * across namespaces. objectid is `hashtext(name)` computed on the SQL side.
 *
 * - migration (class 1): schema migration ledger, held across the whole migrate run.
 * - scheduler  (class 2): single-leader scheduler tick.
 * - learner    (class 3): per-learner ordering of jobs (held across sends/LLM).
 *
 * Class ids must stay distinct; see tests/advisory-lock.test.ts.
 */
export const LOCK_CLASS = {
  migration: 1,
  scheduler: 2,
  learner: 3,
} as const;

export type LockClass = (typeof LOCK_CLASS)[keyof typeof LOCK_CLASS];

/** SQL args for pg_advisory_lock(classid, objectid): [classid, hashtext(name)]. */
export function lockArgs(classId: LockClass, name: string): [number, string] {
  return [classId, name];
}
