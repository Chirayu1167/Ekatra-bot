import type { ReplyMessage } from '../services/delivery';
/**
 * Chatbot logic. Deliberately knows nothing about HTTP, Express or Twilio.
 *
 * `MessageHandler` is the seam: today it is implemented by `Chatbot`; later a
 * Learning Engine (backed by PostgreSQL / Redis / workers) can implement the
 * same interface and be swapped in without touching the webhook layer.
 */

export interface ChatbotInput {
  /** Stable identifier of the user (currently their WhatsApp address). */
  userId: string;
  /** Raw message text. */
  text: string;
  /** Provider message id (Twilio MessageSid) — available for future idempotency/events. */
  messageId?: string;
}

/**
 * Serializable progress commit, executed by the worker ONLY after every message
 * was confirmed sent. Unlike `onDelivered` (an in-process closure), this
 * survives a worker crash between "accepted" and "sent": it travels in the
 * outbound job payload and every branch is idempotent (compare-and-set begin /
 * advance, INSERT .. ON CONFLICT DO NOTHING certificate), so a reclaimed job
 * finishes exactly one logical progress update — never a skip, never a double.
 */
export type DeliveryAction =
  | { type: 'none' }
  | {
    type: 'begin';
    orgId: number;
    userId: string;
    courseId: number;
    position: number;
    isFinal: boolean;
  }
  | {
    type: 'advance';
    orgId: number;
    enrollmentId: number;
    from: number;
    to: number;
    isFinal: boolean;
    issueCertificate: boolean;
  };

export interface ChatbotReply {
  text: string;
  /** Optional ONE media file for the first message (WhatsApp: one media object per message). */
  mediaUrl?: string;
  /** Send the first message with tap-buttons from this Twilio Content Template. */
  contentSid?: string;
  /** Plain text used if the button message cannot be sent. */
  fallbackText?: string;
  /** Further messages, sent in order after the first one. */
  followUps?: ReplyMessage[];
  /**
   * Called by the webhook layer only AFTER every message above was sent successfully. Use it to
   * commit state that must not advance if delivery fails (e.g. "lesson 3 delivered").
   */
  onDelivered?: () => void | Promise<void>;
  /**
   * Durable form of `onDelivered` for the worker pipeline: executed after a
   * confirmed send, survives crashes, idempotent on replay. Replies without
   * progress effects omit it (treated as `{ type: 'none' }`).
   */
  deliveryAction?: DeliveryAction;
  /**
   * Send nothing at all (acknowledge only). Used for opted-out learners: the only message ever
   * allowed to them is the STOP confirmation (`optOutConfirmation`), everything else is silence.
   */
  noSend?: boolean;
  /** Marks the STOP-confirmation reply: the one message the opt-out guard lets through. */
  optOutConfirmation?: boolean;
}

export interface MessageHandler {
  handleMessage(input: ChatbotInput): Promise<ChatbotReply>;
}

export const MENU = '';

export const REPLIES = {
  greeting: `Hello! 👋 Welcome to Ekatra.\n\nI'm your learning assistant.`,
  startLearning: "Great! Let's get started. 📚\n\nYour first lesson will appear here soon.",
  help: 'Send COURSES to browse, START <number> to begin, or NEXT for the next lesson.',
  fallback: `I didn't quite understand that.\n\nSend COURSES to see available courses, or START <number> to begin.`,
} as const;

const GREETINGS = new Set(['hello', 'hi', 'hey', 'start']);

/** Lowercase, trim, and drop trailing punctuation so "Hello!" matches "hello". */
function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\s!.?,]+$/u, '');
}

export interface ChatbotDeps {
  mainMenuButtonSid?: string;
}

export class Chatbot implements MessageHandler {
  private readonly mainMenuButtonSid: string | undefined;

  constructor(deps: ChatbotDeps = {}) {
    this.mainMenuButtonSid = deps.mainMenuButtonSid;
  }

  async handleMessage(input: ChatbotInput): Promise<ChatbotReply> {
    const text = normalize(input.text);

    if (GREETINGS.has(text)) {
      return this.withMainMenuButtons(REPLIES.greeting);
    }
    if (text === '1') return { text: REPLIES.startLearning };
    if (text === '2' || text === 'help') return { text: REPLIES.help };
    return this.withMainMenuButtons(REPLIES.fallback);
  }

  private withMainMenuButtons(text: string): ChatbotReply {
    const contentSid = this.mainMenuButtonSid;
    return contentSid ? { text, contentSid, fallbackText: text } : { text };
  }
}
