import type { RequestHandler } from 'express';

/** Baseline hardening headers. No Content-Security-Policy: it would break the
 * registration page's inline script (a nonce is a later-phase job). */
export function securityHeaders(): RequestHandler {
  return (_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  };
}

/**
 * CORS is off by default (no headers at all). When CORS_ORIGINS is set to a comma-separated
 * allow-list, matching origins get ACAO echo + Vary. Anything else gets nothing.
 */
export function corsIfConfigured(origins?: string): RequestHandler {
  const allowed = new Set(
    (origins ?? '')
      .split(',')
      .map((o) => o.trim().replace(/\/+$/, ''))
      .filter(Boolean),
  );
  return (req, res, next) => {
    if (allowed.size === 0) {
      next();
      return;
    }
    const origin = req.get('origin');
    if (origin && allowed.has(origin.replace(/\/+$/, ''))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    next();
  };
}

export interface FailureLimiterOptions {
  maxFailures: number;
  windowMs: number;
  now?: () => number;
}

/**
 * Throttles credential probing: counts 401/403 responses per client IP in a sliding window
 * and answers 429 once the budget is spent. Legitimate callers (valid signatures/keys cause
 * no failures) are unaffected. In-memory per process — enough for a single-instance bot.
 */
export function authFailureLimiter(options: FailureLimiterOptions): RequestHandler {
  const hits = new Map<string, number[]>();
  const now = options.now ?? Date.now;
  const keyOf = (req: Parameters<RequestHandler>[0]) => req.ip ?? 'unknown';

  return (req, res, next) => {
    const t = now();
    const recent = (hits.get(keyOf(req)) ?? []).filter((x) => t - x < options.windowMs);
    if (recent.length >= options.maxFailures) {
      res.status(429).json({ error: { code: 'rate_limited', message: 'Too many attempts' } });
      return;
    }
    hits.set(keyOf(req), recent);
    res.on('finish', () => {
      if (res.statusCode === 401 || res.statusCode === 403) {
        const cur = now();
        const kept = (hits.get(keyOf(req)) ?? []).filter((x) => cur - x < options.windowMs);
        kept.push(cur);
        hits.set(keyOf(req), kept);
      }
    });
    next();
  };
}
