import type { RequestHandler } from 'express';
import { recordApiRequest } from '../services/metrics.service';

/** Express middleware that records request count + duration per method/route/status.
 * Mount early in the stack (after CORS/security headers, before route handlers). */
export function metricsMiddleware(): RequestHandler {
  return (req, res, next) => {
    const start = process.hrtime();
    // Route pattern is not known until after matching; use the path as a coarse
    // route label. Express 5 sets req.route.path once matched; fall back to path.
    const routeLabel = () => (req.route?.path ?? req.path).replace(/\/$/, '') || '/';
    res.on('finish', () => {
      const [sec, nano] = process.hrtime(start);
      const seconds = sec + nano / 1_000_000_000;
      try {
        recordApiRequest(req.method, routeLabel(), res.statusCode, seconds);
      } catch {
        // Metrics must never break a request.
      }
    });
    next();
  };
}
