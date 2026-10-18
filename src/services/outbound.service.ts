import { query } from '../db/pg';
import type { PgDb } from '../db/pg';
import type { ReplyMessage } from './delivery';
import { classifySendError, RETRY_MAX_ATTEMPTS, statusRegresses } from './retry';

export type OutboundStatus =
  | 'queued'
  | 'sending'
  | 'sent'
  | 'delivered'
  | 'read'
  | 'failed'
  | 'unknown'
  | 'dead_letter';

export type OutboundKind = 'reply' | 'scheduled_lesson' | 'certificate' | 'system' | 'template';

export interface OutboundMessage {
  id: number;
  idempotencyKey: string;
  orgId: number | null;
  userId: string;
  enrollmentId: number | null;
  courseId: number | null;
  lessonPosition: number | null;
  kind: OutboundKind;
  messages: ReplyMessage[];
  status: OutboundStatus;
  twilioSid: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  attempts: number;
}

export interface OutboundAttempt {
  messageId: number;
  attemptNo: number;
  twilioSid: string | null;
  status: 'sent' | 'failed' | 'unknown';
  errorCode: string | null;
}

/**
 * The single outbound pipeline: every send creates a row keyed by an idempotency
 * key (learner/lesson/kind or learner/MessageSid/kind), the worker sends through
 * the OptOutGuardSender, and each attempt is recorded with its Twilio MessageSid,
 * status and error code. Progress commits only after a confirmed send (the
 * caller — the worker — runs onDelivered after status 'sent').
 * Permanent errors go straight to dead_letter; transient ones retry with
 * backoff up to the cap; uncertain outcomes become 'unknown' and are NEVER
 * blindly resent (reconcile via status callback / Twilio lookup first).
 * All SQL lives here.
 */
export class OutboundService {
  constructor(private readonly db: PgDb) {}

  /** Idempotent create. Returns the row and whether it was newly created. */
  async create(input: {
    idempotencyKey: string;
    orgId?: number | null;
    userId: string;
    enrollmentId?: number | null;
    courseId?: number | null;
    lessonPosition?: number | null;
    kind?: OutboundKind;
    messages: ReplyMessage[];
  }): Promise<{ message: OutboundMessage; isNew: boolean }> {
    const row = await this.insertAndFetch(this.db, input);
    const { rows } = await query<{ n: number }>(
      this.db,
      `SELECT COUNT(*) AS n FROM outbound_attempts WHERE message_id = $1`,
      [row.id],
    );
    return { message: row, isNew: Number(rows[0]?.n ?? 0) === 0 && row.attempts === 0 };
  }

  /**
   * Idempotent create inside a caller-supplied transaction client. Used so the
   * certificate-resend cooldown mark and the outbound insert commit atomically:
   * if the insert fails, the cooldown is not consumed.
   */
  async createInTransaction(tx: PgDb, input: {
    idempotencyKey: string;
    orgId?: number | null;
    userId: string;
    enrollmentId?: number | null;
    courseId?: number | null;
    lessonPosition?: number | null;
    kind?: OutboundKind;
    messages: ReplyMessage[];
  }): Promise<OutboundMessage> {
    return this.insertAndFetch(tx, input);
  }

  /** Insert an outbound row (idempotent by key) on `db` and return it. */
  private async insertAndFetch(db: PgDb, input: {
    idempotencyKey: string;
    orgId?: number | null;
    userId: string;
    enrollmentId?: number | null;
    courseId?: number | null;
    lessonPosition?: number | null;
    kind?: OutboundKind;
    messages: ReplyMessage[];
  }): Promise<OutboundMessage> {
    await query(
      db,
      `INSERT INTO outbound_messages
         (idempotency_key, org_id, user_id, enrollment_id, course_id, lesson_position, kind, messages)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        input.idempotencyKey,
        input.orgId ?? null,
        input.userId,
        input.enrollmentId ?? null,
        input.courseId ?? null,
        input.lessonPosition ?? null,
        input.kind ?? 'reply',
        JSON.stringify(input.messages),
      ],
    );
    const rows = await query<Record<string, unknown>>(
      db,
      'SELECT * FROM outbound_messages WHERE idempotency_key = $1',
      [input.idempotencyKey],
    );
    const row = rows.rows[0];
    if (!row) throw new Error('outbound create failed');
    return mapRow(row);
  }

  async getByKey(idempotencyKey: string): Promise<OutboundMessage | undefined> {
    const { rows } = await query<Record<string, unknown>>(
      this.db,
      'SELECT * FROM outbound_messages WHERE idempotency_key = $1',
      [idempotencyKey],
    );
    const row = rows[0];
    return row ? mapRow(row) : undefined;
  }

  async getById(id: number): Promise<OutboundMessage | undefined> {
    const { rows } = await query<Record<string, unknown>>(
      this.db,
      'SELECT * FROM outbound_messages WHERE id = $1',
      [id],
    );
    const row = rows[0];
    return row ? mapRow(row) : undefined;
  }

  /** Positions of lesson items already confirmed sent for this message. */
  async listSentItemPositions(messageId: number): Promise<Set<number>> {
    const { rows } = await query<{ item_position: number }>(
      this.db,
      'SELECT item_position FROM outbound_message_items WHERE message_id = $1',
      [messageId],
    );
    return new Set(rows.map((r) => r.item_position));
  }

  /** Record that one lesson item was sent (idempotent). */
  async markItemSent(messageId: number, itemPosition: number, twilioSid: string | null): Promise<void> {
    await query(
      this.db,
      `INSERT INTO outbound_message_items (message_id, item_position, twilio_sid)
       VALUES ($1, $2, $3)
       ON CONFLICT (message_id, item_position) DO UPDATE SET twilio_sid = $3, sent_at = now()`,
      [messageId, itemPosition, twilioSid],
    );
  }

  /** True when every item (0..totalItems-1) has a sent marker. */
  async allItemsSent(messageId: number, totalItems: number): Promise<boolean> {
    const { rows } = await query<{ n: number }>(
      this.db,
      'SELECT COUNT(*) AS n FROM outbound_message_items WHERE message_id = $1',
      [messageId],
    );
    return Number(rows[0]?.n ?? 0) >= totalItems;
  }

  /**
   * Record a partial success: some items sent, more remain. Status stays 'failed' with a
   * retry backoff so the worker continues from the first unsent item. Returns 'retry'.
   */
  async recordPartialSend(messageId: number, sid: string): Promise<'retry'> {
    const attemptNo = await this.nextAttemptNo(messageId);
    await query(
      this.db,
      `INSERT INTO outbound_attempts (message_id, attempt_no, twilio_sid, status)
       VALUES ($1, $2, $3, 'sent')`,
      [messageId, attemptNo, sid],
    );
    const current = await this.getById(messageId);
    const attempts = (current?.attempts ?? 0) + 1;
    const delaySecs = Math.max(1, Math.round((30_000 * 2 ** (attempts - 1)) / 1000));
    await query(
      this.db,
      `UPDATE outbound_messages
       SET attempts = $2, status = 'failed', twilio_sid = COALESCE(twilio_sid, $3),
          sent_at = COALESCE(sent_at, now()), next_retry_at = now() + make_interval(secs => $4),
          updated_at = now()
       WHERE id = $1`,
      [messageId, attempts, sid, Math.min(delaySecs, 3600)],
    );
    return 'retry';
  }

  /** A learner's outbound messages in one org (most recent first), used by learner-data export. */
  async listByUser(userId: string, orgId: number | null, limit = 100): Promise<OutboundMessage[]> {
    const { rows } = await query<Record<string, unknown>>(
      this.db,
      `SELECT * FROM outbound_messages
       WHERE user_id = $1 AND org_id = $2
       ORDER BY created_at DESC, id DESC LIMIT $3`,
      [userId, orgId, limit],
    );
    return rows.map(mapRow);
  }

  async getByTwilioSid(sid: string): Promise<OutboundMessage | undefined> {
    const { rows } = await query<Record<string, unknown>>(
      this.db,
      'SELECT * FROM outbound_messages WHERE twilio_sid = $1',
      [sid],
    );
    const row = rows[0];
    return row ? mapRow(row) : undefined;
  }

  async listAttempts(messageId: number): Promise<OutboundAttempt[]> {
    const { rows } = await query<Record<string, unknown>>(
      this.db,
      'SELECT * FROM outbound_attempts WHERE message_id = $1 ORDER BY attempt_no',
      [messageId],
    );
    return rows.map((r) => ({
      messageId: Number(r['message_id']),
      attemptNo: Number(r['attempt_no']),
      twilioSid: (r['twilio_sid'] as string | null) ?? null,
      status: r['status'] as OutboundAttempt['status'],
      errorCode: (r['error_code'] as string | null) ?? null,
    }));
  }

  /**
   * Record the outcome of one send attempt and move the message row.
   * - ok + sid: attempts+1, status 'sent', twilio_sid set (first sid wins).
   * - transient failure: attempts+1, status 'failed', next_retry_at set — unless
   *   the cap is reached, in which case 'dead_letter' + dead_letters row.
   * - permanent failure: 'dead_letter' immediately + dead_letters row with reason.
   * - unknown (timeout/crash after request): 'unknown', parked for reconcile.
   * Returns 'sent' | 'retry' | 'dead_letter' | 'unknown'.
   */
  async recordAttempt(
    messageId: number,
    outcome: { ok: true; sid: string } | { ok: false; error: unknown },
  ): Promise<'sent' | 'retry' | 'dead_letter' | 'unknown'> {
    if (outcome.ok) {
      const attemptNo = await this.nextAttemptNo(messageId);
      await query(
        this.db,
        `INSERT INTO outbound_attempts (message_id, attempt_no, twilio_sid, status)
         VALUES ($1, $2, $3, 'sent')`,
        [messageId, attemptNo, outcome.sid],
      );
      // The REST call returned, so the send is confirmed: single state move.
      await query(
        this.db,
        `UPDATE outbound_messages
         SET attempts = attempts + 1, status = 'sent', twilio_sid = COALESCE(twilio_sid, $2),
             sent_at = COALESCE(sent_at, now()), error_code = NULL, error_message = NULL,
             next_retry_at = NULL, updated_at = now()
         WHERE id = $1`,
        [messageId, outcome.sid],
      );
      return 'sent';
    }
    const classification = classifySendError(outcome.error);
    const { code, message } = describeError(outcome.error);
    const attemptNo = await this.nextAttemptNo(messageId);
    if (classification === 'unknown') {
      await query(
        this.db,
        `INSERT INTO outbound_attempts (message_id, attempt_no, status, error_code, error_message)
         VALUES ($1, $2, 'unknown', $3, $4)`,
        [messageId, attemptNo, code, message],
      );
      await query(
        this.db,
        `UPDATE outbound_messages SET attempts = attempts + 1, status = 'unknown',
           error_code = $2, error_message = $3, next_retry_at = NULL, updated_at = now()
         WHERE id = $1`,
        [messageId, code, message],
      );
      return 'unknown';
    }
    if (classification === 'permanent') {
      await query(
        this.db,
        `INSERT INTO outbound_attempts (message_id, attempt_no, status, error_code, error_message)
         VALUES ($1, $2, 'failed', $3, $4)`,
        [messageId, attemptNo, code, message],
      );
      await query(this.db, 'UPDATE outbound_messages SET attempts = attempts + 1 WHERE id = $1', [
        messageId,
      ]);
      await this.toDeadLetter(messageId, code ?? 'permanent', message, { attempts: attemptNo });
      return 'dead_letter';
    }
    // transient
    const current = await this.getById(messageId);
    const attempts = (current?.attempts ?? 0) + 1;
    await query(
      this.db,
      `INSERT INTO outbound_attempts (message_id, attempt_no, status, error_code, error_message)
       VALUES ($1, $2, 'failed', $3, $4)`,
      [messageId, attemptNo, code, message],
    );
    await query(this.db, 'UPDATE outbound_messages SET attempts = $2 WHERE id = $1', [
      messageId,
      attempts,
    ]);
    if (attempts >= RETRY_MAX_ATTEMPTS) {
      await this.toDeadLetter(messageId, code ?? 'retry_cap', `Retry cap reached (${attempts} attempts). Last: ${message}`, {
        attempts,
      });
      return 'dead_letter';
    }
    const delaySecs = Math.max(1, Math.round((30_000 * 2 ** (attempts - 1)) / 1000));
    await query(
      this.db,
      `UPDATE outbound_messages SET attempts = $2, status = 'failed', error_code = $3,
         error_message = $4, next_retry_at = now() + make_interval(secs => $5), updated_at = now()
       WHERE id = $1`,
      [messageId, attempts, code, message, Math.min(delaySecs, 3600)],
    );
    return 'retry';
  }

  /**
   * Apply a Twilio status callback. Signed + deduped by the caller; this only
   * moves the row forward (delivered can never go back to sent). Also records
   * the sid when the callback references one we have not seen (reconcile).
   */
  async applyStatusCallback(
    twilioSid: string,
    twilioStatus: string,
  ): Promise<OutboundMessage | undefined> {
    const target = normalizeTwilioStatus(twilioStatus);
    if (!target) return undefined;
    const current = await this.getByTwilioSid(twilioSid);
    if (!current) return undefined;
    if (statusRegresses(current.status, target)) return current;
    if (current.status === target) return current;
    await query(
      this.db,
      `UPDATE outbound_messages SET status = $2,
         delivered_at = CASE WHEN $2 IN ('delivered','read') THEN COALESCE(delivered_at, now()) ELSE delivered_at END,
         error_code = CASE WHEN $2 IN ('failed') THEN error_code ELSE NULL END,
         updated_at = now()
       WHERE id = $1`,
      [current.id, target],
    );
    if (target === 'failed') {
      // A late failure after we thought it sent: surfaced, not retried blindly.
      await this.toDeadLetter(current.id, 'twilio_callback_failed', `Twilio reported ${twilioStatus}`, {
        sid: twilioSid,
      });
    }
    return this.getById(current.id);
  }

  /** Reconcile an 'unknown' message: only resend when proven not delivered. */
  async reconcileUnknown(messageId: number, delivered: boolean, note: string): Promise<void> {
    if (delivered) {
      await this.setStatus(messageId, 'delivered');
      return;
    }
    // Proven not delivered: back to queued for one more careful attempt.
    await query(
      this.db,
      `UPDATE outbound_messages SET status = 'queued', next_retry_at = now(), updated_at = now()
       WHERE id = $1 AND status = 'unknown'`,
      [messageId],
    );
    await this.noteDeadLetter(messageId, 'unknown_reconciled_not_delivered', note);
  }

  async setStatus(messageId: number, status: OutboundStatus): Promise<void> {
    await query(this.db, 'UPDATE outbound_messages SET status = $1, updated_at = now() WHERE id = $2', [
      status,
      messageId,
    ]);
  }

  async toDeadLetter(messageId: number, reasonCode: string, reason: string, payload: unknown): Promise<number> {
    await query(
      this.db,
      `UPDATE outbound_messages SET status = 'dead_letter', error_code = $2, error_message = $3, updated_at = now() WHERE id = $1`,
      [messageId, reasonCode.slice(0, 200), reason.slice(0, 1000)],
    );
    // One open dead letter per message: reuse it when the same message fails again
    // (e.g. an 'unknown' that later reports 'failed' via callback).
    const existing = await query<{ id: number }>(
      this.db,
      `SELECT id FROM dead_letters WHERE kind = 'outbound' AND ref_id = $1 AND status = 'open' ORDER BY id LIMIT 1`,
      [messageId],
    );
    if (existing.rows[0]) {
      await query(
        this.db,
        `UPDATE dead_letters SET reason = $2, reason_code = $3, payload = $4 WHERE id = $1`,
        [existing.rows[0].id, reason.slice(0, 1000), reasonCode.slice(0, 200), JSON.stringify(payload ?? {})],
      );
      return Number(existing.rows[0].id);
    }
    const { rows } = await query<{ id: number }>(
      this.db,
      `INSERT INTO dead_letters (kind, ref_id, reason, reason_code, payload)
       VALUES ('outbound', $1, $2, $3, $4) RETURNING id`,
      [messageId, reason.slice(0, 1000), reasonCode.slice(0, 200), JSON.stringify(payload ?? {})],
    );
    return Number(rows[0]?.id ?? 0);
  }

  /** Update the open dead letter for a message (e.g. unknown -> failed via callback). */
  async updateOpenDeadLetter(messageId: number, reasonCode: string, reason: string): Promise<void> {
    await query(
      this.db,
      `UPDATE dead_letters SET reason = $3, reason_code = $2 WHERE kind = 'outbound' AND ref_id = $1 AND status = 'open'`,
      [messageId, reasonCode.slice(0, 200), reason.slice(0, 1000)],
    );
  }

  /** The open dead-letter row for a message, if any (carries the pending action). */
  async openDeadLetter(messageId: number): Promise<Record<string, unknown> | undefined> {
    const { rows } = await query<Record<string, unknown>>(
      this.db,
      `SELECT * FROM dead_letters WHERE kind = 'outbound' AND ref_id = $1 AND status = 'open' ORDER BY id LIMIT 1`,
      [messageId],
    );
    return rows[0];
  }

  private async noteDeadLetter(_messageId: number, _code: string, _note: string): Promise<void> {
    // Reconcile notes stay on the message row; the dead_letters table is for
    // terminal failures only. Kept as a no-op anchor for the audit trail.
  }

  private async nextAttemptNo(messageId: number): Promise<number> {
    const { rows } = await query<{ n: number }>(
      this.db,
      'SELECT COUNT(*) AS n FROM outbound_attempts WHERE message_id = $1',
      [messageId],
    );
    return Number(rows[0]?.n ?? 0) + 1;
  }
}

function mapRow(row: Record<string, unknown>): OutboundMessage {
  return {
    id: Number(row['id']),
    idempotencyKey: String(row['idempotency_key']),
    orgId: row['org_id'] == null ? null : Number(row['org_id']),
    userId: String(row['user_id']),
    enrollmentId: row['enrollment_id'] == null ? null : Number(row['enrollment_id']),
    courseId: row['course_id'] == null ? null : Number(row['course_id']),
    lessonPosition: row['lesson_position'] == null ? null : Number(row['lesson_position']),
    kind: (row['kind'] as OutboundKind) ?? 'reply',
    messages: Array.isArray(row['messages']) ? (row['messages'] as ReplyMessage[]) : [],
    status: row['status'] as OutboundStatus,
    twilioSid: (row['twilio_sid'] as string | null) ?? null,
    errorCode: (row['error_code'] as string | null) ?? null,
    errorMessage: (row['error_message'] as string | null) ?? null,
    attempts: Number(row['attempts'] ?? 0),
  };
}

export function normalizeTwilioStatus(status: string): OutboundStatus | undefined {
  switch (status.trim().toLowerCase()) {
    case 'queued':
    case 'accepted':
      return 'queued';
    case 'sending':
      return 'sending';
    case 'sent':
      return 'sent';
    case 'delivered':
      return 'delivered';
    case 'read':
      return 'read';
    case 'failed':
    case 'undelivered':
      return 'failed';
    default:
      return undefined;
  }
}

function describeError(err: unknown): { code: string | null; message: string } {
  // Walk to the root cause first: wrappers (TwilioSendError et al.) carry their
  // own generic code ('twilio_send_failed'), while the provider code
  // (21211, 63016, …) — the one that decides retry vs dead letter — lives on
  // the cause. Wrapper codes are never reported as the error code.
  const WRAPPER_CODES = new Set(['twilio_send_failed', 'chatbot_error', 'opted_out_suppressed']);
  const chain: Record<string, unknown>[] = [];
  let current: unknown = err;
  for (let i = 0; i < 4 && typeof current === 'object' && current !== null; i++) {
    chain.push(current as Record<string, unknown>);
    const next = (current as { cause?: unknown }).cause;
    if (next == null || typeof next !== 'object') break;
    current = next;
  }
  const pick = (v: unknown): string | null => {
    if (typeof v === 'string' && v && !WRAPPER_CODES.has(v)) return v;
    if (typeof v === 'number') return String(v);
    return null;
  };
  let code: string | null = null;
  for (let i = chain.length - 1; i >= 0; i--) {
    code = pick(chain[i]?.['code']) ?? code;
    if (code) break;
  }
  if (!code) code = pick((err as { code?: unknown } | null)?.code);
  // Opt-out suppression arrives as a bare AppError code: preserve it.
  if (!code && (err as { code?: unknown } | null)?.code === 'opted_out_suppressed') {
    code = 'opted_out_suppressed';
  }
  const deepest = chain[chain.length - 1] ?? {};
  const message =
    (typeof deepest['message'] === 'string' && deepest['message']) ||
    (typeof (err as { message?: unknown } | null)?.message === 'string'
      ? String((err as { message?: unknown }).message)
      : 'send failed');
  return { code, message: message.slice(0, 500) };
}
