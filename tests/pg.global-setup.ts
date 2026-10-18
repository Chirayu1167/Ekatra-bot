import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

/**
 * Suite-wide PostgreSQL: a single embedded cluster shared by every test file (each file
 * still gets an isolated DATABASE). Skipped entirely when EKATRA_TEST_DATABASE_URL points
 * at an external server (CI service container). Workers inherit EKATRA_PG_* env vars.
 */

let pg: EmbeddedPostgres | undefined;
let dir = '';

export function portFile(): string {
  return path.join(os.tmpdir(), 'ekatra-pg-port');
}

function freePort(from: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (port: number, attempts: number) => {
      if (attempts <= 0) {
        reject(new Error('no free port for the test database'));
        return;
      }
      const server = net.createServer();
      server.once('error', () => {
        server.close();
        tryPort(port + 1, attempts - 1);
      });
      server.once('listening', () => {
        const address = server.address();
        const chosen = typeof address === 'object' && address ? address.port : port;
        server.close(() => resolve(chosen));
      });
      server.listen(port, '127.0.0.1');
    };
    tryPort(from, 20);
  });
}

export async function setup(): Promise<() => Promise<void>> {
  if (process.env['EKATRA_TEST_DATABASE_URL']) return async () => {};
  const port = await freePort(55432);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ekatra-pg-suite-'));
  pg = new EmbeddedPostgres({
    databaseDir: path.join(dir, 'data'),
    port,
    user: 'postgres',
    password: 'postgres',
    persistent: false,
    // Course content carries emoji: force UTF8 regardless of OS locale.
    initdbFlags: ['-E', 'UTF8', '--locale=C'],
    // Test-only durability relaxations (throwaway databases): commits avoid fsync,
    // which is disproportionately slow on Windows and dominates small transactions.
    postgresFlags: ['-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off'],
    onLog: () => {},
    onError: () => {},
  });
  await pg.initialise();
  await pg.start();
  process.env['EKATRA_PG_PORT'] = String(port);
  process.env['EKATRA_PG_HOST'] = '127.0.0.1';
  // Belt and braces next to the env vars (single suite run per machine): workers read the
  // env first and fall back to this file.
  fs.writeFileSync(portFile(), String(port), 'utf-8');
  return async () => {
    try {
      fs.rmSync(portFile(), { force: true });
    } catch {
      // Ignore.
    }
    try {
      await pg?.stop();
    } catch {
      // Best effort on teardown.
    }
    pg = undefined;
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows may hold files briefly; the OS temp cleaner reaps them.
      }
    }
  };
}
