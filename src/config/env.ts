import { z } from 'zod';

/**
 * Thrown when required configuration is missing or invalid.
 * The message is safe to print: it names variables, never their values.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const required = (name: string) =>
  z.string({ error: `${name} is required` }).min(1, `${name} is required`);

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  TWILIO_ACCOUNT_SID: required('TWILIO_ACCOUNT_SID'),
  TWILIO_AUTH_TOKEN: required('TWILIO_AUTH_TOKEN'),
  TWILIO_WHATSAPP_FROM: required('TWILIO_WHATSAPP_FROM').regex(
    /^whatsapp:\+\d{7,15}$/,
    'TWILIO_WHATSAPP_FROM must look like "whatsapp:+14155238886"',
  ),
  // Secure by default: validation is ON unless explicitly set to "false".
  TWILIO_WEBHOOK_VALIDATE: z
    .enum(['true', 'false'], { error: 'TWILIO_WEBHOOK_VALIDATE must be "true" or "false"' })
    .default('true')
    .transform((v) => v === 'true'),
  PUBLIC_BASE_URL: z
    .url({ error: 'PUBLIC_BASE_URL must be a valid URL, e.g. https://example.ngrok-free.app' })
    .transform((v) => v.replace(/\/+$/, ''))
    .optional(),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Parse and validate configuration. Pass a custom source in tests;
 * defaults to process.env. Empty strings are treated as "not set".
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value !== ''),
  );
  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `  - ${i.message}`).join('\n');
    throw new ConfigError(
      `Invalid configuration:\n${problems}\n\nCopy .env.example to .env and fill in the values.`,
    );
  }
  return result.data;
}
