import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { migratePostgres } from '../src/db/migratePg';
import { createPool } from '../src/db/pg';
import { AdminAuthService } from '../src/services/adminAuth.service';
import { CourseService } from '../src/services/course.service';
import { OrganisationsService } from '../src/services/organisations.service';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const children: ChildProcess[] = [];
let postgres: EmbeddedPostgres | undefined;
let dataDir = '';
let stopping = false;

function findPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      if (port === 0) {
        server.close();
        reject(new Error('Could not allocate a local PostgreSQL port'));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function start(name: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const child = spawn(process.execPath, [tsx, ...args], {
    cwd: root,
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  child.once('error', (error) => {
    console.error(`${name} failed to start: ${error.message}`);
    void shutdown(1);
  });
  child.once('exit', (code) => {
    if (!stopping && code !== 0) {
      console.error(`${name} exited unexpectedly (${code ?? 'signal'}).`);
      void shutdown(code ?? 1);
    }
  });
  children.push(child);
  return child;
}

async function shutdown(exitCode = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill();
  }
  try {
    await postgres?.stop();
  } catch {
    // The local cluster is disposable; continue cleanup on shutdown.
  }
  if (dataDir) {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // Windows may release PostgreSQL files after process exit.
    }
  }
  process.exitCode = exitCode;
}

process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });

async function main(): Promise<void> {
  const port = await findPort();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ekatra-dev-local-'));
  postgres = new EmbeddedPostgres({
    databaseDir: path.join(dataDir, 'data'),
    port,
    user: 'postgres',
    password: 'postgres',
    persistent: false,
    initdbFlags: ['-E', 'UTF8', '--locale=C'],
    postgresFlags: ['-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off'],
    onLog: () => {},
    onError: () => {},
  });
  await postgres.initialise();
  await postgres.start();

  const databaseUrl = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
  const pool = createPool({ connectionString: databaseUrl, max: 12 }, undefined);
  let apiKey: string;
  try {
    await migratePostgres(pool);
    const orgs = new OrganisationsService(pool);
    const org = await orgs.create({ slug: 'demo', name: 'Ekatra Demo' });
    const auth = new AdminAuthService(pool);
    const admin = await auth.createUser(org.id, 'Demo Administrator', 'org_admin');
    const issued = await auth.issueKey(admin.id);
    apiKey = issued.plaintext;
    const courses = new CourseService(pool);
    await courses.createCourse(org.id, {
      title: 'Demo Course',
      description: 'Local-only sample course.',
      slug: 'demo-course',
      lessons: [{
        title: 'Welcome',
        items: [{ kind: 'text', text: 'This is a local preview. No real messages are sent.' }],
      }],
    });
  } finally {
    await pool.end();
  }

  const localSecret = randomBytes(32).toString('hex');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'development',
    DATABASE_URL: databaseUrl,
    DATABASE_SSL: 'off',
    DATABASE_POOL_MAX: '12',
    DATABASE_STATEMENT_TIMEOUT_MS: '10000',
    DATABASE_IDLE_TIMEOUT_MS: '30000',
    ADMIN_API_KEY: '',
    TWILIO_ACCOUNT_SID: 'AC00000000000000000000000000000000',
    TWILIO_AUTH_TOKEN: randomBytes(32).toString('hex'),
    TWILIO_WHATSAPP_FROM: 'whatsapp:+14155550100',
    TWILIO_WEBHOOK_VALIDATE: 'false',
    PUBLIC_BASE_URL: 'http://localhost:3000',
    OPTOUT_HASH_SECRET: localSecret,
    CERTIFICATE_SECRET: localSecret,
    EKATRA_FAKE_SENDER: 'true',
    WORKER_POLL_MS: '1000',
    SCHEDULER_ENABLED: 'false',
  };
  start('API', ['src/server.ts'], env);
  start('worker (fake sender)', ['src/worker.ts'], env);
  start(
    'admin UI',
    ['admin-ui/node_modules/vite/bin/vite.js', 'dev', path.join(root, 'admin-ui'), '--host', '127.0.0.1'],
    env,
  );

  console.log('Local services started; Ctrl+C stops the API, worker, Vite, and temporary PostgreSQL.');
  console.log('Console: http://localhost:5173/console/');
  console.log('API: http://localhost:3000/');
  console.log(`Demo administrator API key (shown once): ${apiKey}`);
}

void main().catch(async (error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Local startup failed');
  await shutdown(1);
});
