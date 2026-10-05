import type { RequestHandler, Response } from 'express';
import type { MessageHandler } from '../bot/chatbot';
import { BadRequestError, ChatbotError } from '../errors';
import type { Logger } from '../logger';
import type { IdempotencyStore } from '../services/idempotency';
import type { WhatsAppSender } from '../services/whatsapp.service';
import { incomingWebhookSchema, type IncomingWhatsAppMessage } from '../types/whatsapp';

export interface WhatsAppControllerDeps {
  chatbot: MessageHandler;
  sender: WhatsAppSender;
  idempotency: IdempotencyStore;
  logger: Logger;
}

export function parseIncomingMessage(payload: unknown): IncomingWhatsAppMessage {
  const result = incomingWebhookSchema.safeParse(payload ?? {});
  if (!result.success) {
    const fields = result.error.issues.map((i) => i.path.join('.') || 'body').join(', ');
    throw new BadRequestError(`Invalid webhook payload: ${fields}`);
  }
  const { MessageSid, From, To, Body } = result.data;
  return { messageSid: MessageSid, from: From, to: To, body: Body };
}

/**
 * Twilio expects TwiML (or an empty 200) from the webhook. We deliver the reply via the
 * REST API instead, so we acknowledge with an empty <Response/> — otherwise the user
 * would receive the reply twice.
 */
function acknowledge(res: Response): void {
  res.status(200).type('text/xml').send('<Response></Response>');
}

export function createWhatsAppController(deps: WhatsAppControllerDeps): RequestHandler {
  const { chatbot, sender, idempotency, logger } = deps;

  // Express 5 forwards rejected promises from async handlers to the error handler.
  return async (req, res) => {
    const message = parseIncomingMessage(req.body);

    logger.info('whatsapp.message.received', {
      messageSid: message.messageSid,
      from: message.from,
      to: message.to,
      messageBody: message.body,
    });

    const isNew = await idempotency.claim(message.messageSid);
    if (!isNew) {
      logger.info('whatsapp.message.duplicate', { messageSid: message.messageSid });
      acknowledge(res);
      return;
    }

    let replyText: string;
    try {
      const reply = await chatbot.handleMessage({
        userId: message.from,
        text: message.body,
        messageId: message.messageSid,
      });
      replyText = reply.text;
    } catch (err) {
      throw new ChatbotError(err);
    }

    const sent = await sender.sendWhatsAppMessage({ to: message.from, body: replyText });

    logger.info('whatsapp.message.replied', {
      messageSid: message.messageSid,
      to: message.from,
      replySid: sent.sid,
    });
    acknowledge(res);
  };
}
