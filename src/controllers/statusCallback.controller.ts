import type { RequestHandler } from 'express';
import { BadRequestError } from '../errors';
import type { Logger } from '../logger';
import { reconcileFromCallback, type ReconcileDeps } from '../worker/processor';

export interface StatusCallbackControllerDeps {
  reconcile: ReconcileDeps;
  logger: Logger;
}

const KNOWN_STATUSES = new Set([
  'queued',
  'accepted',
  'sending',
  'sent',
  'delivered',
  'read',
  'failed',
  'undelivered',
]);

/**
 * Twilio delivery-status callbacks (queued/sent/delivered/read/failed/undelivered).
 * Signed like the inbound webhook; deduped by state (re-applying a status is a
 * no-op) and monotonic (delivered never regresses to sent). Unknown MessageSids
 * and unknown statuses are acknowledged without effect so Twilio stops retrying.
 * An 'unknown' (uncertain) message proven delivered reconciles its pending
 * progress action exactly once — see reconcileFromCallback.
 */
export function createStatusCallbackController(deps: StatusCallbackControllerDeps): RequestHandler {
  const { reconcile, logger } = deps;
  return async (req, res) => {
    const sid = req.body?.['MessageSid'];
    const status = req.body?.['MessageStatus'];
    if (typeof sid !== 'string' || sid.length === 0 || typeof status !== 'string' || status.length === 0) {
      throw new BadRequestError('Invalid status callback payload: MessageSid, MessageStatus');
    }
    if (!KNOWN_STATUSES.has(status.trim().toLowerCase())) {
      logger.warn('twilio.callback.unknown_status', {});
      res.status(200).json({ received: true, outcome: 'ignored_status' });
      return;
    }
    const outcome = await reconcileFromCallback(reconcile, sid, status);
    logger.info('twilio.callback.received', { outcome });
    res.status(200).json({ received: true, outcome });
  };
}
