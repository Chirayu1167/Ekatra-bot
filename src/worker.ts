import dotenv from 'dotenv';
import os from 'node:os';
import { CourseBot } from './bot/courseBot';
import { Chatbot } from './bot/chatbot';
import {
  assertProductionIngress,
  ConfigError,
  loadEnv,
  shouldRunMigrationsAtStartup,
  type Env,
} from './config/env';
import { createPool } from './db/pg';
import { migratePostgres } from './db/migratePg';
import { query } from './db/pg';
import { createLogger } from './logger';
import { AdminAuthService } from './services/adminAuth.service';
import { CertificateService } from './services/certificate.service';
import { CourseService } from './services/course.service';
import { OrganisationsService } from './services/organisations.service';
import { CourseTutor } from './services/courseTutor';
import { LearnerService } from './services/learner.service';
import { LLMService } from './services/llm.service';
import { EnrollmentService } from './services/enrollment.service';
import crypto from 'node:crypto';
import { InboundEventService } from './services/inboundEvents.service';
import { JobService } from './services/jobs.service';
import { OutboundService } from './services/outbound.service';
import { SchedulerService } from './services/scheduler.service';
import { OptOutService } from './services/optout.service';
import { createTwilioClient, TwilioWhatsAppService } from './services/whatsapp.service';
import { LocalFakeWhatsAppSender } from './services/localFakeSender';
import { drainJobs, reclaimStuck, type ProcessorDeps } from './worker/processor';
import { setQueueDepth, setWorkerHeartbeatAgeSeconds } from './services/metrics.service';
import { DisabledVoiceService, OpenAIVoiceService } from './services/voice.service';

dotenv.config({ quiet: true });

function loadEnvOrExit(): Env {
  try {
    return loadEnv();
  } catch (err) {
    console.error(err instanceof ConfigError ? err.message : err);
    process.exit(1);
  }
}

const env = loadEnvOrExit();
try {
  assertProductionIngress(env);
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
}
const logger = createLogger();
const workerId = `worker-${os.hostname()}-${process.pid}`;

const pool = createPool(
  {
    connectionString: env.DATABASE_URL,
    max: env.DATABASE_POOL_MAX,
    ssl: env.DATABASE_SSL === 'require',
    statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
    idleTimeoutMs: env.DATABASE_IDLE_TIMEOUT_MS,
  },
  logger,
);

async function heartbeat(): Promise<void> {
  await query(
    pool,
    `INSERT INTO worker_heartbeat (worker_id, last_beat, hostname)
     VALUES ($1, now(), $2)
     ON CONFLICT (worker_id) DO UPDATE SET last_beat = now(), hostname = $2`,
    [workerId, os.hostname()],
  );
}

function buildProcessor(): ProcessorDeps {
  const db = pool;
  const orgs = new OrganisationsService(db);
  const courses = new CourseService(db);
  const enrollments = new EnrollmentService(db);
  const learners = new LearnerService(db);
  const optOuts = new OptOutService(db, env.OPTOUT_HASH_SECRET, env.OPTOUT_HASH_SECRET_PREVIOUS);
  const certificates = new CertificateService(
    db,
    learners,
    env.CERTIFICATE_SECRET ??
      crypto.createHash('sha256').update(`${env.TWILIO_AUTH_TOKEN}:certificates`).digest('hex'),
  );
  const tutor = new CourseTutor({
    llm: new LLMService({
      config: {
        model: env.LLM_MODEL,
        baseUrl: env.LLM_BASE_URL,
        timeoutMs: env.LLM_TIMEOUT_MS,
        maxTokens: env.LLM_MAX_TOKENS,
        temperature: env.LLM_TEMPERATURE,
      },
      logger,
    }),
    courses,
    questionsPerHour: env.LLM_QUESTIONS_PER_HOUR,
    logger,
  });
  const chatbot = new CourseBot({
    courses,
    enrollments,
    optOuts,
    orgs,
    buttons: {
      next: env.TWILIO_CONTENT_SID_NAV,
      resume: env.TWILIO_CONTENT_SID_RESUME,
      startCourse: env.TWILIO_CONTENT_SID_START_COURSE,
      courses: env.TWILIO_CONTENT_SID_COURSES,
      cmds1: env.TWILIO_CONTENT_SID_CMDS_1,
      cmds2: env.TWILIO_CONTENT_SID_CMDS_2,
      quiz: env.TWILIO_CONTENT_SID_QUIZ,
      courseSelect: [],
    },
    fallback: new Chatbot({ mainMenuButtonSid: env.TWILIO_CONTENT_SID_MAIN_MENU }),
    tutor,
    certificates,
    publicBaseUrl: env.PUBLIC_BASE_URL,
    learnerName: (userId) => learners.getName(userId),
    logger,
  });
  // The processor wraps this with the OptOutGuardSender: the central guard
  // covers every send path, exactly as the API process used to.
  const rawSender =
    process.env['EKATRA_FAKE_SENDER'] === 'true'
      ? env.NODE_ENV === 'production'
        ? (() => { throw new Error('EKATRA_FAKE_SENDER is development-only'); })()
        : new LocalFakeWhatsAppSender()
      : new TwilioWhatsAppService(
          createTwilioClient(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, {
            timeout: env.TWILIO_REQUEST_TIMEOUT_MS,
          }),
          env.TWILIO_WHATSAPP_FROM,
          logger,
          env.TWILIO_REQUEST_TIMEOUT_MS,
          env.PUBLIC_BASE_URL
            ? `${env.PUBLIC_BASE_URL}/webhooks/whatsapp/status`
            : undefined,
        );
  return {
    db,
    chatbot,
    rawSender,
    optOuts,
    enrollments,
    certificates,
    courses,
    scheduleRender: {
      buttons: {
        next: env.TWILIO_CONTENT_SID_NAV,
        resume: env.TWILIO_CONTENT_SID_RESUME,
        startCourse: env.TWILIO_CONTENT_SID_START_COURSE,
        courses: env.TWILIO_CONTENT_SID_COURSES,
        cmds1: env.TWILIO_CONTENT_SID_CMDS_1,
        cmds2: env.TWILIO_CONTENT_SID_CMDS_2,
        quiz: env.TWILIO_CONTENT_SID_QUIZ,
        courseSelect: [],
      },
      certificates,
      publicBaseUrl: env.PUBLIC_BASE_URL,
      learnerName: (userId) => learners.getName(userId),
      templateSid: env.TWILIO_CONTENT_SID_SCHEDULE,
    },
    inbound: new InboundEventService(db),
    jobs: new JobService(db),
    outbound: new OutboundService(db),
    logger,
    workerId,
    visibilitySecs: env.WORKER_VISIBILITY_SECS,
    // Voice services: STT transcribes inbound voice notes; TTS synthesizes outbound replies.
    voiceServices: (() => {
      const sttEnabled = env.VOICE_STT_ENABLED && env.VOICE_STT_PROVIDER === 'openai';
      const ttsEnabled = env.VOICE_TTS_ENABLED && env.VOICE_TTS_PROVIDER === 'openai';
      if (!sttEnabled && !ttsEnabled) return new DisabledVoiceService();
      if (!env.VOICE_STT_API_KEY && !env.VOICE_TTS_API_KEY) return new DisabledVoiceService();
      const voice = new OpenAIVoiceService({
        baseUrl: env.VOICE_STT_BASE_URL ?? env.VOICE_TTS_BASE_URL ?? 'https://api.openai.com/v1',
        apiKey: env.VOICE_STT_API_KEY ?? env.VOICE_TTS_API_KEY ?? '',
        sttModel: env.VOICE_STT_MODEL,
        ttsModel: env.VOICE_TTS_MODEL,
        ttsVoice: env.VOICE_TTS_VOICE,
        mediaDir: env.MEDIA_DIR,
        publicBaseUrl: env.PUBLIC_BASE_URL,
        logger,
      });
      return {
        stt: sttEnabled ? voice : { transcribe: async () => null },
        tts: ttsEnabled ? voice : { synthesize: async () => null },
      };
    })(),
    twilioAuth: env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN
      ? { accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN }
      : undefined,
  };
}

async function main(): Promise<void> {
  if (shouldRunMigrationsAtStartup(env)) {
    await migratePostgres(pool, undefined, logger);
  } else {
    logger.info('db.migration_job.required_before_start');
  }
  // Touch the auth service so key verification shares the API's code path.
  void new AdminAuthService(pool);
  const processor = buildProcessor();
  logger.info('worker.started', {
    worker: workerId,
    pollMs: env.WORKER_POLL_MS,
    visibilitySecs: env.WORKER_VISIBILITY_SECS,
  });

  let stopped = false;
  const shutdown = (signal: string): void => {
    logger.info('worker.stopping', { signal, worker: workerId });
    stopped = true;
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Crash recovery first: work stuck 'processing' becomes claimable again.
  await reclaimStuck(processor);
  const scheduler = new SchedulerService(pool);
  let lastScheduleTick = 0;
  while (!stopped) {
    try {
      await reclaimStuck(processor);
      await drainJobs(processor, env.WORKER_MAX_JOBS_PER_TICK);
      // Scheduler tick on its own cadence, behind a single-leader lock so any
      // number of workers (or restarts) can never double-enqueue a slot.
      if (env.SCHEDULER_ENABLED && Date.now() - lastScheduleTick >= env.SCHEDULER_TICK_MS) {
        lastScheduleTick = Date.now();
        const result = await scheduler.tick(Date.now());
        if (result.led && (result.enqueued > 0 || result.skipped > 0)) {
          logger.info('scheduler.tick', { ...result, worker: workerId });
        }
      }
      await heartbeat();
      // Export queue depth + heartbeat age for Prometheus scraping.
      try {
        const kinds: Array<{ kind: 'inbound_process' | 'outbound_send'; status: 'queued' | 'processing' | 'completed' | 'failed' }> = [
          { kind: 'inbound_process', status: 'queued' },
          { kind: 'inbound_process', status: 'processing' },
          { kind: 'inbound_process', status: 'completed' },
          { kind: 'inbound_process', status: 'failed' },
          { kind: 'outbound_send', status: 'queued' },
          { kind: 'outbound_send', status: 'processing' },
          { kind: 'outbound_send', status: 'completed' },
          { kind: 'outbound_send', status: 'failed' },
        ];
        for (const { kind, status } of kinds) {
          const n = await processor.jobs.countByStatus(kind, status);
          setQueueDepth(kind, status, n);
        }
      } catch {
        // metrics must never kill the worker loop
      }
      try {
        const beat = await query<{ last_beat: Date }>(
          pool,
          'SELECT last_beat FROM worker_heartbeat ORDER BY last_beat DESC LIMIT 1',
        );
        const row = beat.rows[0];
        if (row) {
          setWorkerHeartbeatAgeSeconds((Date.now() - new Date(row.last_beat).getTime()) / 1000);
        }
      } catch {
        // heartbeat table may not exist yet
      }
    } catch (err) {
      // A tick failure must never kill the worker: log and continue polling.
      logger.error('worker.tick.failed', { error: err instanceof Error ? err.message : String(err) });
    }
    await new Promise((r) => setTimeout(r, env.WORKER_POLL_MS));
  }
  await pool.end();
  process.exit(0);
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  void pool.end().finally(() => process.exit(1));
});
