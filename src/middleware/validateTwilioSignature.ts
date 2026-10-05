import type { RequestHandler } from 'express';
import twilio from 'twilio';
import { InvalidSignatureError } from '../errors';
import type { Logger } from '../logger';

interface Options {
  authToken: string;
  /** If set, the signed URL is `${publicBaseUrl}${req.originalUrl}` instead of being derived. */
  publicBaseUrl?: string | undefined;
  logger: Logger;
}

/**
 * Verifies the X-Twilio-Signature header using Twilio's official algorithm
 * (twilio.validateRequest). Must run AFTER the urlencoded body parser, because the
 * signature covers the full URL plus the POST parameters.
 */
export function validateTwilioSignature({
  authToken,
  publicBaseUrl,
  logger,
}: Options): RequestHandler {
  return (req, _res, next) => {
    const signature = req.get('X-Twilio-Signature');
    const url = publicBaseUrl
      ? `${publicBaseUrl}${req.originalUrl}`
      : `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    const params = (req.body ?? {}) as Record<string, string>;

    if (!signature || !twilio.validateRequest(authToken, signature, url, params)) {
      logger.warn('twilio.signature.invalid', {
        reason: signature ? 'mismatch' : 'missing_header',
        // The URL helps diagnose proxy/tunnel mismatches. It contains no secrets.
        urlUsedForValidation: url,
      });
      return next(new InvalidSignatureError());
    }
    next();
  };
}
