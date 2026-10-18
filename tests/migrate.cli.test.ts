import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { pgFileContext } from './pg.helpers';

const pgx = pgFileContext('migrate-cli');

describe('standalone migration command', () => {
  it('runs against an isolated direct PostgreSQL connection without printing the URL', () => {
    const connectionString = `postgres://postgres:postgres@127.0.0.1:${pgx.port}/${pgx.dbName}`;
    const tsx = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const result = spawnSync(
      process.execPath,
      [tsx, path.join(process.cwd(), 'src', 'scripts', 'migrate.ts')],
      {
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          ...process.env,
          DATABASE_URL: connectionString,
          MIGRATION_DATABASE_URL: connectionString,
          DATABASE_SSL: 'off',
          NODE_ENV: 'test',
        },
      },
    );

    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain(connectionString);
    expect(`${result.stdout}${result.stderr}`).toContain('db.migration_job.completed');
  });
});
