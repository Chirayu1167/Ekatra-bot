export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

type Level = 'info' | 'warn' | 'error';

/** Minimal structured logger: one JSON object per line on stdout/stderr. */
export function createLogger(): Logger {
  const write = (level: Level, message: string, fields: Record<string, unknown> = {}) => {
    const line = JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...fields });
    (level === 'error' ? process.stderr : process.stdout).write(`${line}\n`);
  };
  return {
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
  };
}

export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * Mask a phone-number-like identifier, keeping the non-digit prefix and the last 4 digits
 * for correlation (e.g. `whatsapp:+919876543210` → `whatsapp:+***3210`).
 * Strings with fewer than 7 digits pass through unchanged.
 */
export function maskPhone(id: string): string {
  const digits = id.replace(/\D/g, '');
  if (digits.length < 7) return id;
  const firstDigit = id.search(/\d/);
  const prefix = firstDigit === -1 ? '' : id.slice(0, firstDigit);
  return `${prefix}***${digits.slice(-4)}`;
}

/** Log-safe view of an error. Stack traces go to logs only, never to HTTP responses. */
export function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const extra = err as Error & { code?: unknown; status?: unknown };
    return {
      name: err.name,
      message: err.message,
      ...(extra.code !== undefined && { code: extra.code }),
      ...(extra.status !== undefined && { status: extra.status }),
      stack: err.stack,
    };
  }
  return { message: String(err) };
}
