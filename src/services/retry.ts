/**
 * Retry policy for durable delivery (pure functions — no SQL here).
 *
 * Backoff: base 30s, doubling, capped at 1h, with ±20% jitter so a fleet of
 * workers does not retry in lockstep. maxAttempts = 6 (7 timestamps total
 * including the first immediate try): ~30s, ~1m, ~2m, ~4m, ~8m, ~16m.
 *
 * Error classification decides retry vs dead letter:
 * - permanent: the request will never succeed (invalid number, unsubscribed,
 *   template/24h-window required, blocked, opted-out). Never retried.
 * - transient: it might (network/timeout, 429, 5xx, unknown Twilio errors).
 * - unknown: the outcome itself is uncertain (timeout AFTER the request left,
 *   crash after send). Never blindly resent: reconcile first (status callback
 *   or Twilio lookup) — see docs/delivery-architecture.md for the residual
 *   duplicate risk.
 */
export const RETRY_BASE_MS = 30_000;
export const RETRY_CAP_MS = 3_600_000;
export const RETRY_MAX_ATTEMPTS = 6;

export type SendOutcome = 'transient' | 'permanent' | 'unknown';

/** Twilio error codes that are permanent (also matched case-insensitively by message). */
const PERMANENT_CODES = new Set([
  '21211', // invalid "To" number
  '21610', // unsubscribed / not opted in
  '21614', // not a valid WhatsApp number / not opted in
  '63007', // blocked by user / carrier
  '63015', // channel sender required / template needed
  '63016', // template required (outside 24h window)
  '63018', // template / policy rejection
]);

const PERMANENT_HINTS = [
  'opted_out_suppressed',
  'opted out',
  'unsubscribed',
  'not opted',
  'invalid',
  'template',
  'outside the 24',
  '24-hour',
  '24 hour',
  'blocked',
];

export function classifySendError(err: unknown): SendOutcome {
  const e = err as {
    code?: unknown;
    status?: unknown;
    message?: unknown;
    cause?: unknown;
  } | null;
  const parts: string[] = [];
  const collect = (v: unknown, depth: number): void => {
    if (v == null || depth > 2) return;
    if (typeof v === 'string' || typeof v === 'number') {
      parts.push(String(v));
      return;
    }
    if (typeof v === 'object') {
      const o = v as Record<string, unknown>;
      collect(o['code'], depth + 1);
      collect(o['status'], depth + 1);
      collect(o['message'], depth + 1);
      collect(o['cause'], depth + 1);
    }
  };
  collect(e, 0);
  const text = parts.join(' ').toLowerCase();
  for (const code of PERMANENT_CODES) {
    if (parts.some((p) => p.trim() === code)) return 'permanent';
  }
  if (PERMANENT_HINTS.some((h) => text.includes(h))) return 'permanent';
  if (/timeout|timed out|etimedout|abort/i.test(text)) return 'unknown';
  return 'transient';
}

/** Delay before attempt number `attempt` (1-based, i.e. the retry that just failed). */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const exp = RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(exp, RETRY_CAP_MS);
  const jitter = 0.8 + random() * 0.4; // ±20%
  return Math.round(capped * jitter);
}

/** Delivery-status rank: callbacks must never regress (delivered cannot go back). */
const STATUS_RANK: Record<string, number> = {
  queued: 0,
  sending: 1,
  sent: 2,
  delivered: 3,
  read: 4,
  failed: 5,
  unknown: 1,
  dead_letter: 6,
};

export function statusRegresses(from: string, to: string): boolean {
  const a = STATUS_RANK[from] ?? 0;
  const b = STATUS_RANK[to] ?? 0;
  // failed/dead_letter are terminal reports, not ranks: any move away from a
  // delivered/read state towards sent/queued is a regression.
  if ((from === 'delivered' || from === 'read') && (to === 'sent' || to === 'queued' || to === 'sending')) {
    return true;
  }
  return b < a;
}
