import express, { type Express } from 'express';
import type { MessageHandler } from './bot/chatbot';
import type { Env } from './config/env';
import { createLogger, type Logger } from './logger';
import { createErrorHandler, notFoundHandler } from './middleware/errorHandler';
import { createWhatsAppRouter } from './routes/whatsapp';
import { NoopIdempotencyStore, type IdempotencyStore } from './services/idempotency';
import type { WhatsAppSender } from './services/whatsapp.service';

export interface AppDeps {
  env: Pick<Env, 'TWILIO_AUTH_TOKEN' | 'TWILIO_WEBHOOK_VALIDATE' | 'PUBLIC_BASE_URL'>;
  chatbot: MessageHandler;
  sender: WhatsAppSender;
  idempotency?: IdempotencyStore;
  logger?: Logger;
}

/** Builds the Express app. All collaborators are injected so tests (and future code) can swap them. */
export function createApp(deps: AppDeps): Express {
  const logger = deps.logger ?? createLogger();
  const app = express();

  app.disable('x-powered-by');
  // Behind ngrok / a load balancer, honour X-Forwarded-* so req.protocol and host are the public ones.
  // For production prefer setting PUBLIC_BASE_URL, which removes any reliance on these headers.
  app.set('trust proxy', 1);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use(
    '/webhooks/whatsapp',
    createWhatsAppRouter({
      chatbot: deps.chatbot,
      sender: deps.sender,
      idempotency: deps.idempotency ?? new NoopIdempotencyStore(),
      logger,
      validateSignature: deps.env.TWILIO_WEBHOOK_VALIDATE,
      authToken: deps.env.TWILIO_AUTH_TOKEN,
      publicBaseUrl: deps.env.PUBLIC_BASE_URL,
    }),
  );

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));
  return app;
}
