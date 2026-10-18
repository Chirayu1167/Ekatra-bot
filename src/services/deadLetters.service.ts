import { query } from '../db/pg';
import type { PgDb } from '../db/pg';
import type { EnrollmentService } from './enrollment.service';
import type { CourseService } from './course.service';
import type { JobService } from './jobs.service';
import type { OptOutService } from './optout.service';
import type { OutboundService } from './outbound.service';
import type { DeliveryAction } from '../bot/chatbot';

export type DeadLetterKind = 'inbound' | 'outbound';
export type DeadLetterStatus = 'open' | 'replayed' | 'discarded';

export interface FailureItem {
  id: number;
  kind: DeadLetterKind;
  refId: number;
  reason: string;
  reasonCode: string;
  status: DeadLetterStatus;
  createdAt: string;
  resolvedAt: string | null;
  resolutionNote: string;
  userId: string | null;
  orgId: number | null;
  messageStatus: string | null;
  attempts: number | null;
  lessonPosition: number | null;
  courseId: number | null;
  enrollmentId: number | null;
}

export class ReplayRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayRefusedError';
  }
}

/**
 * Dead letters + controlled replay. Every failure lands here with its reason;
 * operators list, inspect, replay (a NEW attempt chain on the same idempotent
 * message row) or discard with a reason. Replay re-checks opt-out, pause and
 * course state AT REPLAY TIME — never the state from when it failed.
 * All SQL lives here; audit logging is the controller's job.
 */
export class DeadLetterService {
  constructor(
    private readonly db: PgDb,
    private readonly outbound: OutboundService,
    private readonly jobs: JobService,
    private readonly optOuts: OptOutService,
    private readonly enrollments: EnrollmentService,
    private readonly courses: CourseService,
  ) {}

  /** Org-scoped failure list + counts by reason. Inbound rows need platform scope. */
  async list(
    orgId: number,
    opts: { kind?: DeadLetterKind; status?: DeadLetterStatus; limit?: number; includeInbound?: boolean },
  ): Promise<{ failures: FailureItem[]; counts: { reasonCode: string; count: number }[] }> {
    const status = opts.status ?? 'open';
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const params: unknown[] = [orgId, status];
    let kindFilter = '';
    if (opts.kind) {
      kindFilter = 'AND dl.kind = $3';
      params.push(opts.kind);
    }
    const inboundRule = opts.includeInbound ? '' : `AND dl.kind = 'outbound'`;
    const { rows } = await query<Record<string, unknown>>(
      this.db,
      `SELECT dl.*, om.user_id, om.org_id, om.status AS message_status, om.attempts,
              om.lesson_position, om.course_id, om.enrollment_id
       FROM dead_letters dl
       LEFT JOIN outbound_messages om ON om.id = dl.ref_id AND dl.kind = 'outbound'
       WHERE (om.org_id = $1 OR (dl.kind = 'inbound')) AND dl.status = $2
         ${kindFilter} ${inboundRule}
       ORDER BY dl.created_at DESC, dl.id DESC LIMIT ${limit}`,
      params,
    );
    const failures = rows.map(mapItem);
    const counted = await query<{ reason_code: string; n: number }>(
      this.db,
      `SELECT dl.reason_code, COUNT(*) AS n
       FROM dead_letters dl
       LEFT JOIN outbound_messages om ON om.id = dl.ref_id AND dl.kind = 'outbound'
       WHERE (om.org_id = $1 OR (dl.kind = 'inbound')) AND dl.status = $2 ${kindFilter} ${inboundRule}
       GROUP BY dl.reason_code ORDER BY n DESC`,
      params,
    );
    return {
      failures,
      counts: counted.rows.map((r) => ({ reasonCode: r.reason_code, count: Number(r.n) })),
    };
  }

  /** Org-scoped inspect: failure + its attempt chain (outbound) or event (inbound). */
  async inspect(
    orgId: number,
    id: number,
    includeInbound: boolean,
  ): Promise<{ failure: FailureItem; attempts: unknown[]; event: unknown | null }> {
    const failure = await this.scoped(orgId, id, includeInbound);
    if (!failure) throw new Error('not found');
    if (failure.kind === 'outbound') {
      return { failure, attempts: await this.outbound.listAttempts(failure.refId), event: null };
    }
    const { rows } = await query(this.db, 'SELECT * FROM inbound_events WHERE id = $1', [failure.refId]);
    return { failure, attempts: [], event: rows[0] ?? null };
  }

  /**
   * Replay an open failure: new attempt chain (attempts reset), same
   * idempotency protection (same message row / event row, new job dedupe key).
   * Throws ReplayRefusedError (→ 409) when the CURRENT state forbids it.
   */
  async replay(orgId: number, id: number, includeInbound: boolean, note: string): Promise<{ messageId: number | null }> {
    const failure = await this.scoped(orgId, id, includeInbound);
    if (!failure) throw new Error('not found');
    if (failure.status !== 'open') throw new ReplayRefusedError(`already ${failure.status}`);
    if (failure.kind === 'inbound') {
      const { rows } = await query<{ message_sid: string }>(
        this.db,
        'SELECT message_sid FROM inbound_events WHERE id = $1',
        [failure.refId],
      );
      const sid = rows[0]?.message_sid;
      if (!sid) throw new ReplayRefusedError('event no longer exists');
      await query(
        this.db,
        `UPDATE inbound_events SET status = 'received', visible_at = now(), updated_at = now() WHERE id = $1`,
        [failure.refId],
      );
      await this.jobs.enqueue({
        kind: 'inbound_process',
        dedupeKey: `inbound:${sid}:replay:${failure.id}`,
        refType: 'inbound_events',
        refId: failure.refId,
        payload: { messageSid: sid },
      });
      await this.resolve(id, 'replayed', note || 'replayed by operator');
      return { messageId: null };
    }
    const message = await this.outbound.getById(failure.refId);
    if (!message) throw new ReplayRefusedError('message no longer exists');
    // Time-of-replay guards: opt-out is a hard refusal everywhere; scheduled
    // lessons additionally need an active enrollment and a published course.
    if (await this.optOuts.isOptedOut(message.userId)) {
      throw new ReplayRefusedError('learner is opted out; replay refused');
    }
    const stored = await this.storedPayload(failure.id);
    const action = normalizeAction(stored['action']);
    const storedIntent = normalizeIntent(stored['scheduledLesson']);
    if (message.kind === 'scheduled_lesson') {
      const enrollment =
        message.enrollmentId != null && message.courseId != null
          ? await this.enrollments.find(orgId, message.userId, message.courseId)
          : undefined;
      if (!enrollment || enrollment.id !== message.enrollmentId || enrollment.status !== 'active') {
        throw new ReplayRefusedError('enrollment is not active; replay refused');
      }
      const course =
        message.courseId != null ? await this.courses.getCourse(orgId, message.courseId) : undefined;
      if (!course || course.status !== 'published') {
        throw new ReplayRefusedError('course is not published; replay refused');
      }
      if (!storedIntent) throw new ReplayRefusedError('scheduled slot context lost; replay refused');
    }
    // New attempt chain on the same idempotent row.
    await query(
      this.db,
      `UPDATE outbound_messages
       SET status = 'queued', attempts = 0, error_code = NULL, error_message = NULL,
           next_retry_at = now(), updated_at = now()
       WHERE id = $1`,
      [message.id],
    );
    await this.jobs.enqueue({
      kind: 'outbound_send',
      dedupeKey: `outbound:${message.id}:replay:${failure.id}`,
      refType: 'outbound_messages',
      refId: message.id,
      payload: {
        messageId: message.id,
        ...(message.kind === 'scheduled_lesson' && storedIntent
          ? { scheduledLesson: storedIntent }
          : { progressAction: action }),
      },
    });
    await this.resolve(id, 'replayed', note || 'replayed by operator');
    return { messageId: message.id };
  }

  /** Discard an open failure with an operator reason (refusals are audit-logged too). */
  async discard(orgId: number, id: number, includeInbound: boolean, reason: string): Promise<void> {
    const failure = await this.scoped(orgId, id, includeInbound);
    if (!failure) throw new Error('not found');
    if (failure.status !== 'open') throw new ReplayRefusedError(`already ${failure.status}`);
    if (!reason.trim()) throw new ReplayRefusedError('a discard reason is required');
    await this.resolve(id, 'discarded', reason.trim().slice(0, 500));
  }

  private async scoped(orgId: number, id: number, includeInbound: boolean): Promise<FailureItem | undefined> {
    const { rows } = await query<Record<string, unknown>>(
      this.db,
      `SELECT dl.*, om.user_id, om.org_id, om.status AS message_status, om.attempts,
              om.lesson_position, om.course_id, om.enrollment_id
       FROM dead_letters dl
       LEFT JOIN outbound_messages om ON om.id = dl.ref_id AND dl.kind = 'outbound'
       WHERE dl.id = $1 AND (om.org_id = $2 OR (dl.kind = 'inbound'))`,
      [id, orgId],
    );
    const row = rows[0];
    if (!row) return undefined;
    if (row['kind'] === 'inbound' && !includeInbound) return undefined;
    return mapItem(row);
  }

  private async resolve(id: number, status: 'replayed' | 'discarded', note: string): Promise<void> {
    await query(
      this.db,
      `UPDATE dead_letters SET status = $2, resolved_at = now(), resolution_note = $3 WHERE id = $1`,
      [id, status, note],
    );
  }

  private async storedPayload(deadLetterId: number): Promise<Record<string, unknown>> {
    const { rows } = await query<{ payload: unknown }>(
      this.db,
      'SELECT payload FROM dead_letters WHERE id = $1',
      [deadLetterId],
    );
    const payload = rows[0]?.payload;
    return typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>)
      : {};
  }
}

/** Defensive parse of a stored delivery action (never trust the row blindly). */
function normalizeAction(value: unknown): DeliveryAction {
  if (typeof value !== 'object' || value === null) return { type: 'none' };
  const a = value as Record<string, unknown>;
  if (a['type'] === 'begin' && typeof a['orgId'] === 'number' && typeof a['courseId'] === 'number') {
    return {
      type: 'begin',
      orgId: a['orgId'],
      userId: String(a['userId'] ?? ''),
      courseId: a['courseId'],
      position: Number(a['position'] ?? 1),
      isFinal: a['isFinal'] === true,
    };
  }
  if (a['type'] === 'advance' && typeof a['orgId'] === 'number' && typeof a['enrollmentId'] === 'number') {
    return {
      type: 'advance',
      orgId: a['orgId'],
      enrollmentId: a['enrollmentId'],
      from: Number(a['from'] ?? 0),
      to: Number(a['to'] ?? 0),
      isFinal: a['isFinal'] === true,
      issueCertificate: a['issueCertificate'] === true,
    };
  }
  return { type: 'none' };
}

/** Defensive parse of a stored scheduled-lesson intent. */
function normalizeIntent(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const s = value as Record<string, unknown>;
  if (
    typeof s['enrollmentId'] !== 'number' ||
    typeof s['orgId'] !== 'number' ||
    typeof s['courseId'] !== 'number' ||
    typeof s['userId'] !== 'string' ||
    typeof s['position'] !== 'number' ||
    typeof s['slotKey'] !== 'string'
  ) {
    return undefined;
  }
  return {
    enrollmentId: s['enrollmentId'],
    orgId: s['orgId'],
    courseId: s['courseId'],
    userId: s['userId'],
    position: s['position'],
    isFinal: s['isFinal'] === true,
    slotKey: s['slotKey'],
    timezone: typeof s['timezone'] === 'string' ? s['timezone'] : 'UTC',
  };
}

function mapItem(row: Record<string, unknown>): FailureItem {
  return {
    id: Number(row['id']),
    kind: row['kind'] as DeadLetterKind,
    refId: Number(row['ref_id']),
    reason: String(row['reason'] ?? ''),
    reasonCode: String(row['reason_code'] ?? ''),
    status: row['status'] as DeadLetterStatus,
    createdAt: String(row['created_at']),
    resolvedAt: row['resolved_at'] == null ? null : String(row['resolved_at']),
    resolutionNote: String(row['resolution_note'] ?? ''),
    userId: (row['user_id'] as string | null) ?? null,
    orgId: row['org_id'] == null ? null : Number(row['org_id']),
    messageStatus: (row['message_status'] as string | null) ?? null,
    attempts: row['attempts'] == null ? null : Number(row['attempts']),
    lessonPosition: row['lesson_position'] == null ? null : Number(row['lesson_position']),
    courseId: row['course_id'] == null ? null : Number(row['course_id']),
    enrollmentId: row['enrollment_id'] == null ? null : Number(row['enrollment_id']),
  };
}
