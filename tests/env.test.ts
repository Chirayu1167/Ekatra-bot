import { describe, expect, it } from 'vitest';
import {
  assertProductionIngress,
  ConfigError,
  loadEnv,
  shouldRunMigrationsAtStartup,
} from '../src/config/env';

const valid = {
  TWILIO_ACCOUNT_SID: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  TWILIO_AUTH_TOKEN: 'secret-token',
  TWILIO_WHATSAPP_FROM: 'whatsapp:+14155238886',
  DATABASE_URL: 'postgres://localhost:5432/ekatra',
};

describe('loadEnv', () => {
  it('applies defaults (port 3000, validation ON)', () => {
    const env = loadEnv(valid);
    expect(env.PORT).toBe(3000);
    expect(env.TWILIO_WEBHOOK_VALIDATE).toBe(true);
  });

  it('parses explicit values', () => {
    const env = loadEnv({
      ...valid,
      PORT: '8080',
      TWILIO_WEBHOOK_VALIDATE: 'false',
      PUBLIC_BASE_URL: 'https://abc.ngrok-free.app/',
    });
    expect(env.PORT).toBe(8080);
    expect(env.TWILIO_WEBHOOK_VALIDATE).toBe(false);
    expect(env.PUBLIC_BASE_URL).toBe('https://abc.ngrok-free.app');
  });

  it('fails fast naming every missing variable, without echoing secrets', () => {
    expect.assertions(5);
    try {
      loadEnv({ TWILIO_AUTH_TOKEN: '' });
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const message = (err as Error).message;
      expect(message).toContain('TWILIO_ACCOUNT_SID is required');
      expect(message).toContain('TWILIO_AUTH_TOKEN is required');
      expect(message).toContain('TWILIO_WHATSAPP_FROM is required');
      expect(message).toContain('DATABASE_URL is required');
    }
  });

  it('rejects an invalid DATABASE_SSL value', () => {
    expect(() => loadEnv({ ...valid, DATABASE_SSL: 'sometimes' })).toThrow(/DATABASE_SSL/);
  });

  it('rejects a sender without the whatsapp: prefix', () => {
    expect(() => loadEnv({ ...valid, TWILIO_WHATSAPP_FROM: '+14155238886' })).toThrow(/whatsapp:/);
  });

  it('rejects an invalid TWILIO_WEBHOOK_VALIDATE value', () => {
    expect(() => loadEnv({ ...valid, TWILIO_WEBHOOK_VALIDATE: 'yes' })).toThrow(
      /TWILIO_WEBHOOK_VALIDATE/,
    );
  });

  it('production refuses webhook signature validation being disabled', () => {
    const env = loadEnv({
      ...valid,
      NODE_ENV: 'production',
      OPTOUT_HASH_SECRET: 'x'.repeat(32),
      TWILIO_WEBHOOK_VALIDATE: 'false',
    });
    expect(() => assertProductionIngress(env)).toThrow(/TWILIO_WEBHOOK_VALIDATE/);
  });

  it('production requires the durable opt-out HMAC secret', () => {
    expect(() =>
      loadEnv({
        ...valid,
        NODE_ENV: 'production',
      }),
    ).toThrow(/OPTOUT_HASH_SECRET/);
  });

  it('rejects worker concurrency that exceeds the database pool', () => {
    expect(() =>
      loadEnv({
        ...valid,
        DATABASE_POOL_MAX: '5',
        WORKER_MAX_JOBS_PER_TICK: '2',
      }),
    ).toThrow(/WORKER_MAX_JOBS_PER_TICK/);
  });

  it('parses the explicit production migration opt-in and direct migration URL', () => {
    const env = loadEnv({
      ...valid,
      RUN_MIGRATIONS_ON_START: 'true',
      MIGRATION_DATABASE_URL: 'postgres://migration@db.example.test:5432/ekatra',
    });
    expect(env.RUN_MIGRATIONS_ON_START).toBe(true);
    expect(env.MIGRATION_DATABASE_URL).toBe('postgres://migration@db.example.test:5432/ekatra');
    expect(shouldRunMigrationsAtStartup(env)).toBe(true);
  });

  it('keeps production API/worker startup migration-free unless explicitly enabled', () => {
    const env = loadEnv({
      ...valid,
      NODE_ENV: 'production',
      OPTOUT_HASH_SECRET: 'x'.repeat(32),
    });
    expect(env.RUN_MIGRATIONS_ON_START).toBe(false);
    expect(shouldRunMigrationsAtStartup(env)).toBe(false);
    expect(shouldRunMigrationsAtStartup(loadEnv(valid))).toBe(true);
  });
});
