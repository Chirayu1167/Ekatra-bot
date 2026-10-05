import { describe, expect, it } from 'vitest';
import { ConfigError, loadEnv } from '../src/config/env';

const valid = {
  TWILIO_ACCOUNT_SID: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  TWILIO_AUTH_TOKEN: 'secret-token',
  TWILIO_WHATSAPP_FROM: 'whatsapp:+14155238886',
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
    expect.assertions(4);
    try {
      loadEnv({ TWILIO_AUTH_TOKEN: '' });
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const message = (err as Error).message;
      expect(message).toContain('TWILIO_ACCOUNT_SID is required');
      expect(message).toContain('TWILIO_AUTH_TOKEN is required');
      expect(message).toContain('TWILIO_WHATSAPP_FROM is required');
    }
  });

  it('rejects a sender without the whatsapp: prefix', () => {
    expect(() => loadEnv({ ...valid, TWILIO_WHATSAPP_FROM: '+14155238886' })).toThrow(/whatsapp:/);
  });

  it('rejects an invalid TWILIO_WEBHOOK_VALIDATE value', () => {
    expect(() => loadEnv({ ...valid, TWILIO_WEBHOOK_VALIDATE: 'yes' })).toThrow(
      /TWILIO_WEBHOOK_VALIDATE/,
    );
  });
});
