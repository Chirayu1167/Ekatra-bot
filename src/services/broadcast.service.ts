import { BadRequestError, ConflictError, NotFoundError } from '../errors';
import { query, transactional } from '../db/pg';
import type { PgDb } from '../db/pg';
import type { InboundEventService } from './inboundEvents.service';
import type { JobService } from './jobs.service';
import type { OptOutService } from './optout.service';
import type { OutboundService } from './outbound.service';

export const MAX_BROADCAST_RECIPIENTS = 100;
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

interface EligibleRecipient {
  enrollmentId: number | null;
  userId: string;
  windowOpen: boolean;
}

interface EnrollmentCheck {
  id: number;
  user_id: string;
  status: string;
  consent_at: Date | string | null;
  course_status: string;
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

  async preview(input: {
    orgId: number;
    actorId: number | null;
    courseId?: number;
    message: string;
    phoneNumbers: string[];
  }): Promise<{
    id: number;
    acceptedCount: number;
    templateCount: number;
    rejected: Array<{ reason: BroadcastRejectionReason; count: number }>;
  }> {
    if (input.phoneNumbers.length > MAX_BROADCAST_RECIPIENTS) {
      throw new BadRequestError(`A broadcast is limited to ${MAX_BROADCAST_RECIPIENTS} numbers`);
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

    const rejected = new Map<BroadcastRejectionReason, number>();
    const accepted: EligibleRecipient[] = [];
    const seen = new Set<string>();
    let templateCount = 0;
    for (const phone of input.phoneNumbers) {
      const userId = normalizeBroadcastPhone(phone);
      if (!userId) {
        this.increment(rejected, 'invalid_number');
        continue;
      }
      if (seen.has(userId)) {
        this.increment(rejected, 'duplicate');
        continue;
      }
      seen.add(userId);

      const result = await this.checkRecipient(input.orgId, input.courseId, userId);
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
        `INSERT INTO broadcasts (org_id, course_id, created_by, message)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [input.orgId, input.courseId ?? null, input.actorId, input.message],
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
      acceptedCount: accepted.length,
      templateCount,
      rejected: [...rejected].map(([reason, count]) => ({ reason, count })),
    };
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

    const recipients = await query<{ id: number; enrollment_id: number | null; user_id: string }>(
      this.db,
      `SELECT id, enrollment_id, user_id FROM broadcast_recipients
       WHERE broadcast_id = $1 AND status = 'previewed' ORDER BY id`,
      [broadcastId],
    );
    const valid: Array<{ id: number; recipient: EligibleRecipient }> = [];
    const skipped: Array<{ id: number; reason: BroadcastRejectionReason }> = [];
    for (const row of recipients.rows) {
      const result = await this.checkEnrollment(orgId, broadcast.course_id, row.enrollment_id, row.user_id);
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

  async prepareRecipientForSend(
    recipientId: number,
    messageId: number,
  ): Promise<{ ready: boolean; reason?: BroadcastRejectionReason }> {
    const { rows } = await query<{
      broadcast_id: number;
      org_id: number;
      course_id: number;
      message: string;
      enrollment_id: number;
      user_id: string;
      enrollment_status: string;
      consent_at: Date | string | null;
      course_status: string;
      outbound_message_id: number | null;
      recipient_status: string;
    }>(
      this.db,
      `SELECT b.id AS broadcast_id, b.org_id, b.course_id, b.message,
              br.enrollment_id, e.user_id, e.status AS enrollment_status, e.consent_at,
              c.status AS course_status, br.outbound_message_id, br.status AS recipient_status
       FROM broadcast_recipients br
       JOIN broadcasts b ON b.id = br.broadcast_id
       JOIN enrollments e ON e.id = br.enrollment_id AND e.org_id = b.org_id
       JOIN courses c ON c.id = b.course_id AND c.org_id = b.org_id
       WHERE br.id = $1`,
      [recipientId],
    );
    const recipient = rows[0];
    if (!recipient || recipient.outbound_message_id !== messageId || recipient.recipient_status !== 'queued') {
      return { ready: false, reason: 'not_enrolled' };
    }

    let reason: BroadcastRejectionReason | undefined;
    if (recipient.course_status !== 'published') reason = 'course_unavailable';
    else if (recipient.enrollment_status !== 'active') reason = 'not_active';
    else if (recipient.consent_at == null) reason = 'consent_missing';
    else if (await this.optOuts.isOptedOut(recipient.user_id)) reason = 'opted_out';

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
  ): Promise<
    | { eligible: true; recipient: EligibleRecipient }
    | { eligible: false; reason: BroadcastRejectionReason }
  > {
    if (await this.optOuts.isOptedOut(userId)) return { eligible: false, reason: 'opted_out' };

    const { rows } = await query<EnrollmentCheck>(
      this.db,
      courseId !== undefined
        ? `SELECT e.id, e.user_id, e.status, COALESCE(e.consent_at, l.consented_at, now()) AS consent_at, c.status AS course_status
           FROM enrollments e
           JOIN courses c ON c.id = e.course_id
           LEFT JOIN learners l ON l.user_id = e.user_id
           WHERE e.org_id = $1 AND e.course_id = $2 AND e.user_id = $3`
        : `SELECT e.id, e.user_id, e.status, COALESCE(e.consent_at, l.consented_at, now()) AS consent_at, c.status AS course_status
           FROM enrollments e
           JOIN courses c ON c.id = e.course_id
           LEFT JOIN learners l ON l.user_id = e.user_id
           WHERE e.org_id = $1 AND e.user_id = $2
           ORDER BY (e.status = 'active') DESC, (e.status = 'completed') DESC, e.updated_at DESC
           LIMIT 1`,
      courseId !== undefined ? [orgId, courseId, userId] : [orgId, userId],
    );
    const row = rows[0];

    const windowOpen = isWithinWindow(await this.inbound.lastSeenAt(userId));
    if (!windowOpen && !this.templateSid) {
      return { eligible: false, reason: 'outside_window_template_required' };
    }

    return {
      eligible: true,
      recipient: {
        enrollmentId: row ? Number(row.id) : null,
        userId,
        windowOpen,
      },
    };
  }

  private async checkEnrollment(
    orgId: number,
    courseId: number | null | undefined,
    enrollmentId: number | null,
    userId: string,
  ): Promise<
    | { eligible: true; recipient: EligibleRecipient }
    | { eligible: false; reason: BroadcastRejectionReason }
  > {
    if (await this.optOuts.isOptedOut(userId)) return { eligible: false, reason: 'opted_out' };

    const windowOpen = isWithinWindow(await this.inbound.lastSeenAt(userId));
    if (!windowOpen && !this.templateSid) {
      return { eligible: false, reason: 'outside_window_template_required' };
    }

    return {
      eligible: true,
      recipient: {
        enrollmentId,
        userId,
        windowOpen,
      },
    };
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
