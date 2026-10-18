import twilio from 'twilio';
import { TwilioSendError } from '../errors';
import { maskPhone, type Logger } from '../logger';
import type { OutgoingWhatsAppMessage, SendResult } from '../types/whatsapp';

/** What the rest of the app depends on. Swap this for a queue-backed sender later. */
export interface WhatsAppSender {
  sendWhatsAppMessage(message: OutgoingWhatsAppMessage): Promise<SendResult>;
}

/** The slice of the Twilio SDK client we use — keeps tests free of real Twilio calls. */
export interface TwilioMessagesClient {
  messages: {
    create(params: {
      from: string;
      to: string;
      body?: string;
      mediaUrl?: string[];
      contentSid?: string;
      contentVariables?: string;
    }): Promise<{ sid: string }>;
  };
}

/** Hard request timeout for Twilio calls (ms). */
export interface TwilioRequestTimeout {
  timeoutMs: number;
}

export function createTwilioClient(
  accountSid: string,
  authToken: string,
  opts?: { timeout?: number },
): TwilioMessagesClient {
  const client = twilio(accountSid, authToken, { timeout: opts?.timeout });
  return client as unknown as TwilioMessagesClient;
}

export class TwilioWhatsAppService implements WhatsAppSender {
  constructor(
    private readonly client: TwilioMessagesClient,
    private readonly from: string,
    private readonly logger: Logger,
    private readonly timeoutMs: number = 10000,
    private readonly statusCallbackUrl?: string,
  ) {}

  async sendWhatsAppMessage({
    to,
    body,
    mediaUrl,
    contentSid,
    contentVariables,
  }: OutgoingWhatsAppMessage): Promise<SendResult> {
    const call = this.client.messages.create({
      from: this.from,
      to,
      ...(this.statusCallbackUrl ? { statusCallback: this.statusCallbackUrl } : {}),
      ...(contentSid
        ? { contentSid, contentVariables: JSON.stringify(contentVariables ?? {}) }
        : {
            ...(body || !mediaUrl ? { body } : {}),
            ...(mediaUrl ? { mediaUrl: [mediaUrl] } : {}),
          }),
    });
    // Hard backstop so a hung Twilio request never parks a connection forever.
    let timer: NodeJS.Timeout | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`twilio request timed out after ${this.timeoutMs}ms`)),
        this.timeoutMs,
      );
    });
    try {
      const result = await Promise.race([call, timeout]);
      if (timer) clearTimeout(timer);
      return { sid: result.sid };
    } catch (err) {
      if (timer) clearTimeout(timer);
      const e = err as { code?: unknown; status?: unknown; message?: unknown };
      // Log only non-sensitive diagnostics from the Twilio error.
      this.logger.error('twilio.send.failed', {
        to: maskPhone(to),
        twilioCode: e.code,
        twilioStatus: e.status,
        reason: typeof e.message === 'string' ? e.message : 'unknown',
      });
      throw new TwilioSendError(err);
    }
  }
}
