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

const contentSid = () =>
  z
    .string()
    .regex(/^HX[0-9a-fA-F]{32}$/, 'must be a Twilio Content SID (starts with HX)')
    .optional();

const required = (name: string) =>
  z.string({ error: `${name} is required` }).min(1, `${name} is required`);

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  RUN_MIGRATIONS_ON_START: z
    .enum(['true', 'false'], { error: 'RUN_MIGRATIONS_ON_START must be "true" or "false"' })
    .default('false')
    .transform((v) => v === 'true'),
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
  // Enables the /admin API. Leave unset to keep the admin API switched off.
  ADMIN_API_KEY: z.string().min(16, 'ADMIN_API_KEY must be at least 16 characters').optional(),
  // Files in this folder are served publicly at /media so Twilio can fetch lesson attachments.
  MEDIA_DIR: z.string().min(1).default('./media'),
// Twilio Content Template SIDs for tap-buttons (create them with `npm run buttons:setup`).
// Each is optional; without it that button set falls back to typed commands.
  TWILIO_CONTENT_SID_NAV: contentSid(),
  TWILIO_CONTENT_SID_RESUME: contentSid(),
  TWILIO_CONTENT_SID_START_COURSE: contentSid(),
  TWILIO_CONTENT_SID_COURSES: contentSid(),
  TWILIO_CONTENT_SID_MAIN_MENU: contentSid(),
  TWILIO_CONTENT_SID_CMDS_1: contentSid(),
  TWILIO_CONTENT_SID_CMDS_2: contentSid(),
  TWILIO_CONTENT_SID_QUIZ: contentSid(),
  // Approved WhatsApp template sent right after web registration (see `npm run buttons:setup`).
  TWILIO_CONTENT_SID_WELCOME: contentSid(),
  // Approved quick-reply template sent when a scheduled lesson lands outside the 24-hour
  // window (see docs/scheduling.md). Its button payload maps to NEXT, which delivers the
  // pending lesson. Optional: unset means closed-window scheduled lessons fail visibly.
  TWILIO_CONTENT_SID_SCHEDULE: contentSid(),
  // Hard request timeout for every Twilio API call (ms), in addition to the Promise.race backstop.
  TWILIO_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(10000),
  // Signs certificate links. Defaults to a value derived from TWILIO_AUTH_TOKEN if unset.
  CERTIFICATE_SECRET: z.string().min(16, 'CERTIFICATE_SECRET must be at least 16 characters').optional(),
  // Certificate resend cooldown (minutes). A second resend of the same certificate inside this
  // window returns 409 and sends nothing. Default 10.
  CERT_RESEND_COOLDOWN_MINUTES: z.coerce.number().int().min(1).max(10080).default(10),
  // Local LLM (Ollama) — optional; if unset or Ollama unreachable, falls back to deterministic chatbot.
  LLM_MODEL: z.string().min(1).default('qwen2.5:1.5b-instruct-q4_k_m'),
  LLM_BASE_URL: z.string().url().default('http://localhost:11434'),
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(10000),
  LLM_MAX_TOKENS: z.coerce.number().int().min(50).max(2000).default(250),
  LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
  // Course questions each learner may ask per hour (bounds cost and abuse).
  LLM_QUESTIONS_PER_HOUR: z.coerce.number().int().min(1).max(500).default(20),
  // --- Voice assistance (optional) --------------------------------------------------------
  // Voice input: transcribe incoming WhatsApp voice notes via an OpenAI-compatible STT API.
  VOICE_STT_ENABLED: z
    .enum(['true', 'false'], { error: 'VOICE_STT_ENABLED must be "true" or "false"' })
    .default('false')
    .transform((v) => v === 'true'),
  VOICE_STT_PROVIDER: z.enum(['openai', 'none']).default('none'),
  VOICE_STT_API_KEY: z.string().min(1).optional(),
  VOICE_STT_BASE_URL: z.string().url().optional(),
  VOICE_STT_MODEL: z.string().min(1).default('whisper-1'),
  // Voice output: synthesize replies into audio and send as media messages.
  VOICE_TTS_ENABLED: z
    .enum(['true', 'false'], { error: 'VOICE_TTS_ENABLED must be "true" or "false"' })
    .default('false')
    .transform((v) => v === 'true'),
  VOICE_TTS_PROVIDER: z.enum(['openai', 'none']).default('none'),
  VOICE_TTS_API_KEY: z.string().min(1).optional(),
  VOICE_TTS_BASE_URL: z.string().url().optional(),
  VOICE_TTS_MODEL: z.string().min(1).default('tts-1'),
  VOICE_TTS_VOICE: z.string().min(1).default('alloy'),
  // Comma-separated origins allowed for cross-origin browser calls. Default: none (no CORS).
  CORS_ORIGINS: z.string().optional(),
  // Failed admin/webhook auth attempts allowed per IP per hour before 429s. Bounds probing.
  RATE_LIMIT_AUTH_FAILURES_PER_HOUR: z.coerce.number().int().min(10).max(100000).default(100),
  // Retention (days) for webhook de-duplication ids. Opt-outs, enrollments and completion
  // records are NEVER pruned here.
  PROCESSED_MESSAGE_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  // Retention (days) for audit-log rows. Pruned only by `npm run cleanup`, never automatically.
  AUDIT_LOG_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(365),
  // Retention (days) for durable-delivery rows. Pruned only by `npm run cleanup`. Opt-outs,
  // enrollments, certificates and learner profiles are never pruned here.
  JOB_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  ATTEMPT_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  INBOUND_EVENT_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  DEAD_LETTER_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  // Opt-out phone hash: keyed HMAC when OPTOUT_HASH_SECRET is set, plain SHA-256 otherwise.
  // Required in production; refusing to start without it prevents silently re-enabling
  // messaging to opted-out numbers after a secret rotation or loss.
  OPTOUT_HASH_SECRET: z.string().min(32, 'OPTOUT_HASH_SECRET must be at least 32 characters').optional(),
  // Previous opt-out hash secret, used during secret rotation. When set, both this and
  // OPTOUT_HASH_SECRET are accepted when checking opt-out status; new opt-outs are written
  // only with OPTOUT_HASH_SECRET. Allows zero-downtime secret rotation.
  OPTOUT_HASH_SECRET_PREVIOUS: z.string().min(32, 'OPTOUT_HASH_SECRET_PREVIOUS must be at least 32 characters').optional(),
  // Readiness (A5): heartbeat age threshold (ms) for the worker-status route. Default 60s.
  READINESS_HEARTBEAT_MAX_AGE_MS: z.coerce.number().int().min(1000).max(3600000).default(60000),
  // --- Phase 3 durable delivery (worker, retry, scheduling) -------------------------------
  // How often the worker polls for due jobs. Default 2000ms.
  WORKER_POLL_MS: z.coerce.number().int().min(500).max(60000).default(2000),
  // Crash-recovery horizon: a job/event stuck in 'processing' longer than this
  // is reclaimed by another worker. Default 300s.
  WORKER_VISIBILITY_SECS: z.coerce.number().int().min(30).max(3600).default(300),
  // Upper bound on jobs processed per poll tick (bounds one tick's latency). Default 4.
  WORKER_MAX_JOBS_PER_TICK: z.coerce.number().int().min(1).max(1000).default(4),
  // Scheduler loop: enabled by default; tick interval 60s. Only one worker
  // leads a tick at a time (advisory lock); the rest skip.
  SCHEDULER_ENABLED: z
    .enum(['true', 'false'], { error: 'SCHEDULER_ENABLED must be "true" or "false"' })
    .default('true')
    .transform((v) => v === 'true'),
  SCHEDULER_TICK_MS: z.coerce.number().int().min(5000).max(3600000).default(60000),
  // Fallback catch-up grace (hours) when an org has none configured. Default 6.
  SCHEDULER_GRACE_HOURS: z.coerce.number().int().min(1).max(72).default(6),
  // --- PostgreSQL (system of record) -------------------------------------------------------
  // Connection URL, e.g. postgres://user:pass@localhost:5432/ekatra. Required: startup fails
  // fast naming the variable (never its value). Tests provision their own databases.
  DATABASE_URL: required('DATABASE_URL'),
  MIGRATION_DATABASE_URL: z
    .string()
    .regex(/^postgres(?:ql)?:\/\//, 'MIGRATION_DATABASE_URL must use a postgres:// URL')
    .optional(),
  // Pool sizing and timeouts.
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  // off | require. Staging/production hosted databases must set require.
  DATABASE_SSL: z.enum(['off', 'require'], { error: 'DATABASE_SSL must be "off" or "require"' }).default('off'),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000).default(10000),
  DATABASE_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(3600000).default(30000),
});

/**
 * Refuse to run production ingress without webhook signature validation: an unverified
 * public webhook would let anyone drive lessons, spending and learner state.
 */
export function assertProductionIngress(env: Pick<Env, 'NODE_ENV' | 'TWILIO_WEBHOOK_VALIDATE'>): void {
  if (env.NODE_ENV === 'production' && !env.TWILIO_WEBHOOK_VALIDATE) {
    throw new ConfigError(
      'Invalid configuration:\n  - TWILIO_WEBHOOK_VALIDATE must be "true" in production (signature validation protects the public webhook)',
    );
  }
}

export function shouldRunMigrationsAtStartup(
  env: Pick<Env, 'NODE_ENV' | 'RUN_MIGRATIONS_ON_START'>,
): boolean {
  return env.NODE_ENV !== 'production' || env.RUN_MIGRATIONS_ON_START;
}

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
  const env = result.data;
  // Cap parallel work strictly below the pool: two connections per in-flight job,
  // plus one each for the scheduler leader lock and the heartbeat writer.
  const needed = env.WORKER_MAX_JOBS_PER_TICK * 2 + 2;
  if (needed > env.DATABASE_POOL_MAX) {
    throw new ConfigError(
      `Invalid configuration:\n  - WORKER_MAX_JOBS_PER_TICK (${env.WORKER_MAX_JOBS_PER_TICK}) needs ${needed} pool connections\n    (2 per job + scheduler + heartbeat) but DATABASE_POOL_MAX is ${env.DATABASE_POOL_MAX}.\n    Raise DATABASE_POOL_MAX or lower WORKER_MAX_JOBS_PER_TICK.`,
    );
  }
  // In production the opt-out hash secret is mandatory: losing or changing it silently
  // re-enables messaging to opted-out numbers. In dev/test a documented default is allowed.
  if (env.NODE_ENV === 'production' && !env.OPTOUT_HASH_SECRET) {
    throw new ConfigError(
      'Invalid configuration:\n  - OPTOUT_HASH_SECRET is required in production (keyed HMAC for opt-out phone hashes)\n    Set it to a 32+ character secret and back it up: losing it makes opted-out numbers unreachable.',
    );
  }
  return env;
}
