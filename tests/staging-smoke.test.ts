import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { query } from '../src/db/pg';
import { runStagingSmoke } from '../scripts/staging-smoke';
import { ADMIN_KEY, buildHarness } from './helpers';
import { pgFileContext } from './pg.helpers';

const pgx = pgFileContext('staging-smoke');

describe('staging smoke script', () => {
  it('checks the local app and proves invalid-signature webhook creates no work', async () => {
    const consoleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ekatra-smoke-console-'));
    fs.writeFileSync(
      path.join(consoleDir, 'index.html'),
      '<!doctype html><html lang="en"><head><title>test console</title></head><body></body></html>',
    );
    const h = await buildHarness({
      pg: pgx.pool,
      autoDrain: false,
      validateWebhookSignature: true,
      consoleDir,
    });
    const { rows: before } = await query<{ count: string }>(
      h.db,
      'SELECT COUNT(*)::text AS count FROM inbound_events',
    );
    await query(
      h.db,
      `INSERT INTO worker_heartbeat (worker_id, last_beat, hostname)
       VALUES ('staging-smoke-test', now(), 'test')`,
    );
    const server = h.app.listen(0);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('test server did not bind TCP');
      const checks = await runStagingSmoke(`http://127.0.0.1:${address.port}`, ADMIN_KEY);

      expect(checks.filter((check) => !check.passed)).toEqual([]);
      const { rows: after } = await query<{ count: string }>(
        h.db,
        'SELECT COUNT(*)::text AS count FROM inbound_events',
      );
      expect(after[0]?.count).toBe(before[0]?.count);
      const { rows: jobs } = await query<{ count: string }>(
        h.db,
        'SELECT COUNT(*)::text AS count FROM jobs',
      );
      expect(jobs[0]?.count).toBe('0');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      fs.rmSync(consoleDir, { recursive: true, force: true });
    }
  });
});
