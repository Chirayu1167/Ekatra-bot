import { z } from 'zod';

/** Twilio WhatsApp addresses look like "whatsapp:+14155238886". */
const whatsappAddress = z
  .string({ error: 'must be a string' })
  .regex(/^whatsapp:\+\d{7,15}$/, 'must look like "whatsapp:+<E.164 number>"');

/** The subset of Twilio's incoming-message webhook fields we use. */
export const incomingWebhookSchema = z.object({
  MessageSid: z.string({ error: 'is required' }).min(1, 'is required'),
  From: whatsappAddress,
  To: whatsappAddress,
  // Media-only messages arrive with an empty Body.
  Body: z.string().default(''),
});

/** Transport-neutral shape used inside the app. */
export interface IncomingWhatsAppMessage {
  messageSid: string;
  from: string;
  to: string;
  body: string;
}

export interface OutgoingWhatsAppMessage {
  to: string;
  body: string;
}

export interface SendResult {
  sid: string;
}
