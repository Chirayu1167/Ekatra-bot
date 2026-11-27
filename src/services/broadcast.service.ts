import { BadRequestError, ConflictError, NotFoundError } from '../errors';
import { query, transactional } from '../db/pg';
import type { PgDb } from '../db/pg';
import type { InboundEventService } from './inboundEvents.service';
import type { JobService } from './jobs.service';
import type { OptOutService } from './optout.service';
import type { OutboundService } from './outbound.service';

export const MAX_BROADCAST_RECIPIENTS = 500;
const WINDOW_MS = 24 * 60 * 60 * 1000;

export type BroadcastRejectionReason =
  | 'invalid_number'
  | 'duplicate'
  | 'not_enrolled'
  | 'not_active'
  | 'consent_missing'
  | 'opted_out'
  | 'outside_window_template_required'
  | 'course_unavailable';

export type BroadcastAudience = 'course' | 'numbers' | 'all_learners';
export const BROADCAST_ENROLLMENT_STATUSES = ['pending', 'active', 'paused', 'completed'] as const;
export type BroadcastEnrollmentStatus = (typeof BROADCAST_ENROLLMENT_STATUSES)[number];

export interface AudienceCounts {
  total: number;
  pending: number;
  active: number;
  paused: number;
  completed: number;
}

interface EligibleRecipient {
  enrollmentId: number | null;
  userId: string;
  windowOpen: boolean;
}

export function normalizeBroadcastPhone(input: string): string | undefined {
  const raw = input.trim().replace(/^whatsapp:/i, '');
  const normalized = raw.replace(/[\s().-]/g, '');
  return /^\+[1-9]\d{6,14}$/.test(normalized) ? `whatsapp:${normalized}` : undefined;
}

function isWithinWindow(lastSeenAt: string | undefined): boolean {
  return lastSeenAt !== undefined && Date.now() - new Date(lastSeenAt).getTime() <= WINDOW_MS;
}

export class BroadcastService {
  constructor(
    private readonly db: PgDb,
    private readonly optOuts: OptOutService,
    private readonly inbound: InboundEventService,
    private readonly outbound: OutboundService,
    private readonly jobs: JobService,
    private readonly templateSid?: string,
  ) {}

  /**
   * Who a broadcast can reach.
   *  - `course`: everyone registered in the course (optionally narrowed by enrollment status),
   *    plus any extra numbers typed/imported.
   *  - `all_learners`: every learner registered in any course of this organisation, plus extras.
   *  - `numbers`: only the typed/imported numbers (anyone, enrolled or not). `courseId` is then
   *    just context; enrollments in that course are linked when they exist.
   * Opt-outs are always excluded. Registration itself records consent, so enrollment status and
   * consent timestamps are never a reason to block an admin-initiated notice.
   */
  async preview(input: {
    orgId: number;
    actorId: number | null;
    audience?: BroadcastAudience;
    courseId?: number;
    statuses?: BroadcastEnrollmentStatus[];
    message: string;
    phoneNumbers: string[];
  }): Promise<{
    id: number;
    audience: BroadcastAudience;
    acceptedCount: number;
    templateCount: number;
    templateConfigured: boolean;
    rejected: Array<{ reason: BroadcastRejectionReason; count: number }>;
  }> {
    const audience: BroadcastAudience =
      input.audience ?? (input.courseId !== undefined && input.phoneNumbers.length === 0 ? 'course' : 'numbers');
    if (audience === 'course' && input.courseId === undefined) {
      throw new BadRequestError('Choose a course to send to its registered learners');
    }
    if (audience === 'numbers' && input.phoneNumbers.length === 0) {
      throw new BadRequestError('Add at least one phone number');
    }

    if (input.courseId !== undefined) {
      const course = await query<{ status: string }>(
        this.db,
        'SELECT status FROM courses WHERE id = $1 AND org_id = $2',
        [input.courseId, input.orgId],
      );
      if (!course.rows[0]) throw new NotFoundError('Course not found');
      if (course.rows[0].status !== 'published') {
        throw new ConflictError('Broadcasts require a published course');
      }
    }

    // Candidate list: roster first (already normalised, with enrollment ids), then extras.
    const candidates: Array<{ raw: string; userId?: string; enrollmentId?: number | null }> = [];
    if (audience === 'course' || audience === 'all_learners') {
      const roster = await this.roster(
        input.orgId,
        audience === 'course' ? input.courseId : undefined,
        input.statuses,
      );
      for (const r of roster) candidates.push({ raw: r.userId, userId: r.userId, enrollmentId: r.enrollmentId });
    }
    for (const phone of input.phoneNumbers) candidates.push({ raw: phone });
    if (candidates.length === 0) {
      throw new ConflictError('No registered learners match this selection');
    }
    if (candidates.length > MAX_BROADCAST_RECIPIENTS) {
      throw new BadRequestError(
        `This selection has ${candidates.length} recipients; a broadcast is limited to ${MAX_BROADCAST_RECIPIENTS}. Narrow it by enrollment status or split it.`,
      );
    }

    const rejected = new Map<BroadcastRejectionReason, number>();
    const accepted: EligibleRecipient[] = [];
    const seen = new Set<string>();
    let templateCount = 0;
    for (const candidate of candidates) {
      const userId = candidate.userId ?? normalizeBroadcastPhone(candidate.raw);
      if (!userId) {
        this.increment(rejected, 'invalid_number');
        continue;
      }
      if (seen.has(userId)) {
        // A roster member who was also typed in is not a "duplicate" worth alarming about,
        // but we still count it so the numbers add up.
        this.increment(rejected, 'duplicate');
        continue;
      }
      seen.add(userId);

      const result = await this.checkRecipient(input.orgId, input.courseId, userId, candidate.enrollmentId);
      if (!result.eligible) {
        this.increment(rejected, result.reason);
        continue;
      }
      accepted.push(result.recipient);
      if (!result.recipient.windowOpen) templateCount++;
    }

    const previewId = await transactional(this.db, async (tx) => {
      await query(
        tx,
        `DELETE FROM broadcasts WHERE org_id = $1 AND status = 'draft' AND expires_at <= now()`,
        [input.orgId],
      );
      const created = await query<{ id: number }>(
        tx,
        `INSERT INTO broadcasts (org_id, course_id, created_by, message, audience)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [input.orgId, input.courseId ?? null, input.actorId, input.message, audience],
      );
      const id = Number(created.rows[0]?.id);
      if (!id) throw new Error('Failed to create broadcast preview');
      for (const recipient of accepted) {
        await query(
          tx,
          `INSERT INTO broadcast_recipients (broadcast_id, enrollment_id, user_id)
           VALUES ($1, $2, $3)`,
          [id, recipient.enrollmentId, recipient.userId],
        );
      }
      return id;
    });

    return {
      id: previewId,
      audience,
      acceptedCount: accepted.length,
      templateCount,
      templateConfigured: Boolean(this.templateSid),
      rejected: [...rejected].map(([reason, count]) => ({ reason, count })),
    };
  }

  /** Counts of registered learners, so the console can show who a course/all selection reaches. */
  async audienceCounts(orgId: number, courseId?: number): Promise<AudienceCounts> {
    const { rows } = await query<{ status: string; n: string | number }>(
      this.db,
      `SELECT status, COUNT(DISTINCT user_id) AS n FROM enrollments
       WHERE org_id = $1 AND ($2::bigint IS NULL OR course_id = $2)
       GROUP BY status`,
      [orgId, courseId ?? null],
    );
    const counts: AudienceCounts = { total: 0, pending: 0, active: 0, paused: 0, completed: 0 };
    for (const row of rows) {
      if ((BROADCAST_ENROLLMENT_STATUSES as readonly string[]).includes(row.status)) {
        counts[row.status as BroadcastEnrollmentStatus] = Number(row.n);
      }
    }
    const total = await query<{ n: string | number }>(
      this.db,
      `SELECT COUNT(DISTINCT user_id) AS n FROM enrollments
       WHERE org_id = $1 AND ($2::bigint IS NULL OR course_id = $2)`,
      [orgId, courseId ?? null],
    );
    counts.total = Number(total.rows[0]?.n ?? 0);
    return counts;
  }

  private async roster(
    orgId: number,
    courseId: number | undefined,
    statuses: BroadcastEnrollmentStatus[] | undefined,
  ): Promise<Array<{ userId: string; enrollmentId: number | null }>> {
    const wanted = statuses && statuses.length > 0 ? statuses : [...BROADCAST_ENROLLMENT_STATUSES];
    // One row per learner. For an all-learners send there is no single course, so no enrollment link.
    const { rows } = await query<{ user_id: string; enrollment_id: number | null }>(
      this.db,
      courseId !== undefined
        ? `SELECT user_id, id AS enrollment_id FROM enrollments
           WHERE org_id = $1 AND course_id = $2 AND status = ANY($3::text[]) ORDER BY id`
        : `SELECT user_id, NULL::bigint AS enrollment_id FROM enrollments
           WHERE org_id = $1 AND status = ANY($2::text[])
           GROUP BY user_id ORDER BY MIN(id)`,
      courseId !== undefined ? [orgId, courseId, wanted] : [orgId, wanted],
    );
    return rows.map((r) => ({
      userId: r.user_id,
      enrollmentId: r.enrollment_id == null ? null : Number(r.enrollment_id),
    }));
  }

  async queue(orgId: number, broadcastId: number): Promise<{ queuedCount: number; skippedCount: number }> {
    const { rows } = await query<{
      id: number;
      course_id: number | null;
      message: string;
      status: string;
      expires_at: Date | string;
    }>(
      this.db,
      `SELECT id, course_id, message, status, expires_at
       FROM broadcasts WHERE id = $1 AND org_id = $2`,
      [broadcastId, orgId],
    );
    const broadcast = rows[0];
    if (!broadcast) throw new NotFoundError('Broadcast not found');
    if (broadcast.status !== 'draft') throw new ConflictError('This broadcast has already been queued');
    if (new Date(broadcast.expires_at).getTime() <= Date.now()) {
      throw new ConflictError('This preview has expired. Review the recipients again.');
    }

    const recipients = await query<{ id: number; enrollment_id: number | null; user_id: string | null }>(
      this.db,
      `SELECT id, enrollment_id, user_id FROM broadcast_recipients
       WHERE broadcast_id = $1 AND status = 'previewed' ORDER BY id`,
      [broadcastId],
    );
    const valid: Array<{ id: number; recipient: EligibleRecipient }> = [];
    const skipped: Array<{ id: number; reason: BroadcastRejectionReason }> = [];
    for (const row of recipients.rows) {
      if (!row.user_id) {
        skipped.push({ id: row.id, reason: 'not_enrolled' });
        continue;
      }
      const result = await this.checkEnrollment(row.user_id, row.enrollment_id);
      if (result.eligible) valid.push({ id: row.id, recipient: result.recipient });
      else skipped.push({ id: row.id, reason: result.reason });
    }

    return transactional(this.db, async (tx) => {
      const locked = await query<{ status: string; expires_at: Date | string }>(
        tx,
        'SELECT status, expires_at FROM broadcasts WHERE id = $1 AND org_id = $2 FOR UPDATE',
        [broadcastId, orgId],
      );
      if (!locked.rows[0]) throw new NotFoundError('Broadcast not found');
      if (locked.rows[0].status !== 'draft') {
        throw new ConflictError('This broadcast has already been queued');
      }
      if (new Date(locked.rows[0].expires_at).getTime() <= Date.now()) {
        throw new ConflictError('This preview has expired. Review the recipients again.');
      }

      for (const item of skipped) {
        await query(
          tx,
          `UPDATE broadcast_recipients SET status = 'skipped', reason_code = $2, updated_at = now()
           WHERE id = $1 AND status = 'previewed'`,
          [item.id, item.reason],
        );
      }

      for (const item of valid) {
        const message = {
          text: broadcast.message,
          ...(!item.recipient.windowOpen && this.templateSid
            ? { contentSid: this.templateSid, templateFallback: 'none' as const }
            : {}),
        };
        const idempotencyKey = item.recipient.enrollmentId
          ? `broadcast:${broadcastId}:enrollment:${item.recipient.enrollmentId}`
          : `broadcast:${broadcastId}:user:${item.recipient.userId}`;
        const outbound = await this.outbound.createInTransaction(tx, {
          idempotencyKey,
          orgId,
          userId: item.recipient.userId,
          enrollmentId: item.recipient.enrollmentId,
          courseId: broadcast.course_id,
          kind: 'system',
          messages: [message],
        });
        await query(
          tx,
          `UPDATE broadcast_recipients
           SET outbound_message_id = $2, status = 'queued', updated_at = now()
           WHERE id = $1 AND status = 'previewed'`,
          [item.id, outbound.id],
        );
        await this.jobs.enqueue(
          {
            kind: 'outbound_send',
            dedupeKey: `outbound:${outbound.id}`,
            refType: 'outbound_messages',
            refId: outbound.id,
            payload: { messageId: outbound.id, broadcastRecipientId: item.id },
          },
          tx,
        );
      }

      await query(
        tx,
        `UPDATE broadcasts SET status = 'queued', queued_at = now()
         WHERE id = $1 AND org_id = $2`,
        [broadcastId, orgId],
      );
      return { queuedCount: valid.length, skippedCount: skipped.length };
    });
  }

  /**
   * Last check just before the worker sends. Recipients are keyed by `user_id` (stored at preview
   * time), so numbers with no enrollment and "all learners" broadcasts (no course) are valid.
   * Only things that can genuinely change after preview are re-checked: course still published
   * (when the broadcast is course-scoped), opt-out, and the 24-hour window / template.
   */
  async prepareRecipientForSend(
    recipientId: number,
    messageId: number,
  ): Promise<{ ready: boolean; reason?: BroadcastRejectionReason }> {
    const { rows } = await query<{
      course_id: number | null;
      message: string;
      user_id: string | null;
      course_status: string | null;
      outbound_message_id: number | null;
      recipient_status: string;
    }>(
      this.db,
      `SELECT b.course_id, b.message,
              COALESCE(br.user_id, e.user_id) AS user_id,
              c.status AS course_status, br.outbound_message_id, br.status AS recipient_status
       FROM broadcast_recipients br
       JOIN broadcasts b ON b.id = br.broadcast_id
       LEFT JOIN enrollments e ON e.id = br.enrollment_id
       LEFT JOIN courses c ON c.id = b.course_id AND c.org_id = b.org_id
       WHERE br.id = $1`,
      [recipientId],
    );
    const recipient = rows[0];
    if (
      !recipient ||
      !recipient.user_id ||
      recipient.outbound_message_id !== messageId ||
      recipient.recipient_status !== 'queued'
    ) {
      return { ready: false, reason: 'not_enrolled' };
    }

    let reason: BroadcastRejectionReason | undefined;
    if (recipient.course_id !== null && recipient.course_status !== 'published') {
      reason = 'course_unavailable';
    } else if (await this.optOuts.isOptedOut(recipient.user_id)) {
      reason = 'opted_out';
    }

    if (reason) {
      await this.skipRecipient(recipientId, messageId, reason);
      return { ready: false, reason };
    }

    const windowOpen = isWithinWindow(await this.inbound.lastSeenAt(recipient.user_id));
    if (!windowOpen) {
      if (!this.templateSid) {
        await this.skipRecipient(recipientId, messageId, 'outside_window_template_required');
        return { ready: false, reason: 'outside_window_template_required' };
      }
      const current = await this.outbound.getById(messageId);
      if (!current) {
        await this.skipRecipient(recipientId, messageId, 'not_enrolled');
        return { ready: false, reason: 'not_enrolled' };
      }
      const templateMessage = {
        text: recipient.message,
        contentSid: this.templateSid,
        templateFallback: 'none' as const,
      };
      if (current.messages[0]?.contentSid !== this.templateSid || current.messages[0]?.templateFallback !== 'none') {
        const replaced = await this.outbound.replaceMessagesBeforeSend(messageId, [templateMessage]);
        if (!replaced) return { ready: false, reason: 'outside_window_template_required' };
      }
    }
    return { ready: true };
  }

  async recipientIdForMessage(messageId: number): Promise<number | undefined> {
    const { rows } = await query<{ id: number }>(
      this.db,
      'SELECT id FROM broadcast_recipients WHERE outbound_message_id = $1',
      [messageId],
    );
    return rows[0] ? Number(rows[0].id) : undefined;
  }

  async status(orgId: number, broadcastId: number): Promise<{
    id: number;
    status: 'draft' | 'queued';
    total: number;
    previewed: number;
    queued: number;
    sending: number;
    sent: number;
    delivered: number;
    read: number;
    failed: number;
    unknown: number;
    skipped: number;
  }> {
    const { rows } = await query<Record<string, unknown>>(
      this.db,
      `SELECT b.id, b.status, COUNT(br.id) AS total,
         COUNT(*) FILTER (WHERE br.status = 'previewed') AS previewed,
         COUNT(*) FILTER (WHERE om.status = 'queued') AS queued,
         COUNT(*) FILTER (WHERE om.status = 'sending') AS sending,
         COUNT(*) FILTER (WHERE om.status = 'sent') AS sent,
         COUNT(*) FILTER (WHERE om.status = 'delivered') AS delivered,
         COUNT(*) FILTER (WHERE om.status = 'read') AS read,
         COUNT(*) FILTER (WHERE om.status IN ('failed', 'dead_letter')) AS failed,
         COUNT(*) FILTER (WHERE om.status = 'unknown') AS unknown,
         COUNT(*) FILTER (WHERE br.status = 'skipped') AS skipped
       FROM broadcasts b
       LEFT JOIN broadcast_recipients br ON br.broadcast_id = b.id
       LEFT JOIN outbound_messages om ON om.id = br.outbound_message_id
       WHERE b.id = $1 AND b.org_id = $2
       GROUP BY b.id`,
      [broadcastId, orgId],
    );
    const row = rows[0];
    if (!row) throw new NotFoundError('Broadcast not found');
    const number = (key: string) => Number(row[key] ?? 0);
    return {
      id: Number(row['id']),
      status: row['status'] as 'draft' | 'queued',
      total: number('total'),
      previewed: number('previewed'),
      queued: number('queued'),
      sending: number('sending'),
      sent: number('sent'),
      delivered: number('delivered'),
      read: number('read'),
      failed: number('failed'),
      unknown: number('unknown'),
      skipped: number('skipped'),
    };
  }

  private async checkRecipient(
    orgId: number,
    courseId: number | undefined,
    userId: string,
    knownEnrollmentId?: number | null,
  ): Promise<
    | { eligible: true; recipient: EligibleRecipient }
    | { eligible: false; reason: BroadcastRejectionReason }
  > {
    if (await this.optOuts.isOptedOut(userId)) return { eligible: false, reason: 'opted_out' };

    // Link an enrollment when one exists (for reporting); never require one.
    let enrollmentId: number | null = knownEnrollmentId ?? null;
    if (enrollmentId === null && courseId !== undefined) {
      const { rows } = await query<{ id: number }>(
        this.db,
        'SELECT id FROM enrollments WHERE org_id = $1 AND course_id = $2 AND user_id = $3',
        [orgId, courseId, userId],
      );
      if (rows[0]) enrollmentId = Number(rows[0].id);
    }

    const windowOpen = isWithinWindow(await this.inbound.lastSeenAt(userId));
    if (!windowOpen && !this.templateSid) {
      return { eligible: false, reason: 'outside_window_template_required' };
    }
    return { eligible: true, recipient: { enrollmentId, userId, windowOpen } };
  }

  private async checkEnrollment(
    userId: string,
    enrollmentId: number | null,
  ): Promise<
    | { eligible: true; recipient: EligibleRecipient }
    | { eligible: false; reason: BroadcastRejectionReason }
  > {
    if (await this.optOuts.isOptedOut(userId)) return { eligible: false, reason: 'opted_out' };

    const windowOpen = isWithinWindow(await this.inbound.lastSeenAt(userId));
    if (!windowOpen && !this.templateSid) {
      return { eligible: false, reason: 'outside_window_template_required' };
    }
    return { eligible: true, recipient: { enrollmentId, userId, windowOpen } };
  }

  private async skipRecipient(
    recipientId: number,
    messageId: number,
    reason: BroadcastRejectionReason,
  ): Promise<void> {
    await query(
      this.db,
      `UPDATE broadcast_recipients
       SET status = 'skipped', reason_code = $2, updated_at = now()
       WHERE id = $1 AND status = 'queued'`,
      [recipientId, reason],
    );
    await this.outbound.setStatus(messageId, 'failed');
  }

  private increment(
    counts: Map<BroadcastRejectionReason, number>,
    reason: BroadcastRejectionReason,
  ): void {
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
}
