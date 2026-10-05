import twilio from 'twilio';
import { TwilioSendError } from '../errors';
import type { Logger } from '../logger';
import type { OutgoingWhatsAppMessage, SendResult } from '../types/whatsapp';

/** What the rest of the app depends on. Swap this for a queue-backed sender later. */
export interface WhatsAppSender {
  sendWhatsAppMessage(message: OutgoingWhatsAppMessage): Promise<SendResult>;
}

/** The slice of the Twilio SDK client we use — keeps tests free of real Twilio calls. */
export interface TwilioMessagesClient {
  messages: {
    create(params: { from: string; to: string; body: string }): Promise<{ sid: string }>;
  };
}

export function createTwilioClient(accountSid: string, authToken: string): TwilioMessagesClient {
  return twilio(accountSid, authToken);
}

export class TwilioWhatsAppService implements WhatsAppSender {
  constructor(
    private readonly client: TwilioMessagesClient,
    private readonly from: string,
    private readonly logger: Logger,
  ) {}

  async sendWhatsAppMessage({ to, body }: OutgoingWhatsAppMessage): Promise<SendResult> {
    try {
      const result = await this.client.messages.create({ from: this.from, to, body });
      return { sid: result.sid };
    } catch (err) {
      const e = err as { code?: unknown; status?: unknown; message?: unknown };
      // Log only non-sensitive diagnostics from the Twilio error.
      this.logger.error('twilio.send.failed', {
        to,
        twilioCode: e.code,
        twilioStatus: e.status,
        reason: typeof e.message === 'string' ? e.message : 'unknown',
      });
      throw new TwilioSendError(err);
    }
  }
}
