import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError } from '../errors';
import { serializeError, type Logger } from '../logger';

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: { code: 'not_found', message: 'Not found' } });
};

/**
 * Centralized error handler. Clients only ever see a code and a safe message —
 * never stack traces, Twilio error details or configuration.
 */
export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }

    let status = 500;
    let code = 'internal_error';
    let message = 'Internal server error';

    if (err instanceof AppError) {
      status = err.status;
      code = err.code;
      message = err.publicMessage;
    } else if (
      typeof err === 'object' &&
      err !== null &&
      typeof (err as { status?: unknown }).status === 'number' &&
      (err as { status: number }).status >= 400 &&
      (err as { status: number }).status < 500
    ) {
      // e.g. body-parser failures (malformed or oversized payloads)
      status = (err as { status: number }).status;
      code = 'bad_request';
      message = 'Malformed request';
    }

    const log = status >= 500 ? logger.error : logger.warn;
    log('request.failed', {
      method: req.method,
      path: req.path,
      status,
      code,
      error: serializeError(err instanceof AppError && err.cause ? err.cause : err),
    });

    res.status(status).json({ error: { code, message } });
  };
}
