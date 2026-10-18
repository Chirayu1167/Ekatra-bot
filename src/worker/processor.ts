import type { MessageHandler, DeliveryAction } from '../bot/chatbot';
import { certificateMessagesFor, type ButtonTemplates } from '../bot/courseBot';
import { renderLesson } from '../bot/lessonRenderer';
import type { Logger } from '../logger';
import { silentLogger } from '../logger';
import { ChatbotError } from '../errors';
import type { PgDb } from '../db/pg';
import { query } from '../db/pg';
import { Pool } from 'pg';
import { deliverMessages, type ReplyMessage } from '../services/delivery';
import type { CertificateService } from '../services/certificate.service';
import type { CourseService } from '../services/course.service';
import type { EnrollmentService } from '../services/enrollment.service';
import type { InboundEventService } from '../services/inboundEvents.service';
import type { Job, JobService } from '../services/jobs.service';
import type { OptOutService } from '../services/optout.service';
import { OptOutGuardSender } from '../services/optOutGuard';
import type { OutboundService } from '../services/outbound.service';
import type { WhatsAppSender } from '../services/whatsapp.service';
import { LOCK_CLASS } from '../services/lockNamespaces';
import { recordOutboundAttempt, recordOutboundMessage, recordDeadLetter } from '../services/metrics.service';

export interface ProcessorDeps {
  db: PgDb;
  chatbot: MessageHandler;
  /** Raw sender; wrapped with the opt-out guard here so no path bypasses it. */
  rawSender: WhatsAppSender;
  optOuts: OptOutService;
  enrollments: EnrollmentService;
  certificates?: CertificateService | undefined;
  /** Course content for rendering scheduled lessons at send time. */
  courses: CourseService;
  scheduleRender: {
    buttons: ButtonTemplates;
    certificates?: CertificateService | undefined;
    publicBaseUrl?: string | undefined;
    learnerName?: ((userId: string) => string | Promise<string>) | undefined;
    /** Approved quick-reply template sent when the 24-hour window is closed (A1). */
    templateSid?: string | undefined;
  };
  inbound: InboundEventService;
  jobs: JobService;
  outbound: OutboundService;
  logger?: Logger;
  workerId?: string;
  /** Crash-recovery horizon for stuck jobs/events. Default 300s. */
  visibilitySecs?: number;
}

export interface ProcessResult {
  jobId: number;
  kind: string;
  outcome: string;
}

const logOf = (deps: ProcessorDeps): Logger => deps.logger ?? silentLogger;
const workerOf = (deps: ProcessorDeps): string => deps.workerId ?? 'worker';
const visibilityOf = (deps: ProcessorDeps): number => deps.visibilitySecs ?? 300;

/**
 * Claim and process ONE due job (inbound first, then outbound). Returns null
 * when no job was due. Never throws: a poison job is failed (and dead-lettered)
 * rather than crashing the worker loop.
 *
 * Transaction/lock discipline: DB rows are locked only for claim/commit steps.
 * handleMessage (LLM) and sender (Twilio) calls always run OUTSIDE any
 * transaction or row lock.
 */
export async function processNextJob(deps: ProcessorDeps): Promise<ProcessResult | null> {
  const job = await deps.jobs.claimDue(['inbound_process', 'outbound_send'], visibilityOf(deps), workerOf(deps));
  if (!job) return null;
  // Per-learner ordering across worker processes: a session-level advisory lock
  // on the learner id serialises same-learner jobs. This is NOT a transaction
  // or row lock (it blocks no queries, only same-learner processing), so holding
  // it across the send/LLM calls is safe; it is always released in a finally.
  const lockKey = await learnerLockKey(deps, job);
  if (lockKey) {
    return withAdvisoryLock(deps, lockKey, () => runJob(deps, job));
  }
  return runJob(deps, job);
}

async function runJob(deps: ProcessorDeps, job: Job): Promise<ProcessResult> {
  try {
    if (job.kind === 'inbound_process') {
      const outcome = await handleInboundJob(deps, job);
      return { jobId: job.id, kind: job.kind, outcome };
    }
    const outcome = await handleOutboundJob(deps, job);
    return { jobId: job.id, kind: job.kind, outcome };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logOf(deps).error('worker.job.poison', { jobId: job.id, kind: job.kind, error: message });
    if (job.kind === 'outbound_send') {
      const payload = job.payload as Record<string, unknown>;
      const scheduled = payload['scheduledLesson'];
      const scheduledLesson =
        typeof scheduled === 'object' && scheduled !== null
          ? (scheduled as Record<string, unknown>)
          : undefined;
      const messageId = Number(payload['messageId'] ?? job.refId ?? NaN);
      const outbound =
        Number.isFinite(messageId)
          ? await deps.outbound.getById(messageId)
          : scheduledLesson
            ? await deps.outbound.getByKey(
                `sched:${String(scheduledLesson['enrollmentId'])}:${String(scheduledLesson['slotKey'])}:${String(scheduledLesson['position'])}`,
              )
            : undefined;
      if (
        outbound &&
        (outbound.status === 'sent' || outbound.status === 'delivered' || outbound.status === 'read')
      ) {
        const retry = await deps.jobs.retryOrFail(job.id, message, 'progress_action_failed');
        if (!retry) {
          const inboundMessageSid =
            typeof payload['inboundMessageSid'] === 'string'
              ? payload['inboundMessageSid']
              : undefined;
          await query(
            deps.db,
            `INSERT INTO dead_letters (kind, ref_id, reason, reason_code, payload)
             VALUES ('outbound', $1, $2, 'progress_action_failed', $3)`,
            [
              outbound.id,
              message.slice(0, 1000),
              JSON.stringify({
                action: payload['progressAction'] ?? asAction(undefined),
                ...(scheduledLesson && { scheduledLesson }),
                ...(inboundMessageSid && { inboundMessageSid }),
              }),
            ],
          );
          if (inboundMessageSid) {
            const event = await deps.inbound.getBySid(inboundMessageSid);
            if (event) await deps.inbound.markFailed(event.id, message);
          }
          return { jobId: job.id, kind: job.kind, outcome: 'progress_action_dead_lettered' };
        }
        return { jobId: job.id, kind: job.kind, outcome: 'progress_action_retry_scheduled' };
      }
    }
    if (job.kind === 'inbound_process') {
      const payload = job.payload as Record<string, unknown>;
      const messageSid = String(payload['messageSid'] ?? job.dedupeKey);
      const event = await deps.inbound.getBySid(messageSid);
      if (event) {
        await deps.inbound.markFailed(event.id, message);
        await query(
          deps.db,
          `INSERT INTO dead_letters (kind, ref_id, reason, reason_code, payload)
           VALUES ('inbound', $1, $2, 'poison', $3)`,
          [event.id, message.slice(0, 1000), JSON.stringify({ messageSid })],
        );
      }
    }
    await deps.jobs.failTerminal(job.id, message, 'poison');
    return { jobId: job.id, kind: job.kind, outcome: 'poison_failed' };
  }
}

/** Which learner serialises this job (null = no ordering needed). */
async function learnerLockKey(deps: ProcessorDeps, job: Job): Promise<string | null> {
  try {
    if (job.kind === 'inbound_process') {
      const sid = String((job.payload as Record<string, unknown>)['messageSid'] ?? job.dedupeKey);
      const event = await deps.inbound.getBySid(sid);
      return event ? `learner:${event.fromUser}` : null;
    }
    const payload = job.payload as Record<string, unknown>;
    const sched = payload['scheduledLesson'] as Record<string, unknown> | undefined;
    if (sched && typeof sched['userId'] === 'string') return `learner:${sched['userId']}`;
    const messageId = Number(payload['messageId'] ?? job.refId ?? NaN);
    if (!Number.isFinite(messageId)) return null;
    const message = await deps.outbound.getById(messageId);
    return message ? `learner:${message.userId}` : null;
  } catch {
    return null;
  }
}

async function withAdvisoryLock<T>(deps: ProcessorDeps, key: string, fn: () => Promise<T>): Promise<T> {
  if (!(deps.db instanceof Pool)) return fn();
  const client = await deps.db.connect();
  try {
    await client.query(`SELECT pg_advisory_lock($1, hashtext($2))`, [LOCK_CLASS.learner, key]);
    try {
      return await fn();
    } finally {
      try {
        await client.query(`SELECT pg_advisory_unlock($1, hashtext($2))`, [LOCK_CLASS.learner, key]);
      } catch {
        // Unlock is best-effort: session end releases the lock anyway.
      }
    }
  } finally {
    client.release();
  }
}

/** Drain all due jobs (used by the worker loop tick and by tests). Returns count. */
export async function drainJobs(deps: ProcessorDeps, maxJobs = 1000): Promise<number> {
  let done = 0;
  for (let i = 0; i < maxJobs; i++) {
    const result = await processNextJob(deps);
    if (!result) break;
    done++;
  }
  return done;
}

/** Reclaim crash-stuck work (jobs + events past their visibility timeout). */
export async function reclaimStuck(
  deps: ProcessorDeps,
): Promise<{ jobs: number; events: number; orphaned: number }> {
  const jobs = await deps.jobs.reclaimStuck();
  const events = await deps.inbound.reclaimStuck();
  const orphaned = await deps.inbound.requeueOrphanedReceived();
  if (jobs > 0 || events > 0 || orphaned > 0) {
    logOf(deps).warn('worker.reclaimed', { jobs, events, orphaned, worker: workerOf(deps) });
  }
  return { jobs, events, orphaned };
}

/** Backoff delay in seconds for a failed claim (mirrors retry.ts curve, no jitter needed here). */
function retryDelaySecs(failedAttempts: number): number {
  const secs = Math.max(1, Math.round((30_000 * 2 ** Math.max(0, failedAttempts - 1)) / 1000));
  return Math.min(secs, 3600);
}

function asAction(value: unknown): DeliveryAction {  if (typeof value !== 'object' || value === null) return { type: 'none' };
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

/**
 * Execute a delivery action idempotently: begin is INSERT .. ON CONFLICT DO
 * NOTHING, advance is compare-and-set (stale replays return false, harmlessly),
 * certificate issue is one-row-per-enrollment. Safe to run twice.
 */
export interface ActionDeps {
  enrollments: EnrollmentService;
  certificates?: CertificateService | undefined;
  logger?: Logger;
}

export async function executeAction(deps: ActionDeps, action: DeliveryAction): Promise<void> {
  const log = deps.logger ?? silentLogger;
  if (action.type === 'begin') {
    await deps.enrollments.begin(action.orgId, action.userId, action.courseId, action.position, action.isFinal);
    return;
  }
  if (action.type === 'advance') {
    if (action.to !== action.from + 1) {
      log.warn('worker.action.invalid', { action: action.type });
      return;
    }
    const advanced = await deps.enrollments.advance(action.orgId, action.enrollmentId, action.from, action.to, action.isFinal);
    if (advanced && action.isFinal && action.issueCertificate) {
      await deps.certificates?.issue(action.orgId, action.enrollmentId);
    }
    return;
  }
}

async function handleInboundJob(deps: ProcessorDeps, job: Job): Promise<string> {
  const log = logOf(deps);
  const messageSid = String((job.payload as Record<string, unknown>)['messageSid'] ?? job.dedupeKey);
  const event = await deps.inbound.getBySid(messageSid);
  if (!event) {
    await deps.jobs.complete(job.id); // event pruned/unknown: nothing to do
    return 'event_missing';
  }
  if (event.status === 'completed') {
    await deps.jobs.complete(job.id); // duplicate delivery of the same job
    return 'already_completed';
  }

  let reply;
  try {
    reply = await deps.chatbot.handleMessage({ userId: event.fromUser, text: event.body, messageId: messageSid });
  } catch (err) {
    // chatbot threw (a bug, or a downed LLM path): retry with backoff, then a
    // visible dead letter — never an infinite loop, never silent.
    const message = err instanceof Error ? err.message : String(err);
    const scheduled = await deps.jobs.retryOrFail(job.id, message, 'chatbot_error');
    if (!scheduled) {
      await deps.inbound.markFailed(event.id, message);
      await query(
        deps.db,
        `INSERT INTO dead_letters (kind, ref_id, reason, reason_code, payload)
         VALUES ('inbound', $1, $2, 'chatbot_error', $3)`,
        [event.id, message.slice(0, 1000), JSON.stringify({ messageSid, fromUser: event.fromUser })],
      );
      log.error('worker.inbound.dead', { messageSid, correlationId: event.correlationId });
      return 'dead_lettered';
    }
    return 'retry_scheduled';
  }

  // Silence for opted-out learners: acknowledge without sending or committing.
  if (reply.noSend) {
    await deps.inbound.markCompleted(event.id);
    await deps.jobs.complete(job.id);
    log.info('whatsapp.message.suppressed', { messageSid, correlationId: event.correlationId });
    return 'suppressed';
  }

  const messages: ReplyMessage[] = [
    {
      text: reply.text,
      ...(reply.mediaUrl && { mediaUrl: reply.mediaUrl }),
      ...(reply.contentSid && { contentSid: reply.contentSid }),
      ...(reply.fallbackText && { fallbackText: reply.fallbackText }),
      ...(reply.optOutConfirmation && { optOutConfirmation: true as const }),
    },
    ...(reply.followUps ?? []),
  ];
  const action = reply.deliveryAction ?? { type: 'none' as const };
  const idempotencyKey = `inbound:${messageSid}`;
  // Attribute the send to its org (for org-scoped failure listing): prefer the
  // action's org, else fall back to the learner's most recent enrollment org.
  let orgId: number | null = action.type === 'none' ? null : action.orgId;
  if (orgId === null) {
    const located = await deps.enrollments.locateUser(event.fromUser);
    orgId = located[0]?.orgId ?? null;
  }
  const { message } = await deps.outbound.create({
    idempotencyKey,
    userId: event.fromUser,
    ...(orgId !== null && { orgId }),
    ...(action.type === 'begin' && { courseId: action.courseId }),
    ...(action.type === 'advance' && { enrollmentId: action.enrollmentId }),
    kind: reply.optOutConfirmation ? 'system' : 'reply',
    messages,
  });
  // Idempotent enqueue: a reclaimed/replayed inbound job reuses the same
  // outbound row and job — never a second send. The row is the crash backstop;
  // the send below is attempted inline so that the read (handleMessage) and
  // the write (progress commit) stay under ONE learner-lock hold. A crash
  // before completion reclaims the job and a later claim finds 'sent' and
  // only finishes the idempotent action — exactly one logical update.
  await deps.jobs.enqueue({
    kind: 'outbound_send',
    dedupeKey: `outbound:${message.id}`,
    refType: 'outbound_messages',
    refId: message.id,
    payload: { messageId: message.id, progressAction: action, inboundMessageSid: messageSid },
  });
  try {
    await deliverOutbound(deps, message.id, action).then(async (outcome) => {
    if (outcome === 'retry_scheduled') {
      // The freshly enqueued outbound job would retry immediately: defer it
      // with backoff instead so transient failures are not hot-looped.
      const pending = await deps.jobs.findByDedupe('outbound_send', `outbound:${message.id}`);
      if (pending && pending.status === 'queued') {
        await deps.jobs.requeue(pending.id, new Date(Date.now() + retryDelaySecs(1) * 1000));
      }
    }
    });
  } catch (err) {
    const stored = await deps.outbound.getById(message.id);
    if (
      !stored ||
      (stored.status !== 'sent' && stored.status !== 'delivered' && stored.status !== 'read')
    ) {
      throw err;
    }
    const pending = await deps.jobs.findByDedupe('outbound_send', `outbound:${message.id}`);
    if (!pending || pending.status !== 'queued') throw err;
    await deps.jobs.requeue(
      pending.id,
      new Date(Date.now() + retryDelaySecs(Math.max(1, pending.attempts + 1)) * 1000),
    );
  }
  await deps.inbound.markCompleted(event.id);
  await deps.jobs.complete(job.id);
  log.info('worker.inbound.accepted', { messageSid, correlationId: event.correlationId, outboundId: message.id });
  return 'accepted';
}

async function handleOutboundJob(deps: ProcessorDeps, job: Job): Promise<string> {
  const payload = job.payload as Record<string, unknown>;
  if (payload['scheduledLesson'] && typeof payload['scheduledLesson'] === 'object') {
    return handleScheduledLesson(deps, job, payload['scheduledLesson'] as ScheduledLessonIntent);
  }
  const messageId = Number(payload['messageId'] ?? job.refId ?? NaN);
  if (!Number.isFinite(messageId)) {
    await deps.jobs.failTerminal(job.id, 'outbound job without messageId', 'bad_payload');
    return 'bad_payload';
  }
  const message = await deps.outbound.getById(messageId);
  if (!message) {
    await deps.jobs.complete(job.id);
    return 'message_missing';
  }
  const action = asAction(payload['progressAction']);

  // Already confirmed earlier (inline send during inbound handling, crash
  // between send and action, or duplicate delivery): never resend — just
  // finish the pending action idempotently.
  if (message.status === 'sent' || message.status === 'delivered' || message.status === 'read') {
    await executeAction(deps, action);
    await deps.jobs.complete(job.id);
    return 'already_sent_action_done';
  }
  if (message.status === 'dead_letter') {
    await deps.jobs.complete(job.id);
    return 'dead_lettered';
  }
  if (message.status === 'unknown') {
    // Uncertain outcome: parked for reconcile (callback / lookup / replay).
    // Resending blindly could double-deliver — a documented residual risk.
    await deps.jobs.complete(job.id);
    return 'parked_unknown';
  }
  if (message.status === 'failed' && message.attempts >= 6) {
    await deps.jobs.complete(job.id);
    return 'cap_reached';
  }
  // NOTE: a 'failed' message with attempts left is retried now: the job's
  // run_at (backoff) already gates when this claim happens.
  // Crash-during-send detection: a reclaimed job (attempts > 1) finding the
  // message still 'sending' means the previous worker died mid-send. The
  // outcome is uncertain: park as unknown, never resend blindly.
  if (message.status === 'sending' && job.attempts > 1) {
    const sched = (payload['scheduledLesson'] as Record<string, unknown> | undefined) ?? undefined;
    await parkUnknown(
      deps,
      messageId,
      action,
      'reclaimed while sending: previous worker died mid-send',
      sched ? { scheduledLesson: sched } : undefined,
    );
    await deps.jobs.complete(job.id);
    return 'parked_unknown';
  }

  const outcome = await deliverOutbound(deps, messageId, action);
  if (outcome === 'sent') {
    await deps.jobs.complete(job.id);
    return 'sent';
  }
  if (outcome === 'retry_scheduled') {
    await deps.jobs.requeue(job.id, new Date(Date.now() + retryDelaySecs(job.attempts) * 1000));
    return 'retry_scheduled';
  }
  await deps.jobs.complete(job.id);
  return outcome;
}

export interface ScheduledLessonIntent {
  enrollmentId: number;
  orgId: number;
  courseId: number;
  userId: string;
  position: number;
  isFinal: boolean;
  slotKey: string;
  timezone: string;
}

/**
 * Send a scheduled lesson. Every guard is re-checked at SEND time (not just at
 * tick time): a pause, opt-out, unpublish or completion between tick and send
 * suppresses the send. The slot was already claimed by the tick, so a
 * suppression simply consumes it. Rendering happens here so content edits land.
 */
async function handleScheduledLesson(
  deps: ProcessorDeps,
  job: Job,
  intent: ScheduledLessonIntent,
): Promise<string> {
  const log = logOf(deps);
  const { enrollmentId, orgId, courseId, userId, position, isFinal, slotKey } = intent;
  const enrollment = await deps.enrollments.find(orgId, userId, courseId);
  if (!enrollment || enrollment.id !== enrollmentId || enrollment.status !== 'active') {
    await deps.jobs.complete(job.id); // paused/completed/deleted since the tick: slot consumed
    return 'scheduled_stale';
  }
  if (enrollment.lastDeliveredPosition >= position) {
    await deps.jobs.complete(job.id); // learner moved on via NEXT: nothing to send
    return 'scheduled_ahead';
  }
  if (enrollment.lastDeliveredPosition !== position - 1) {
    await deps.jobs.complete(job.id); // unexpected gap: never skip; NEXT or the next tick covers it
    return 'scheduled_gap';
  }
  if (await deps.optOuts.isOptedOut(userId)) {
    await deps.jobs.complete(job.id);
    return 'scheduled_opted_out';
  }
  const course = await deps.courses.getCourse(orgId, courseId);
  if (!course || course.status !== 'published') {
    await deps.jobs.complete(job.id);
    return 'scheduled_unpublished';
  }
  // --- A1: 24-hour window -----------------------------------------------------------
  // The window is open when the learner has an inbound event within the last 24h.
  // No inbound ever => closed. Outside the window we only send an approved template
  // (or fail permanently when none is configured); the lesson is delivered when the
  // learner replies/taps NEXT.
  const lastSeen = await deps.inbound.lastSeenAt(userId);
  const windowOpen =
    lastSeen != null && Date.now() - new Date(lastSeen).getTime() <= 24 * 60 * 60 * 1000;
  const templateSid = deps.scheduleRender.templateSid;
  const idempotencyKey = `sched:${enrollmentId}:${slotKey}:${position}`;
  if (!windowOpen) {
    if (templateSid) {
      // Cap: at most one pending template per enrollment; wait for the learner to reply.
      const pending = await query(
        deps.db,
        `SELECT 1 AS one FROM outbound_messages
         WHERE enrollment_id = $1 AND kind = 'template'
           AND status IN ('queued','sending','sent','delivered','read')
         LIMIT 1`,
        [enrollmentId],
      );
      if (pending.rows.length > 0) {
        await deps.jobs.complete(job.id);
        return 'scheduled_template_pending';
      }
      const { message } = await deps.outbound.create({
        idempotencyKey,
        orgId,
        userId,
        enrollmentId,
        courseId,
        lessonPosition: position,
        kind: 'template',
        messages: [
          {
            text: 'Your lesson is ready — tap to start.',
            contentSid: templateSid,
            fallbackText: 'Your lesson is ready. Send NEXT to start the lesson.',
          },
        ],
      });
      // No progress action: the lesson is delivered on the learner's reply, not now.
      await deliverOutbound(deps, message.id, { type: 'none' as const }, { scheduledLesson: intent });
      await deps.jobs.complete(job.id);
      log.info('scheduler.lesson.template', { enrollmentId, position, slotKey });
      return 'scheduled_template_sent';
    }
    // No template configured: permanent, visible failure (never retried endlessly).
    const { message } = await deps.outbound.create({
      idempotencyKey,
      orgId,
      userId,
      enrollmentId,
      courseId,
      lessonPosition: position,
      kind: 'template',
      messages: [{ text: 'Your lesson is ready — tap to start.' }],
    });
    await deps.outbound.recordAttempt(message.id, {
      ok: false,
      error: Object.assign(new Error('24-hour window closed: no schedule template configured'), {
        code: 'template_required',
        status: 400,
      }),
    });
    await deps.jobs.complete(job.id);
    log.info('scheduler.lesson.template_required', { enrollmentId, position, slotKey });
    return 'scheduled_template_required';
  }
  // --- window open: normal lesson delivery ------------------------------------------
  const existing = await deps.outbound.getByKey(idempotencyKey);
  if (existing && (existing.status === 'sent' || existing.status === 'delivered' || existing.status === 'read')) {
    await deps.jobs.complete(job.id); // duplicate delivery of the same slot: already confirmed
    return 'scheduled_duplicate';
  }
  const lesson = await deps.courses.getLessonAt(orgId, courseId, position);
  if (!lesson) {
    log.error('course.lesson.missing', { courseId, position });
    await deps.jobs.complete(job.id);
    return 'scheduled_lesson_missing';
  }
  const messages = renderLesson(
    {
      courseTitle: course.title,
      lessonNumber: position,
      lessonCount: course.lessonCount,
      lessonTitle: lesson.title,
    },
    lesson.items,
    deps.scheduleRender.buttons,
  );
  let issueCertificate = false;
  if (isFinal && deps.scheduleRender.certificates) {
    messages.push(
      ...(await certificateMessagesFor(
        {
          certificates: deps.scheduleRender.certificates,
          publicBaseUrl: deps.scheduleRender.publicBaseUrl,
          learnerName: deps.scheduleRender.learnerName ?? (async () => ''),
        },
        enrollment,
      )),
    );
    issueCertificate = true;
  }
  const { message } = await deps.outbound.create({
    idempotencyKey,
    orgId,
    userId,
    enrollmentId,
    courseId,
    lessonPosition: position,
    kind: 'scheduled_lesson',
    messages,
  });
  const action: DeliveryAction = {
    type: 'advance',
    orgId,
    enrollmentId,
    from: position - 1,
    to: position,
    isFinal,
    issueCertificate,
  };
  const outcome = await deliverOutbound(deps, message.id, action, { scheduledLesson: intent });
  if (outcome === 'sent') {    await deps.jobs.complete(job.id);
    log.info('scheduler.lesson.sent', { enrollmentId, position, slotKey });
    return 'scheduled_sent';
  }
  if (outcome === 'retry_scheduled') {
    await deps.jobs.requeue(job.id, new Date(Date.now() + retryDelaySecs(job.attempts) * 1000));
    return 'scheduled_retry';
  }
  await deps.jobs.complete(job.id);
  return `scheduled_${outcome}`;
}

/**
 * Send one outbound message and settle it: confirmed send (record attempt,
 * then commit the progress action — the ONLY place progress advances),
 * transient retry, permanent dead letter, or uncertain park. Idempotent:
 * a message already 'sent' is never resent.
 */
async function deliverOutbound(
  deps: ProcessorDeps,
  messageId: number,
  action: DeliveryAction,
  extra?: Record<string, unknown>,
): Promise<'sent' | 'retry_scheduled' | 'dead_lettered' | 'parked_unknown'> {
  const log = logOf(deps);
  const current = await deps.outbound.getById(messageId);
  if (!current) return 'dead_lettered';
  const kind = current.kind;
  if (current.status === 'sent' || current.status === 'delivered' || current.status === 'read') {
    await executeAction(deps, action);
    recordOutboundMessage(kind, 'sent');
    return 'sent';
  }
  const sender = new OptOutGuardSender(deps.rawSender, deps.optOuts, log);
  // Per-item idempotency (A4): skip items already sent on a previous attempt so a retry
  // continues from the first unsent item. Template messages carry a single synthetic item
  // and are unaffected.
  const sentPositions = await deps.outbound.listSentItemPositions(messageId);
  const unsentIndexes = current.messages
    .map((_m, i) => i)
    .filter((i) => !sentPositions.has(i));
  if (unsentIndexes.length === 0) {
    // All items already sent (e.g. replay after partial delivery): advance exactly once.
    await deps.outbound.setStatus(messageId, 'sent');
    await deps.outbound.recordAttempt(messageId, { ok: true, sid: current.twilioSid ?? 'unknown' });
    await executeAction(deps, action);
    recordOutboundMessage(kind, 'sent');
    return 'sent';
  }
  try {
    let lastSid: string | null = null;
    for (const i of unsentIndexes) {
      const item = current.messages[i];
      if (!item) continue;
      const sids = await deliverMessages(sender, current.userId, [item], log);
      await deps.outbound.markItemSent(messageId, i, sids[0] ?? null);
      lastSid = sids[0] ?? null;
    }
    const allSent = await deps.outbound.allItemsSent(messageId, current.messages.length);
    if (!allSent) {
      // A send failed partway: markers exist for items sent so far; retry the rest.
      await deps.outbound.recordPartialSend(messageId, lastSid ?? 'unknown');
      recordOutboundAttempt('transient');
      recordOutboundMessage(kind, 'retry');
      return 'retry_scheduled';
    }
    await deps.outbound.recordAttempt(messageId, { ok: true, sid: lastSid ?? 'unknown' });
  } catch (err) {
    // Items before the failing one already have markers; they will not be re-sent.
    const outcome = await deps.outbound.recordAttempt(messageId, { ok: false, error: err });
    if (outcome === 'unknown') {
      await parkUnknown(deps, messageId, action, err instanceof Error ? err.message : String(err), extra);
      recordOutboundAttempt('unknown');
      recordOutboundMessage(kind, 'unknown');
      return 'parked_unknown';
    }
    if (outcome === 'dead_letter') {
      await attachActionToDeadLetter(deps, messageId, action, extra);
      recordOutboundAttempt('permanent');
      recordOutboundMessage(kind, 'dead_letter');
      recordDeadLetter(kind, 'permanent');
      return 'dead_lettered';
    }
    return 'retry_scheduled';
  }

  // Confirmed send: only NOW commit progress (compare-and-set, idempotent).
  try {
    await executeAction(deps, action);
  } catch (err) {
    throw new ChatbotError(err);
  }
  recordOutboundAttempt('sent');
  recordOutboundMessage(kind, 'sent');
  log.info('whatsapp.message.replied', { outboundId: messageId, to: '[masked]' });
  return 'sent';
}

async function parkUnknown(
  deps: ProcessorDeps,
  messageId: number,
  action: DeliveryAction,
  note: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  await query(
    deps.db,
    `UPDATE outbound_messages SET status = 'unknown', next_retry_at = NULL, updated_at = now() WHERE id = $1`,
    [messageId],
  );
  const existing = await query<{ n: number }>(
    deps.db,
    `SELECT COUNT(*) AS n FROM dead_letters WHERE kind = 'outbound' AND ref_id = $1 AND status = 'open'`,
    [messageId],
  );
  if (Number(existing.rows[0]?.n ?? 0) === 0) {
    await query(
      deps.db,
      `INSERT INTO dead_letters (kind, ref_id, reason, reason_code, payload)
       VALUES ('outbound', $1, $2, 'unknown_outcome', $3)`,
      [
        messageId,
        `Uncertain send outcome (never auto-resent). ${note}`.slice(0, 1000),
        JSON.stringify({ action, ...(extra ?? {}) }),
      ],
    );
  }
}

async function attachActionToDeadLetter(
  deps: ProcessorDeps,
  messageId: number,
  action: DeliveryAction,
  extra?: Record<string, unknown>,
): Promise<void> {
  const open = await deps.outbound.openDeadLetter(messageId);
  if (!open) return;
  const payload = (open['payload'] as Record<string, unknown>) ?? {};
  if (payload['action'] == null) {
    await query(deps.db, 'UPDATE dead_letters SET payload = $2 WHERE id = $1', [
      open['id'],
      JSON.stringify({ ...payload, action, ...(extra ?? {}) }),
    ]);
  }
}

export interface ReconcileDeps extends ActionDeps {
  db: PgDb;
  outbound: OutboundService;
}

/**
 * Reconcile a message from a Twilio status callback (or a Twilio lookup).
 * Callbacks are deduped by state: re-applying the same status is a no-op and
 * status never regresses. If an 'unknown' (uncertain) message is now proven
 * delivered, its pending progress action runs exactly once (idempotent) and
 * the dead letter resolves as auto-reconciled. If proven failed, the open
 * dead letter's reason is updated — still no blind resend.
 */
export async function reconcileFromCallback(
  deps: ReconcileDeps,
  twilioSid: string,
  twilioStatus: string,
): Promise<string> {
  const log = deps.logger ?? silentLogger;
  const message = await deps.outbound.getByTwilioSid(twilioSid);
  if (!message) {
    log.warn('worker.callback.unknown_sid', {});
    return 'unknown_sid';
  }
  const wasUnknown = message.status === 'unknown';
  const updated = await deps.outbound.applyStatusCallback(twilioSid, twilioStatus);
  if (!updated) return 'ignored_status';
  if (!wasUnknown) return `updated:${updated.status}`;
  const open = await deps.outbound.openDeadLetter(message.id);
  const action = asAction((open?.['payload'] as Record<string, unknown> | undefined)?.['action']);
  if (updated.status === 'delivered' || updated.status === 'read') {
    await executeAction(deps, action);
    await query(
      deps.db,
      `UPDATE dead_letters SET status = 'replayed', resolved_at = now(),
         resolution_note = 'auto-reconciled: status callback proved delivery; pending action applied once'
       WHERE kind = 'outbound' AND ref_id = $1 AND status = 'open'`,
      [message.id],
    );
    log.info('worker.reconciled', { outcome: 'delivered' });
    return 'reconciled_delivered';
  }
  if (updated.status === 'dead_letter' || updated.status === 'failed') {
    await deps.outbound.updateOpenDeadLetter(
      message.id,
      'callback_failed',
      `Twilio reported ${twilioStatus} after an uncertain outcome; no blind resend`,
    );
    return 'reconciled_failed';
  }
  return `updated:${updated.status}`;
}
