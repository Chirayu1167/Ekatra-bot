import type { RequestHandler, Response } from 'express';
import { BadRequestError } from '../errors';
import { maskPhone, type Logger } from '../logger';
import { recordWebhookReceived } from '../services/metrics.service';
import type { InboundEventService } from '../services/inboundEvents.service';
import type { JobService } from '../services/jobs.service';
import { incomingWebhookSchema, type IncomingWhatsAppMessage } from '../types/whatsapp';

export interface DurableWhatsAppControllerDeps {
  inbound: InboundEventService;
  jobs: JobService;
  logger: Logger;
}

export function parseIncomingMessage(payload: unknown): IncomingWhatsAppMessage {
  const result = incomingWebhookSchema.safeParse(payload ?? {});
  if (!result.success) {
    const fields = result.error.issues.map((i) => i.path.join('.') || 'body').join(', ');
    throw new BadRequestError(`Invalid webhook payload: ${fields}`);
  }
  const { MessageSid, From, To, Body, ButtonPayload } = result.data;
  // A tapped button sends its `id` (e.g. "NEXT") as ButtonPayload, which we treat as the command.
  const tapped = ButtonPayload?.trim();
  return { messageSid: MessageSid, from: From, to: To, body: tapped || Body };
}

/**
 * Twilio expects TwiML (or an empty 200) from the webhook. We deliver the reply via the
 * REST API from the worker instead, so we acknowledge with an empty <Response/>.
 */
function acknowledge(res: Response): void {
  res.status(200).type('text/xml').send('<Response></Response>');
}

/**
 * Durable inbound (Phase 3): verify signature -> validate -> INSERT the raw event
 * (idempotent on MessageSid) -> enqueue a job -> return 200. The reply is built
 * and sent by the worker; the webhook NEVER processes, sends, or holds locks.
 * Acknowledge only after the event is durably stored. At-least-once: Twilio
 * retries a non-200; duplicates are stored once and processed once.
 */
export function createWhatsAppController(deps: DurableWhatsAppControllerDeps): RequestHandler {
  const { inbound, jobs, logger } = deps;

  // Express 5 forwards rejected promises from async handlers to the error handler.
  return async (req, res) => {
    const message = parseIncomingMessage(req.body);

    // Privacy: never log message bodies; phone numbers are masked (last 4 digits kept).
    logger.info('whatsapp.message.received', {
      messageSid: message.messageSid,
      from: maskPhone(message.from),
      to: maskPhone(message.to),
      bodyLength: message.body.length,
    });
    recordWebhookReceived();

    const { isNew, correlationId } = await inbound.transaction(async (tx) => {
      const accepted = await inbound.accept({
        messageSid: message.messageSid,
        fromUser: message.from,
        toUser: message.to,
        body: message.body,
        raw: (req.body ?? {}) as Record<string, unknown>,
      }, tx);
      await jobs.enqueue({
        kind: 'inbound_process',
        dedupeKey: message.messageSid,
        refType: 'inbound_events',
        payload: { messageSid: message.messageSid },
      }, tx);
      return accepted;
    });
    if (!isNew) {
      logger.info('whatsapp.message.duplicate', {
        messageSid: message.messageSid,
        correlationId,
      });
      acknowledge(res);
      return;
    }
    logger.info('whatsapp.message.accepted', {
      messageSid: message.messageSid,
      correlationId,
    });
    acknowledge(res);
  };
}
