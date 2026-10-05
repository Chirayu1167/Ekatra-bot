import dotenv from 'dotenv';
import { Chatbot } from './bot/chatbot';
import { createApp } from './app';
import { ConfigError, loadEnv, type Env } from './config/env';
import { createLogger } from './logger';
import { NoopIdempotencyStore } from './services/idempotency';
import { createTwilioClient, TwilioWhatsAppService } from './services/whatsapp.service';

dotenv.config({ quiet: true });

function loadEnvOrExit(): Env {
  try {
    return loadEnv();
  } catch (err) {
    // Fail fast with a clear, secret-free message.
    console.error(err instanceof ConfigError ? err.message : err);
    process.exit(1);
  }
}

const env = loadEnvOrExit();
const logger = createLogger();

const sender = new TwilioWhatsAppService(
  createTwilioClient(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN),
  env.TWILIO_WHATSAPP_FROM,
  logger,
);

const app = createApp({
  env,
  chatbot: new Chatbot(),
  sender,
  idempotency: new NoopIdempotencyStore(),
  logger,
});

if (!env.TWILIO_WEBHOOK_VALIDATE) {
  logger.warn('twilio.signature.validation_disabled', {
    note: 'Incoming webhooks are NOT verified. Use only for local development.',
  });
}

const server = app.listen(env.PORT, () => {
  logger.info('server.started', {
    port: env.PORT,
    signatureValidation: env.TWILIO_WEBHOOK_VALIDATE,
  });
});

function shutdown(signal: string): void {
  logger.info('server.stopping', { signal });
  server.close(() => process.exit(0));
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
