import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../src/db/pg';
import { createApp } from '../src/app';
import { silentLogger } from '../src/logger';
import { query } from '../src/db/pg';
import { InboundEventService } from '../src/services/inboundEvents.service';
import { JobService } from '../src/services/jobs.service';
import { OutboundService } from '../src/services/outbound.service';
import { EnrollmentService } from '../src/services/enrollment.service';
import { resetDb } from './pg.helpers';
import { pgFileContext } from './pg.helpers';

const pgx = pgFileContext('readiness');

function buildApp(pg: Pool) {
  return createApp({
    env: {
      TWILIO_AUTH_TOKEN: 't',
      TWILIO_WEBHOOK_VALIDATE: false,
      PUBLIC_BASE_URL: 'https://example.test',
      READINESS_HEARTBEAT_MAX_AGE_MS: 60000,
    },
    db: pg,
    inbound: new InboundEventService(pg),
    jobs: new JobService(pg),
    statusCallback: {
      reconcile: {
        db: pg,
        outbound: new OutboundService(pg),
        enrollments: new EnrollmentService(pg),
      },
      logger: silentLogger,
    },
    logger: silentLogger,
  });
}

describe('readiness / worker-status (A5)', () => {
  it('fresh heartbeat: /ready and /worker-status are 200', async () => {
    await resetDb(pgx.pool);
    await query(pgx.pool, "INSERT INTO worker_heartbeat (worker_id, last_beat, hostname) VALUES ('w1', now(), 'h')");
    const app = buildApp(pgx.pool);
    const ready = await request(app).get('/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.status).toBe('ready');
    expect(ready.body.database).toBe(true);
    expect(ready.body.migration).toBe(true);
    expect(typeof ready.body.heartbeatAgeMs).toBe('number');
    const ws = await request(app).get('/worker-status');
    expect(ws.status).toBe(200);
    expect(ws.body.status).toBe('live');
  });

  it('stale heartbeat: /worker-status is 503', async () => {
    await resetDb(pgx.pool);
    await query(
      pgx.pool,
      "INSERT INTO worker_heartbeat (worker_id, last_beat, hostname) VALUES ('w1', now() - interval '10 minutes', 'h')",
    );
    const app = buildApp(pgx.pool);
    const ws = await request(app).get('/worker-status');
    expect(ws.status).toBe(503);
    expect(ws.body.status).toBe('stale');
    expect(ws.body.heartbeatAgeMs).toBeGreaterThan(60_000);
  });

  it('no heartbeat: /worker-status is 503', async () => {
    await resetDb(pgx.pool);
    const app = buildApp(pgx.pool);
    const ws = await request(app).get('/worker-status');
    expect(ws.status).toBe(503);
    expect(ws.body.status).toBe('stale');
    expect(ws.body.heartbeatAgeMs).toBeNull();
  });

  it('database down: /ready is 503', async () => {
    await resetDb(pgx.pool);
    const bad = createPool(
      {
        connectionString: 'postgres://postgres:postgres@127.0.0.1:5432/nonexistent_db_xyz',
        max: 1,
        ssl: false,
        statementTimeoutMs: 2000,
        idleTimeoutMs: 2000,
      },
      silentLogger,
    );
    const app = buildApp(bad);
    const ready = await request(app).get('/ready');
    expect(ready.status).toBe(503);
    expect(ready.body.status).toBe('not_ready');
    expect(ready.body.database).toBe(false);
    await bad.end();
  });
});
