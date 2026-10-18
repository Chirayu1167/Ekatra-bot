import { describe, expect, it } from 'vitest';
import {
  RETRY_BASE_MS,
  RETRY_CAP_MS,
  backoffMs,
  classifySendError,
  statusRegresses,
} from '../src/services/retry';
import { OptedOutError } from '../src/services/optOutGuard';
import { TwilioSendError } from '../src/errors';

const coded = (code: string | number, message = 'provider error') =>
  new TwilioSendError(Object.assign(new Error(message), { code }));

describe('retry policy', () => {
  it('backoff doubles from the 30s base and caps at 1h (deterministic random)', () => {
    const fixed = () => 0.5; // jitter 1.0
    expect(backoffMs(1, fixed)).toBe(RETRY_BASE_MS);
    expect(backoffMs(2, fixed)).toBe(RETRY_BASE_MS * 2);
    expect(backoffMs(3, fixed)).toBe(RETRY_BASE_MS * 4);
    expect(backoffMs(10, fixed)).toBe(RETRY_CAP_MS);
  });

  it('jitter stays within ±20%', () => {
    for (let i = 0; i < 50; i++) {
      const d = backoffMs(2, Math.random);
      expect(d).toBeGreaterThanOrEqual(Math.round(RETRY_BASE_MS * 2 * 0.8));
      expect(d).toBeLessThanOrEqual(Math.round(RETRY_BASE_MS * 2 * 1.2));
    }
  });

  it('permanent errors are never retried', () => {
    expect(classifySendError(coded(21211, 'invalid to'))).toBe('permanent');
    expect(classifySendError(coded('21610', 'unsubscribed'))).toBe('permanent');
    expect(classifySendError(coded('63016', 'template required outside the 24-hour window'))).toBe(
      'permanent',
    );
    expect(classifySendError(coded('63015', 'channel sender required'))).toBe('permanent');
    expect(classifySendError(new OptedOutError())).toBe('permanent');
    expect(classifySendError(new TwilioSendError(new Error('user is blocked')))).toBe('permanent');
  });

  it('timeouts are uncertain (reconcile first), everything else transient', () => {
    expect(classifySendError(new TwilioSendError(new Error('request timed out')))).toBe('unknown');
    expect(classifySendError(new TwilioSendError(new Error('socket hang up')))).toBe('transient');
    expect(classifySendError(coded(429, 'too many requests'))).toBe('transient');
    expect(classifySendError(coded(500, 'server error'))).toBe('transient');
    expect(classifySendError(new Error('boom'))).toBe('transient');
  });

  it('delivery status never regresses', () => {
    expect(statusRegresses('delivered', 'sent')).toBe(true);
    expect(statusRegresses('read', 'sent')).toBe(true);
    expect(statusRegresses('read', 'delivered')).toBe(true); // stale reorder after read is ignored
    expect(statusRegresses('sent', 'delivered')).toBe(false);
    expect(statusRegresses('sent', 'sent')).toBe(false);
    expect(statusRegresses('unknown', 'delivered')).toBe(false);
    expect(statusRegresses('failed', 'delivered')).toBe(true);
  });
});
