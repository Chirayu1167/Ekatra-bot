import express, { Router, type RequestHandler } from 'express';
import {
  createWhatsAppController,
  type DurableWhatsAppControllerDeps,
} from '../controllers/whatsapp.controller';
import { validateTwilioSignature } from '../middleware/validateTwilioSignature';

export interface WhatsAppRouterOptions extends DurableWhatsAppControllerDeps {
  validateSignature: boolean;
  authToken: string;
  publicBaseUrl?: string | undefined;
}

export function createWhatsAppRouter(options: WhatsAppRouterOptions): Router {
  const router = Router();

  // Twilio posts small forms; bound the body so a huge payload fails fast with 413.
  const middleware: RequestHandler[] = [express.urlencoded({ extended: false, limit: '32kb' })];
  if (options.validateSignature) {
    middleware.push(
      validateTwilioSignature({
        authToken: options.authToken,
        publicBaseUrl: options.publicBaseUrl,
        logger: options.logger,
      }),
    );
  }

  router.post('/', ...middleware, createWhatsAppController(options));
  return router;
}
