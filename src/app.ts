import fs from 'node:fs';
import path from 'node:path';
import express, { type Express } from 'express';
import type { Pool } from 'pg';
import type { Env } from './config/env';
import { createLogger, type Logger } from './logger';
import { createErrorHandler, notFoundHandler } from './middleware/errorHandler';
import {
  authFailureLimiter,
  corsIfConfigured,
  securityHeaders,
} from './middleware/security';
import { createAdminRouter, type AdminRouterOptions } from './routes/admin';
import { createWhatsAppRouter } from './routes/whatsapp';
import { createStatusCallbackRouter } from './routes/statusCallback';
import type { StatusCallbackControllerDeps } from './controllers/statusCallback.controller';
import { createRegistrationRouter } from './routes/registration';
import { createCertificatesRouter } from './routes/certificates';
import type { CertificateService } from './services/certificate.service';
import type { LearnerService } from './services/learner.service';
import type { OptOutService } from './services/optout.service';
import type { InboundEventService } from './services/inboundEvents.service';
import type { JobService } from './services/jobs.service';
import type { CourseService } from './services/course.service';
import type { EnrollmentService } from './services/enrollment.service';
import type { OrganisationsService } from './services/organisations.service';
import { metrics } from './services/metrics.service';
import { metricsMiddleware } from './middleware/metrics';
import { query } from './db/pg';

/**
 * Every mounted route, with its protection class. This is the single source of truth also
 * published in docs/route-inventory.md; tests/ingress.test.ts pins it, so adding a route
 * without classifying it here breaks the build.
 */
export const ROUTE_INVENTORY: { method: string; path: string; protection: string }[] = [
  { method: 'GET', path: '/health', protection: 'public:health' },
  { method: 'GET', path: '/metrics', protection: 'public:health' },
  { method: 'GET', path: '/console', protection: 'public:static-console' },
  { method: 'GET', path: '/ready', protection: 'public:health' },
  { method: 'GET', path: '/worker-status', protection: 'public:health' },
  { method: 'GET', path: '/register', protection: 'public:page' },
  { method: 'GET', path: '/register/courses', protection: 'public:catalog' },
  { method: 'POST', path: '/register', protection: 'public:rate-limited' },
  { method: 'GET', path: '/certificates/:file', protection: 'public:capability-url' },
  { method: 'POST', path: '/webhooks/whatsapp', protection: 'twilio-signature' },
  { method: 'POST', path: '/webhooks/whatsapp/status', protection: 'twilio-signature' },
  { method: 'GET', path: '/admin/courses', protection: 'admin:role' },
  { method: 'POST', path: '/admin/courses', protection: 'admin:role' },
  { method: 'GET', path: '/admin/courses/:id', protection: 'admin:role' },
  { method: 'PATCH', path: '/admin/courses/:id', protection: 'admin:role' },
  { method: 'DELETE', path: '/admin/courses/:id', protection: 'admin:role' },
  { method: 'POST', path: '/admin/courses/:id/publish', protection: 'admin:role' },
  { method: 'POST', path: '/admin/courses/:id/unpublish', protection: 'admin:role' },
  { method: 'POST', path: '/admin/courses/:id/lessons', protection: 'admin:role' },
  { method: 'PUT', path: '/admin/courses/:id/lessons/:lessonId', protection: 'admin:role' },
  { method: 'DELETE', path: '/admin/courses/:id/lessons/:lessonId', protection: 'admin:role' },
  { method: 'GET', path: '/admin/courses/:id/schedule', protection: 'admin:role' },
  { method: 'PUT', path: '/admin/courses/:id/schedule', protection: 'admin:role' },
  { method: 'DELETE', path: '/admin/courses/:id/schedule', protection: 'admin:role' },
  { method: 'GET', path: '/admin/enrollments/:id/schedule', protection: 'admin:manage-users' },
  { method: 'PUT', path: '/admin/enrollments/:id/schedule', protection: 'admin:manage-users' },
  { method: 'GET', path: '/admin/schedule-defaults', protection: 'admin:manage-users' },
  { method: 'PUT', path: '/admin/schedule-defaults', protection: 'admin:manage-users' },
  { method: 'GET', path: '/admin/failures', protection: 'admin:manage-users' },
  { method: 'GET', path: '/admin/failures/:id', protection: 'admin:manage-users' },
  { method: 'POST', path: '/admin/failures/:id/replay', protection: 'admin:manage-users' },
  { method: 'POST', path: '/admin/failures/:id/discard', protection: 'admin:manage-users' },
  { method: 'GET', path: '/admin/orgs', protection: 'admin:platform' },
  { method: 'POST', path: '/admin/orgs', protection: 'admin:platform' },
  { method: 'GET', path: '/admin/users', protection: 'admin:manage-users' },
  { method: 'POST', path: '/admin/users', protection: 'admin:manage-users' },
  { method: 'POST', path: '/admin/users/:id/keys', protection: 'admin:manage-users' },
  { method: 'DELETE', path: '/admin/users/:id/keys/:keyId', protection: 'admin:manage-users' },
  { method: 'POST', path: '/admin/users/:id/recover', protection: 'admin:platform' },
  { method: 'GET', path: '/admin/audit', protection: 'admin:manage-users' },
  { method: 'GET', path: '/admin/learners/:phone/export', protection: 'admin:manage-users' },
  { method: 'DELETE', path: '/admin/learners/:phone', protection: 'admin:manage-users' },
  // Step 1 admin console endpoints (Phase 4)
  { method: 'GET', path: '/admin/session', protection: 'admin:role' },
  { method: 'GET', path: '/admin/learners', protection: 'admin:learner-read' },
  { method: 'GET', path: '/admin/learners/:id', protection: 'admin:learner-read' },
  { method: 'GET', path: '/admin/enrollments', protection: 'admin:learner-read' },
  { method: 'POST', path: '/admin/enrollments', protection: 'admin:manage-users' },
  { method: 'POST', path: '/admin/enrollments/:id/pause', protection: 'admin:manage-users' },
  { method: 'POST', path: '/admin/enrollments/:id/resume', protection: 'admin:manage-users' },
  { method: 'GET', path: '/admin/delivery', protection: 'admin:manage-users' },
  { method: 'GET', path: '/admin/delivery/:id', protection: 'admin:manage-users' },
  { method: 'GET', path: '/admin/certificates', protection: 'admin:manage-users' },
  { method: 'POST', path: '/admin/certificates/:id/resend', protection: 'admin:manage-users' },
  { method: 'GET', path: '/admin/schedule-preview', protection: 'admin:manage-users' },
  // GET /media/* is static middleware (public by design), not a route layer: see inventory doc.
];

export interface AppDeps {
  env: Pick<Env, 'TWILIO_AUTH_TOKEN' | 'TWILIO_WEBHOOK_VALIDATE' | 'PUBLIC_BASE_URL'> &
    Partial<Pick<Env, 'CORS_ORIGINS' | 'RATE_LIMIT_AUTH_FAILURES_PER_HOUR' | 'READINESS_HEARTBEAT_MAX_AGE_MS'>>;
  /** Database pool (required for /ready and /worker-status). */
  db: Pool;
  /** Durable inbound store + work queue (the webhook only accepts and enqueues). */
  inbound: InboundEventService;
  jobs: JobService;
  /** Twilio delivery-status callbacks (signed, deduped, monotonic). */
  statusCallback: StatusCallbackControllerDeps;
  logger?: Logger;
  /** Enables the /admin course API. Omit to leave it switched off (routes return 404). */
  admin?: AdminRouterOptions;
  /** Course service for registration API. */
  courses?: CourseService;
  /** Enrollment service for registration API. */
  enrollments?: EnrollmentService;
  /** Tenant registry for registration + admin org scoping. */
  orgs?: OrganisationsService;
  learners?: LearnerService;
  optOuts?: OptOutService;
  certificates?: CertificateService;
  /** Folder served publicly at /media so Twilio can fetch lesson attachments. */
  mediaDir?: string;
  /** Built admin console directory; omitted when the console is not deployed. */
  consoleDir?: string;
}

/** Builds the Express app. All collaborators are injected so tests (and future code) can swap them. */
export function createApp(deps: AppDeps): Express {
  const logger = deps.logger ?? createLogger();
  const app = express();

  app.disable('x-powered-by');
  // Behind ngrok / a load balancer, honour X-Forwarded-* so req.protocol and host are the public ones.
  // For production prefer setting PUBLIC_BASE_URL, which removes any reliance on these headers.
  app.set('trust proxy', 1);

  app.use(securityHeaders());
  app.use(corsIfConfigured(deps.env.CORS_ORIGINS));
  app.use(metricsMiddleware());

  // Throttle credential probing (401/403 responses per IP). Valid callers never trip it.
  const failureLimiter = authFailureLimiter({
    maxFailures: deps.env.RATE_LIMIT_AUTH_FAILURES_PER_HOUR ?? 100,
    windowMs: 3_600_000,
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  /** Readiness: database connectivity + migration state. 503 only for DB/migration problems.
   * Reports worker heartbeat age in the body (informational — does not cause 503). */
  app.get('/ready', async (_req, res) => {
    const reasons: string[] = [];
    let dbOk = false;
    let migrationOk = false;
    let heartbeatAgeMs: number | null = null;
    try {
      await query(deps.db, 'SELECT 1');
      dbOk = true;
    } catch {
      reasons.push('database unavailable');
    }
    try {
      const versions = await query<{ version: number }>(
        deps.db,
        'SELECT version FROM schema_migrations ORDER BY version',
      );
      migrationOk = versions.rows.some((r) => r.version === 1) && versions.rows.some((r) => r.version === 2);
      if (!migrationOk) reasons.push('migration incomplete');
    } catch {
      reasons.push('migration state unreadable');
    }
    try {
      const beats = await query<{ last_beat: Date }>(
        deps.db,
        'SELECT last_beat FROM worker_heartbeat ORDER BY last_beat DESC LIMIT 1',
      );
      const row = beats.rows[0];
      if (row) heartbeatAgeMs = Date.now() - new Date(row.last_beat).getTime();
    } catch {
      // heartbeat table may not exist yet; age stays null.
    }
    const ready = dbOk && migrationOk;
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not_ready',
      database: dbOk,
      migration: migrationOk,
      heartbeatAgeMs,
      ...(reasons.length ? { reason: reasons.join('; ') } : {}),
    });
  });

  /** Worker status: heartbeat age against the configured threshold. 503 when stale. */
  app.get('/worker-status', async (_req, res) => {
    const thresholdMs = deps.env.READINESS_HEARTBEAT_MAX_AGE_MS ?? 60_000;
    let heartbeatAgeMs: number | null = null;
    let stale = true;
    try {
      const beats = await query<{ last_beat: Date }>(
        deps.db,
        'SELECT last_beat FROM worker_heartbeat ORDER BY last_beat DESC LIMIT 1',
      );
      const row = beats.rows[0];
      if (row) {
        heartbeatAgeMs = Date.now() - new Date(row.last_beat).getTime();
        stale = heartbeatAgeMs > thresholdMs;
      }
    } catch {
      stale = true;
    }
    const ok = !stale;
    res.status(ok ? 200 : 503).json({
      status: ok ? 'live' : 'stale',
      heartbeatAgeMs,
      thresholdMs,
      ...(!ok ? { reason: 'worker heartbeat is stale or missing' } : {}),
    });
  });

  // Public registration dashboard
  if (deps.courses && deps.enrollments && deps.learners && deps.optOuts && deps.orgs) {
    app.use(
      '/register',
      createRegistrationRouter({
        courses: deps.courses,
        enrollments: deps.enrollments,
        learners: deps.learners,
        optOuts: deps.optOuts,
        orgs: deps.orgs,
        logger,
      }),
    );
  }

  // Public, but only reachable with the signed code sent to the learner on completion.
  if (deps.certificates) app.use('/certificates', createCertificatesRouter(deps.certificates));

  app.use(
    '/webhooks/whatsapp',
    failureLimiter,
    createWhatsAppRouter({
      inbound: deps.inbound,
      jobs: deps.jobs,
      logger,
      validateSignature: deps.env.TWILIO_WEBHOOK_VALIDATE,
      authToken: deps.env.TWILIO_AUTH_TOKEN,
      publicBaseUrl: deps.env.PUBLIC_BASE_URL,
    }),
  );

  app.use(
    '/webhooks/whatsapp/status',
    failureLimiter,
    createStatusCallbackRouter({
      ...deps.statusCallback,
      validateSignature: deps.env.TWILIO_WEBHOOK_VALIDATE,
      authToken: deps.env.TWILIO_AUTH_TOKEN,
      publicBaseUrl: deps.env.PUBLIC_BASE_URL,
    }),
  );

  if (deps.admin) app.use('/admin', failureLimiter, createAdminRouter(deps.admin));

  if (deps.mediaDir && fs.existsSync(deps.mediaDir)) {
    // Public, read-only. Twilio fetches attachments from here, so everything in this folder
    // is world-readable. Twilio also checks the Content-Type header against the file.
    app.use(
      '/media',
      express.static(path.resolve(deps.mediaDir), {
        index: false,
        dotfiles: 'ignore',
        setHeaders: (res, filePath) => {
          res.setHeader('Content-Disposition', `inline; filename="${path.basename(filePath)}"`);
        },
      }),
    );
  }

  const consoleDir = deps.consoleDir ?? path.resolve(process.cwd(), 'admin-ui', 'dist');
  if (fs.existsSync(consoleDir) && fs.statSync(consoleDir).isDirectory()) {
    const staticConsole = express.static(consoleDir, {
      index: false,
      dotfiles: 'ignore',
      fallthrough: true,
      setHeaders: (res, filePath) => {
        const name = path.basename(filePath);
        res.setHeader(
          'Cache-Control',
          name === 'index.html'
            ? 'no-store'
            : /-[A-Za-z0-9_-]{8,}\./.test(name)
              ? 'public, max-age=31536000, immutable'
              : 'no-store',
        );
      },
    });
    app.use('/console', (req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        next();
        return;
      }
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
      );
      staticConsole(req, res, (err) => {
        if (err) {
          next(err);
          return;
        }
        if (res.headersSent) return;
        if (req.method !== 'GET') {
          next();
          return;
        }
        res.setHeader('Cache-Control', 'no-store');
        res.sendFile(path.join(consoleDir, 'index.html'), (sendError) => {
          if (sendError) next(sendError);
        });
      });
    });
  }

  // Prometheus scrape endpoint. No auth: it is intended to be scraped by an internal
  // Prometheus instance (or the host's node exporter sidecar), never exposed publicly.
  app.get('/metrics', (_req, res) => {
    res.type('text/plain; version=0.0.4; charset=utf-8').send(metrics.register());
  });

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));
  return app;
}
