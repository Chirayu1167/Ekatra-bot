export type CommandName = 'courses' | 'start' | 'next' | 'pause' | 'resume' | 'progress' | 'start_course' | 'quiz_answer' | 'certificate';

export interface ParsedCommand {
  name: CommandName;
  /** Text after the command word (only `start` takes one). */
  arg: string;
}

/**
 * Recognise a course command. Case, surrounding whitespace and trailing punctuation are
 * ignored ("Next!" works). Returns null for anything else, which includes a bare `start` (the
 * original greeting) and commands with stray extra words, so the caller can fall back to the
 * existing chatbot instead of guessing.
 */
export function parseCommand(text: string): ParsedCommand | null {
  const cleaned = text.trim().replace(/[\s!.?,]+$/u, '');
  if (cleaned === '1') return { name: 'courses', arg: '' }; // "1 - Start learning" in the menu

  const lowered = cleaned.toLowerCase();
  if (lowered === 'start course' || lowered === 'begin' || lowered === 'begin course') {
    return { name: 'start_course', arg: '' };
  }

  const upper = cleaned.toUpperCase();
  // Quiz answers: A, B, C, D
  if (['A', 'B', 'C', 'D'].includes(upper)) {
    return { name: 'quiz_answer', arg: upper };
  }

  const [first = '', ...rest] = cleaned.split(/\s+/u);
  const arg = rest.join(' ').trim();

  switch (first.toLowerCase()) {
    case 'courses':
    case 'course':
      return arg ? null : { name: 'courses', arg: '' };
    case 'start':
      return arg ? { name: 'start', arg } : null;
    case 'start_course':
      return { name: 'start_course', arg: '' };
    case 'certificate':
      return arg ? null : { name: 'certificate', arg: '' };
    case 'next':
    case 'pause':
    case 'resume':
    case 'progress': {
      const name = first.toLowerCase() as 'next' | 'pause' | 'resume' | 'progress';
      return arg ? null : { name, arg: '' };
    }
    default:
      return null;
  }
}

const STOP_WORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit']);
const OPT_IN_WORDS = new Set(['start', 'unstop', 'subscribe', 'resubscribe']);

export type Keyword = { kind: 'stop' } | { kind: 'optin'; word: string };

/**
 * Opt-out / opt-in keywords. Only a message that is *exactly* the keyword counts (case and
 * trailing punctuation ignored), so "please stop the lesson" is not an opt-out.
 */
export function parseKeyword(text: string): Keyword | null {
  const word = text
    .trim()
    .replace(/[\s!.?,]+$/u, '')
    .toLowerCase();
  if (STOP_WORDS.has(word)) return { kind: 'stop' };
  if (OPT_IN_WORDS.has(word)) return { kind: 'optin', word };
  return null;
}
