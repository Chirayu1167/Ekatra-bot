import express, { Router, type RequestHandler } from 'express';
import {
  createWhatsAppController,
  type WhatsAppControllerDeps,
} from '../controllers/whatsapp.controller';
import { validateTwilioSignature } from '../middleware/validateTwilioSignature';

export interface WhatsAppRouterOptions extends WhatsAppControllerDeps {
  validateSignature: boolean;
  authToken: string;
  publicBaseUrl?: string | undefined;
}

export function createWhatsAppRouter(options: WhatsAppRouterOptions): Router {
  const router = Router();

  const middleware: RequestHandler[] = [express.urlencoded({ extended: false })];
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
