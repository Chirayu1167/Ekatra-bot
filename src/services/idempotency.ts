/**
 * Idempotency seam.
 *
 * MessageSid will become the idempotency key in the persistent implementation.
 *
 * Twilio can deliver the same webhook more than once (retries, network
 * timeouts). A persistent implementation (e.g. a PostgreSQL unique constraint
 * or Redis SET NX) will let us skip work for a MessageSid we have already
 * claimed. This reduces duplicate processing; it does NOT make WhatsApp
 * delivery exactly-once — a crash between "claim" and "send" can still cause a
 * lost or repeated reply, and the persistent implementation must define how
 * that case is handled.
 */
export interface IdempotencyStore {
  /**
   * Try to claim `key` (the Twilio MessageSid).
   * Resolves `true` if this is the first time it was seen (caller should process),
   * `false` if it is a duplicate (caller should skip).
   */
  claim(key: string): Promise<boolean>;
}

/** MVP implementation: no persistence, every message is treated as new. */
export class NoopIdempotencyStore implements IdempotencyStore {
  async claim(_key: string): Promise<boolean> {
    return true;
  }
}
