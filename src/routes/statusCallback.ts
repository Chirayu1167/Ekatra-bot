import express, { Router, type RequestHandler } from 'express';
import {
  createStatusCallbackController,
  type StatusCallbackControllerDeps,
} from '../controllers/statusCallback.controller';
import { validateTwilioSignature } from '../middleware/validateTwilioSignature';

export interface StatusCallbackRouterOptions extends StatusCallbackControllerDeps {
  validateSignature: boolean;
  authToken: string;
  publicBaseUrl?: string | undefined;
}

export function createStatusCallbackRouter(options: StatusCallbackRouterOptions): Router {
  const router = Router();

  // Same small-form bound as the inbound webhook; callbacks must also fail fast on junk.
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

  router.post('/', ...middleware, createStatusCallbackController(options));
  return router;
}
