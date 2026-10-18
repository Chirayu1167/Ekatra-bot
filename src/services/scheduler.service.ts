import { query, transactional, withTransaction } from '../db/pg';
import type { PgDb } from '../db/pg';
import { Pool } from 'pg';
import { LOCK_CLASS } from '../services/lockNamespaces';

/** Wall-clock 'HH:MM' (24h). */
export const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface WallParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  /** 0-6, Sunday = 0 (matches JS Date.getDay). */
  dow: number;
  /** YYYY-MM-DD in the zone. */
  dateStr: string;
}

const dtf = (tz: string) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  });

const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock parts of an instant in an IANA zone (DST-aware via Intl). */
export function wallParts(instantMs: number, tz: string): WallParts {
  const parts = dtf(tz).formatToParts(new Date(instantMs));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  // 'hour' can be '24' at midnight with hour12:false — normalise to 0 of the same date.
  let hour = Number(get('hour'));
  if (hour === 24) hour = 0;
  const year = Number(get('year'));
  const month = Number(get('month'));
  const day = Number(get('day'));
  return {
    year,
    month,
    day,
    hour,
    minute: Number(get('minute')),
    dow: DOW[get('weekday')] ?? 0,
    dateStr: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
}

/** UTC offset (ms) of a zone at an instant, derived from Intl wall parts. */
function offsetMsAt(instantMs: number, tz: string): number {
  const w = wallParts(instantMs, tz);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) - Math.floor(instantMs / 60000) * 60000;
}

/**
 * Convert a wall-clock time in an IANA zone to a UTC instant. Two offset
 * refinements handle DST transitions; a nonexistent wall time (spring-forward
 * gap, e.g. 02:30 on 2026-03-08 in America/Los_Angeles) resolves to the
 * post-transition instant — never throws, never absurd.
 */
export function zonedWallToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): number {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  const first = asUtc - offsetMsAt(asUtc, tz);
  // Re-read the offset at the guess: absorbs a DST transition in between.
  return asUtc - offsetMsAt(first, tz);
}

export interface CustomSlot {
  /** 0-6, Sunday = 0. */
  dow: number;
  /** Wall-clock 'HH:MM'. */
  time: string;
}

export interface EffectiveSchedule {
  timezone: string;
  /** Wall-clock 'HH:MM' every day (when no custom slots). */
  dailyTime: string | null;
  slots: CustomSlot[];
}

export interface DueSlot {
  /** Stable idempotency key part: YYYY-MM-DD + HH:MM (+dow for custom). */
  slotKey: string;
  /** When the slot starts, as a UTC instant. */
  slotTimeMs: number;
}

export type DueEvaluation =
  | { action: 'send'; slot: DueSlot }
  | { action: 'skip'; consumeUpTo: string | null }
  | { action: 'none' };

function slotKeyFor(dateStr: string, time: string): string {
  return `${dateStr}T${time}`;
}

/**
 * Evaluate which slot (if any) is due at `nowMs` for a schedule.
 * - A slot is due when its wall time has passed and it is still inside the
 *   grace window, and it is not the already-consumed `lastSlotKey`.
 * - At most ONE slot is returned: the newest due one (catch-up policy —
 *   never a burst after downtime).
 * - Slots whose window fully passed (older than grace) are reported as
 *   `skip` with the newest passed key so the caller consumes them without
 *   sending (documented grace policy).
 * Pure function — the acceptance fixtures drive it directly.
 */
export function evaluateDue(
  nowMs: number,
  sched: EffectiveSchedule,
  lastSlotKey: string | null,
  graceHours: number,
): DueEvaluation {
  const graceMs = Math.max(1, graceHours) * 3600_000;
  // Look back far enough to find passed slots worth consuming (2 days covers
  // daily + weekly-custom cadences for the skip path).
  const candidates: DueSlot[] = [];
  const seen = new Set<string>();
  const push = (dateStr: string, y: number, mo: number, d: number, time: string): void => {
    const key = slotKeyFor(dateStr, time);
    if (seen.has(key)) return; // daily/custom overlap at the same wall time = one slot
    seen.add(key);
    const [h, mi] = time.split(':').map(Number) as [number, number];
    candidates.push({ slotKey: key, slotTimeMs: zonedWallToUtcMs(y, mo, d, h ?? 0, mi ?? 0, sched.timezone) });
  };

  const nowWall = wallParts(nowMs, sched.timezone);
  // Candidate dates: yesterday, today, tomorrow (tomorrow only matters for
  // far-ahead zones; harmless otherwise since future slots are not due).
  for (let back = 2; back >= -1; back--) {
    const dateMs = Date.UTC(nowWall.year, nowWall.month - 1, nowWall.day) - back * 86_400_000;
    const dt = new Date(dateMs);
    const y = dt.getUTCFullYear();
    const mo = dt.getUTCMonth() + 1;
    const d = dt.getUTCDate();
    const dateStr = `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    // Custom slots match on the ZONE date's weekday (the UTC date can differ
    // by a day near midnight), recomputed in-zone at noon (DST-safe).
    const zoneDow = wallParts(Date.UTC(y, mo - 1, d, 12), sched.timezone).dow;
    if (sched.slots.length > 0) {
      for (const s of sched.slots) {
        if (s.dow === zoneDow) push(dateStr, y, mo, d, s.time);
      }
    } else if (sched.dailyTime) {
      push(dateStr, y, mo, d, sched.dailyTime);
    }
  }
  candidates.sort((a, b) => a.slotTimeMs - b.slotTimeMs);

  let newestDue: DueSlot | null = null;
  let newestPassed: DueSlot | null = null;
  for (const c of candidates) {
    // The cursor only ever moves forward: older slots are settled history.
    if (lastSlotKey !== null && c.slotKey <= lastSlotKey) continue;
    if (c.slotTimeMs > nowMs) break; // sorted: everything after is future
    if (nowMs - c.slotTimeMs <= graceMs) {
      newestDue = c; // keep newest (catch-up = one lesson, the latest slot)
    } else {
      newestPassed = c;
    }
  }
  if (newestDue) return { action: 'send', slot: newestDue };
  // Consuming expired slots advances a live cursor past downtime. A fresh
  // schedule (no cursor) has no history to consume — report none instead.
  if (newestPassed && lastSlotKey !== null) return { action: 'skip', consumeUpTo: newestPassed.slotKey };
  return { action: 'none' };
}

export interface ScheduleRow {
  timezone: string;
  dailyTime: string | null;
  slots: CustomSlot[];
  enabled: boolean;
  lastSlotKey: string | null;
}

export interface OrgDefaults {
  timezone: string;
  dailyTime: string | null;
  graceHours: number;
}

/**
 * Schedules + the scheduler tick. All SQL lives here.
 * Tick gates (each re-checked at SEND time by the worker, so replay/state
 * changes stay safe): active enrollment, enabled schedule, published course,
 * not opted out, not completed.
 */
export class SchedulerService {
  constructor(private readonly db: PgDb) {}

  async getOrgDefaults(orgId: number): Promise<OrgDefaults> {
    const { rows } = await query<Record<string, unknown>>(
      this.db,
      'SELECT default_timezone, default_daily_time, grace_hours FROM organisations WHERE id = $1',
      [orgId],
    );
    const row = rows[0];
    return {
      timezone: String(row?.['default_timezone'] ?? 'Asia/Kolkata'),
      dailyTime: (row?.['default_daily_time'] as string | null) ?? null,
      graceHours: Number(row?.['grace_hours'] ?? 6),
    };
  }

  async setOrgDefaults(orgId: number, input: { timezone?: string; dailyTime?: string | null; graceHours?: number }): Promise<OrgDefaults> {
    if (input.timezone !== undefined && !isValidTimezone(input.timezone)) {
      throw new Error(`invalid timezone: ${input.timezone}`);
    }
    if (input.dailyTime !== undefined && input.dailyTime !== null && !TIME_RE.test(input.dailyTime)) {
      throw new Error(`invalid dailyTime (want HH:MM): ${input.dailyTime}`);
    }
    if (input.graceHours !== undefined && (!Number.isInteger(input.graceHours) || input.graceHours < 1 || input.graceHours > 72)) {
      throw new Error('invalid graceHours (want 1..72)');
    }
    // dailyTime: undefined = leave unchanged, null = clear, 'HH:MM' = set.
    await query(
      this.db,
      `UPDATE organisations SET
         default_timezone = COALESCE($2, default_timezone),
         default_daily_time = CASE WHEN $3 THEN $4 WHEN $5 THEN NULL ELSE default_daily_time END,
         grace_hours = COALESCE($6, grace_hours)
       WHERE id = $1`,
      [
        orgId,
        input.timezone ?? null,
        input.dailyTime !== undefined && input.dailyTime !== null,
        input.dailyTime ?? null,
        input.dailyTime === null,
        input.graceHours ?? null,
      ],
    );
    return this.getOrgDefaults(orgId);
  }

  /** Course schedule upsert (org-scoped; the caller checks the course belongs to the org). */
  async setCourseSchedule(
    orgId: number,
    courseId: number,
    input: { kind: 'daily' | 'custom'; dailyTime?: string | null; slots?: CustomSlot[] | null; timezone?: string },
  ): Promise<void> {
    const timezone = input.timezone ?? 'Asia/Kolkata';
    if (!isValidTimezone(timezone)) throw new Error(`invalid timezone: ${timezone}`);
    const dailyTime = input.kind === 'daily' ? (input.dailyTime ?? null) : null;
    if (dailyTime !== null && !TIME_RE.test(dailyTime)) throw new Error(`invalid dailyTime: ${dailyTime}`);
    const slots = input.kind === 'custom' ? (input.slots ?? []) : [];
    for (const s of slots) {
      if (!Number.isInteger(s.dow) || s.dow < 0 || s.dow > 6 || !TIME_RE.test(s.time)) {
        throw new Error(`invalid slot: ${JSON.stringify(s)}`);
      }
    }
    await query(
      this.db,
      `INSERT INTO course_schedules (course_id, org_id, kind, daily_time, slots, timezone, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (course_id) DO UPDATE SET kind = $3, daily_time = $4, slots = $5, timezone = $6, updated_at = now()`,
      [courseId, orgId, input.kind, dailyTime, JSON.stringify(slots), timezone],
    );
  }

  async getCourseSchedule(orgId: number, courseId: number): Promise<Record<string, unknown> | undefined> {
    const { rows } = await query<Record<string, unknown>>(
      this.db,
      'SELECT * FROM course_schedules WHERE course_id = $1 AND org_id = $2',
      [courseId, orgId],
    );
    return rows[0];
  }

  async deleteCourseSchedule(orgId: number, courseId: number): Promise<boolean> {
    const { rowCount } = await query(
      this.db,
      'DELETE FROM course_schedules WHERE course_id = $1 AND org_id = $2',
      [courseId, orgId],
    );
    return rowCount === 1;
  }

  /** Enrollment schedule upsert (org-scoped via the enrollment). */
  async setEnrollmentSchedule(
    orgId: number,
    enrollmentId: number,
    input: { timezone?: string; dailyTime?: string | null; slots?: CustomSlot[] | null; enabled?: boolean },
  ): Promise<ScheduleRow> {
    const owned = await query<{ one: number }>(
      this.db,
      'SELECT 1 AS one FROM enrollments WHERE id = $1 AND org_id = $2',
      [enrollmentId, orgId],
    );
    if (owned.rows.length === 0) throw new Error('enrollment not found');
    if (input.timezone !== undefined && !isValidTimezone(input.timezone)) {
      throw new Error(`invalid timezone: ${input.timezone}`);
    }
    if (input.dailyTime !== undefined && input.dailyTime !== null && !TIME_RE.test(input.dailyTime)) {
      throw new Error(`invalid dailyTime: ${input.dailyTime}`);
    }
    const slots = input.slots ?? null;
    if (slots) {
      for (const s of slots) {
        if (!Number.isInteger(s.dow) || s.dow < 0 || s.dow > 6 || !TIME_RE.test(s.time)) {
          throw new Error(`invalid slot: ${JSON.stringify(s)}`);
        }
      }
    }
    const current = await this.getEnrollmentSchedule(enrollmentId);
    const timezone = input.timezone ?? current?.timezone ?? 'Asia/Kolkata';
    await query(
      this.db,
      `INSERT INTO enrollment_schedules (enrollment_id, timezone, daily_time, slots, enabled, updated_at)
       VALUES ($1, $2, $3, $4, COALESCE($5, TRUE), now())
       ON CONFLICT (enrollment_id) DO UPDATE SET
         timezone = $2,
         daily_time = $3, slots = $4,
         enabled = COALESCE($5, enrollment_schedules.enabled),
         updated_at = now()`,
      [
        enrollmentId,
        timezone,
        input.dailyTime === undefined ? (current?.dailyTime ?? null) : input.dailyTime,
        slots === null ? (current ? JSON.stringify(current.slots) : null) : JSON.stringify(slots),
        input.enabled ?? null,
      ],
    );
    const row = await this.getEnrollmentSchedule(enrollmentId);
    if (!row) throw new Error('schedule write failed');
    return row;
  }

  /** True when the enrollment belongs to the org (cross-org reads are invisible). */
  async ownsEnrollment(orgId: number, enrollmentId: number): Promise<boolean> {
    const { rows } = await query<{ one: number }>(
      this.db,
      'SELECT 1 AS one FROM enrollments WHERE id = $1 AND org_id = $2',
      [enrollmentId, orgId],
    );
    return rows.length > 0;
  }

  async getEnrollmentSchedule(enrollmentId: number): Promise<ScheduleRow | undefined> {    const { rows } = await query<Record<string, unknown>>(
      this.db,
      'SELECT * FROM enrollment_schedules WHERE enrollment_id = $1',
      [enrollmentId],
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      timezone: String(row['timezone']),
      dailyTime: (row['daily_time'] as string | null) ?? null,
      slots: Array.isArray(row['slots']) ? (row['slots'] as CustomSlot[]) : [],
      enabled: row['enabled'] === true,
      lastSlotKey: (row['last_slot_key'] as string | null) ?? null,
    };
  }

  /** Effective schedule: enrollment row wins; else course schedule; else org defaults. */
  async effectiveSchedule(orgId: number, enrollmentId: number, courseId: number): Promise<{ sched: EffectiveSchedule; enabled: boolean; lastSlotKey: string | null }> {
    const existing = await this.getEnrollmentSchedule(enrollmentId);
    if (existing && (existing.dailyTime || existing.slots.length > 0)) {
      return {
        sched: { timezone: existing.timezone, dailyTime: existing.dailyTime, slots: existing.slots },
        enabled: existing.enabled,
        lastSlotKey: existing.lastSlotKey,
      };
    }
    const course = await query<Record<string, unknown>>(
      this.db,
      'SELECT kind, daily_time, slots, timezone FROM course_schedules WHERE course_id = $1',
      [courseId],
    );
    const c = course.rows[0];
    if (c && ((c['daily_time'] as string | null) || ((c['slots'] as unknown[]) ?? []).length > 0)) {
      return {
        sched: {
          timezone: String(c['timezone'] ?? 'Asia/Kolkata'),
          dailyTime: (c['daily_time'] as string | null) ?? null,
          slots: Array.isArray(c['slots']) ? (c['slots'] as CustomSlot[]) : [],
        },
        enabled: existing?.enabled ?? true,
        lastSlotKey: existing?.lastSlotKey ?? null,
      };
    }
    const defaults = await this.getOrgDefaults(orgId);
    if (!defaults.dailyTime) {
      return {
        sched: { timezone: existing?.timezone ?? defaults.timezone, dailyTime: null, slots: [] },
        enabled: existing?.enabled ?? true,
        lastSlotKey: existing?.lastSlotKey ?? null,
      };
    }
    return {
      sched: { timezone: existing?.timezone ?? defaults.timezone, dailyTime: defaults.dailyTime, slots: [] },
      enabled: existing?.enabled ?? true,
      lastSlotKey: existing?.lastSlotKey ?? null,
    };
  }

  /** Claim a slot: first writer wins (row lock serialises); returns true when claimed. */
  async claimSlot(enrollmentId: number, slotKey: string, db: PgDb = this.db): Promise<boolean> {
    // Ensure the row exists (defaults filled lazily), then claim idempotently.
    await query(
      db,
      `INSERT INTO enrollment_schedules (enrollment_id) VALUES ($1) ON CONFLICT (enrollment_id) DO NOTHING`,
      [enrollmentId],
    );
    const { rowCount } = await query(
      db,
      `UPDATE enrollment_schedules SET last_slot_key = $2, last_sent_at = now(), updated_at = now()
       WHERE enrollment_id = $1 AND (last_slot_key IS DISTINCT FROM $2)`,
      [enrollmentId, slotKey],
    );
    return rowCount === 1;
  }

  /** Consume slots without sending (grace expiry): advances last_slot_key. */
  async consumeSlot(enrollmentId: number, slotKey: string): Promise<void> {
    await query(
      this.db,
      `INSERT INTO enrollment_schedules (enrollment_id, last_slot_key) VALUES ($1, $2)
       ON CONFLICT (enrollment_id) DO UPDATE SET last_slot_key = $2, updated_at = now()`,
      [enrollmentId, slotKey],
    );
  }

  /**
   * One scheduler tick. Single active leader via advisory try-lock (other
   * workers skip). Finds due enrollments, claims the newest due slot per
   * enrollment, and enqueues exactly one `outbound_send` job carrying a
   * `scheduledLesson` intent (rendered + guard-checked at SEND time by the
   * worker, so pause/opt-out/unpublish between tick and send stay safe).
   * Expired slots are consumed without sending. Returns counts for logs/tests.
   */
  async tick(nowMs: number): Promise<{ led: boolean; enqueued: number; skipped: number }> {
    const ownsClient = this.db instanceof Pool;
    const client = ownsClient ? await this.db.connect() : this.db;
    try {
      const lock = await query<{ got: boolean }>(
        client,
        `SELECT pg_try_advisory_lock($1, hashtext($2)) AS got`,
        [LOCK_CLASS.scheduler, 'ekatra_scheduler_tick'],
      );
      if (!lock.rows[0]?.got) return { led: false, enqueued: 0, skipped: 0 };
      try {
        return await this.runTick(nowMs, client);
      } finally {
        await query(client, `SELECT pg_advisory_unlock($1, hashtext($2))`, [
          LOCK_CLASS.scheduler,
          'ekatra_scheduler_tick',
        ]);
      }
    } finally {
      if (ownsClient) client.release();
    }
  }

  private async runTick(
    nowMs: number,
    lockClient: PgDb,
  ): Promise<{ led: boolean; enqueued: number; skipped: number }> {
      // Candidates: active enrollments, enabled (or absent) schedule row, published
      // course, learner not opted out. Deleted learners have no enrollments
      // (cascade); completed/paused are excluded here.
      const { rows } = await query<Record<string, unknown>>(
        lockClient,
        `SELECT e.id AS enrollment_id, e.org_id, e.course_id, e.user_id,
                e.last_delivered_position,
                (SELECT COUNT(*) FROM lessons l WHERE l.course_id = e.course_id) AS lesson_count,
                es.timezone AS es_timezone, es.daily_time AS es_daily, es.slots AS es_slots,
                es.enabled AS es_enabled, es.last_slot_key,
                cs.kind AS cs_kind, cs.daily_time AS cs_daily, cs.slots AS cs_slots,
                cs.timezone AS cs_timezone,
                o.default_timezone, o.default_daily_time, o.grace_hours
         FROM enrollments e
         JOIN courses c ON c.id = e.course_id AND c.status = 'published'
         JOIN organisations o ON o.id = e.org_id
         LEFT JOIN enrollment_schedules es ON es.enrollment_id = e.id
         LEFT JOIN course_schedules cs ON cs.course_id = e.course_id
         LEFT JOIN opt_outs oo ON oo.user_id = e.user_id
         WHERE e.status = 'active' AND oo.user_id IS NULL AND COALESCE(es.enabled, TRUE)`,
        [],
      );
      let enqueued = 0;
      let skipped = 0;
      for (const r of rows) {
        const enrollmentId = Number(r['enrollment_id']);
        const orgId = Number(r['org_id']);
        const courseId = Number(r['course_id']);
        const lastDelivered = Number(r['last_delivered_position'] ?? 0);
        const lessonCount = Number(r['lesson_count'] ?? 0);
        if (lessonCount === 0 || lastDelivered >= lessonCount) continue; // nothing left
        const esSlots = Array.isArray(r['es_slots']) ? (r['es_slots'] as CustomSlot[]) : [];
        const csSlots = Array.isArray(r['cs_slots']) ? (r['cs_slots'] as CustomSlot[]) : [];
        const esDaily = (r['es_daily'] as string | null) ?? null;
        const csDaily = (r['cs_daily'] as string | null) ?? null;
        const sched: EffectiveSchedule =
          esDaily || esSlots.length > 0
            ? { timezone: String(r['es_timezone'] ?? 'Asia/Kolkata'), dailyTime: esDaily, slots: esSlots }
            : csDaily || csSlots.length > 0
              ? {
                  timezone: String(r['cs_timezone'] ?? 'Asia/Kolkata'),
                  dailyTime: csDaily,
                  slots: csSlots,
                }
              : {
                  timezone: String(r['es_timezone'] ?? r['default_timezone'] ?? 'Asia/Kolkata'),
                  dailyTime: (r['default_daily_time'] as string | null) ?? null,
                  slots: [],
                };
        if (!sched.dailyTime && sched.slots.length === 0) continue; // unscheduled: NEXT only
        if (!isValidTimezone(sched.timezone)) continue;
        const lastSlotKey = (r['last_slot_key'] as string | null) ?? null;
        const graceHours = Number(r['grace_hours'] ?? 6);
        const verdict = evaluateDue(nowMs, sched, lastSlotKey, graceHours);
        if (verdict.action === 'send') {
          const result = async (tx: PgDb) => {
            const claimed = await this.claimSlot(enrollmentId, verdict.slot.slotKey, tx);
            if (!claimed) return { claimed: false, inserted: false };
            const position = lastDelivered + 1;
            const isFinal = position >= lessonCount;
            const { rowCount } = await query(
              tx,
              `INSERT INTO jobs (kind, dedupe_key, ref_type, ref_id, payload)
               VALUES ('outbound_send', $1, 'enrollments', $2, $3)
               ON CONFLICT (kind, dedupe_key) DO NOTHING`,
              [
                `sched:${enrollmentId}:${verdict.slot.slotKey}`,
                enrollmentId,
                JSON.stringify({
                  scheduledLesson: {
                    enrollmentId,
                    orgId,
                    courseId,
                    userId: String(r['user_id']),
                    position,
                    isFinal,
                    slotKey: verdict.slot.slotKey,
                    timezone: sched.timezone,
                  },
                }),
              ],
            );
            return { claimed: true, inserted: rowCount === 1 };
          };
          const resultForSlot =
            this.db instanceof Pool
              ? await withTransaction(this.db, result)
              : await transactional(this.db, result);
          if (!resultForSlot.claimed) {
            skipped++;
            continue;
          }
          if (resultForSlot.inserted) enqueued++;
          else skipped++;
        } else if (verdict.action === 'skip' && verdict.consumeUpTo) {
          await this.consumeSlot(enrollmentId, verdict.consumeUpTo);
          skipped++;
        }
      }
      return { led: true, enqueued, skipped };
  }
}
