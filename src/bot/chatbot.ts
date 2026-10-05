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

export interface ChatbotReply {
  text: string;
}

export interface MessageHandler {
  handleMessage(input: ChatbotInput): Promise<ChatbotReply>;
}

export const MENU = 'Reply with:\n1 - Start learning\n2 - Help';

export const REPLIES = {
  greeting: `Hello! 👋 Welcome to Ekatra.\n\nI'm your learning assistant.\n\n${MENU}`,
  startLearning: "Great! Let's get started. 📚\n\nYour first lesson will appear here soon.",
  help: 'Here are your options:\n\n1 - Start learning\n2 - Help\n\nYou can reply with the number of an option.',
  fallback: `I didn't quite understand that.\n\n${MENU}`,
} as const;

const GREETINGS = new Set(['hello', 'hi', 'hey', 'start']);

/** Lowercase, trim, and drop trailing punctuation so "Hello!" matches "hello". */
function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\s!.?,]+$/u, '');
}

export class Chatbot implements MessageHandler {
  async handleMessage(input: ChatbotInput): Promise<ChatbotReply> {
    const text = normalize(input.text);

    if (GREETINGS.has(text)) return { text: REPLIES.greeting };
    if (text === '1') return { text: REPLIES.startLearning };
    if (text === '2' || text === 'help') return { text: REPLIES.help };
    return { text: REPLIES.fallback };
  }
}
