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
  // Set by Twilio when the user taps a quick-reply button: the `id` of the tapped button.
  ButtonPayload: z.string().optional(),
  // Number of media attachments (0 for text, >=1 for media/voice).
  NumMedia: z.coerce.number().min(0).default(0),
  // URL of the first media attachment (Twilio-provided, requires auth to download).
  MediaUrl0: z.string().url().optional(),
  // MIME type of the first media attachment (e.g. 'audio/ogg' for WhatsApp voice notes).
  MediaContentType0: z.string().optional(),
});

/** Transport-neutral shape used inside the app. */
export interface IncomingWhatsAppMessage {
  messageSid: string;
  from: string;
  to: string;
  body: string;
  /** Number of media attachments on this message. */
  numMedia: number;
  /** URL of the first media attachment (voice note audio, etc.). Requires Twilio auth to download. */
  mediaUrl?: string;
  /** MIME type of the media attachment (e.g. 'audio/ogg'). */
  mediaContentType?: string;
}

export interface OutgoingWhatsAppMessage {
  to: string;
  body: string;
  /** Public https URL of ONE media file (WhatsApp allows a single media object per message). */
  mediaUrl?: string;
  /** A Twilio Content Template (e.g. quick-reply buttons). When set, `body` is not sent. */
  contentSid?: string;
  /** Template variables, e.g. { '1': 'Ready for lesson 2?' }. */
  contentVariables?: Record<string, string>;
  /**
   * Internal bypass for the central opt-out guard: set ONLY on the STOP-confirmation reply.
   * Never sent to Twilio; the guard reads it before delegating.
   */
  optOutConfirmation?: boolean;
}

export interface SendResult {
  sid: string;
}

/** A voice note received from a learner: the raw media URL and its MIME type. */
export interface VoiceNote {
  /** Twilio media URL (protected; download with Account SID / Auth Token basic auth). */
  mediaUrl: string;
  /** MIME type, e.g. 'audio/ogg', 'audio/mp3'. */
  contentType: string;
}

/** Whether the incoming message is a voice note. Returns the message with a `voiceNote` property when true. */
export function isVoiceNote(msg: IncomingWhatsAppMessage): msg is IncomingWhatsAppMessage & { voiceNote: VoiceNote } {
  if (msg.numMedia > 0 && msg.mediaUrl && msg.mediaContentType?.startsWith('audio/')) {
    return true;
  }
  return false;
}
