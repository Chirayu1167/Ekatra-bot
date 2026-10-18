import { maskPhone, type Logger } from '../logger';
import type { WhatsAppSender } from './whatsapp.service';

/** One WhatsApp message. WhatsApp allows a single media object per message. */
export interface ReplyMessage {
  text: string;
  mediaUrl?: string;
  /**
   * Send `text` with tap-buttons from this Twilio Content Template (quick-reply). The text is
   * the template's variable {{1}}. If the template send fails, `fallbackText` (default: `text`)
   * goes out as a plain message so the learner can still use typed commands.
   */
  contentSid?: string;
  fallbackText?: string;
  /**
   * STOP-confirmation marker, threaded through to the sender so the central opt-out guard
   * can let this one message through while blocking everything else to opted-out numbers.
   */
  optOutConfirmation?: boolean;
}

/** Template variables must be single-line, so flatten line breaks. */
const oneLine = (text: string) => text.replace(/\s*\n+\s*/g, ' ').trim();

/** Log-safe description of a media URL: media URLs can carry signed tokens in the query. */
function describeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return 'invalid-url';
  }
}

/**
 * Send messages strictly in order. If a media message is rejected by Twilio, send a text
 * fallback with the link and carry on, so one bad attachment never blocks the lesson. The same
 * goes for a button message, which falls back to plain text.
 * Anything else (including a failing fallback) throws, and the caller must NOT record progress.
 *
 * Limit: Twilio can also fail media *asynchronously* (e.g. it cannot download the file after
 * accepting the request). That surfaces only in status callbacks, which are not handled yet.
 */
export async function deliverMessages(
  sender: WhatsAppSender,
  to: string,
  messages: ReplyMessage[],
  logger: Logger,
): Promise<string[]> {
  const sids: string[] = [];
  // The STOP-confirmation marker threads through verbatim so the opt-out guard can honour it.
  const flagOf = (message: ReplyMessage) =>
    message.optOutConfirmation ? { optOutConfirmation: true as const } : {};
  for (const message of messages) {
    const flag = flagOf(message);
    try {
      const sent = await sender.sendWhatsAppMessage(
        message.contentSid
          ? {
              to,
              body: '',
              contentSid: message.contentSid,
              contentVariables: { '1': oneLine(message.text) },
              ...flag,
            }
          : {
              to,
              body: message.text,
              ...(message.mediaUrl && { mediaUrl: message.mediaUrl }),
              ...flag,
            },
      );
      sids.push(sent.sid);
    } catch (err) {
      if (message.contentSid) {
        // Buttons are a nicety: fall back to plain text with the typed command.
        logger.warn('whatsapp.buttons.fallback', { to: maskPhone(to) });
        const sent = await sender.sendWhatsAppMessage({
          to,
          body: message.fallbackText ?? message.text,
          ...flag,
        });
        sids.push(sent.sid);
        continue;
      }
      if (!message.mediaUrl) throw err;
      logger.warn('whatsapp.media.fallback', {
        to: maskPhone(to),
        media: describeUrl(message.mediaUrl),
      });
      const note = `📎 I couldn't send this attachment. You can try opening it here:\n${message.mediaUrl}`;
      const sent = await sender.sendWhatsAppMessage({
        to,
        body: message.text ? `${message.text}\n\n${note}` : note,
        ...flag,
      });
      sids.push(sent.sid);
    }
  }
  return sids;
}
