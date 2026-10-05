/** An error that maps to an HTTP response. `publicMessage` is safe to show to clients. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly publicMessage: string,
    options?: { cause?: unknown },
  ) {
    super(publicMessage, options);
    this.name = new.target.name;
  }
}

export class BadRequestError extends AppError {
  constructor(publicMessage = 'Malformed request') {
    super(400, 'bad_request', publicMessage);
  }
}

export class InvalidSignatureError extends AppError {
  constructor() {
    super(403, 'invalid_signature', 'Invalid Twilio signature');
  }
}

export class ChatbotError extends AppError {
  constructor(cause: unknown) {
    super(500, 'chatbot_error', 'Internal server error', { cause });
  }
}

export class TwilioSendError extends AppError {
  constructor(cause: unknown) {
    super(502, 'twilio_send_failed', 'Failed to deliver message', { cause });
  }
}
