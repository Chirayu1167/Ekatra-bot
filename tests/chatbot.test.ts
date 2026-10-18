import { describe, expect, it } from 'vitest';
import { Chatbot, REPLIES } from '../src/bot/chatbot';

const bot = new Chatbot();
const reply = async (text: string) => (await bot.handleMessage({ userId: 'u1', text })).text;

describe('Chatbot', () => {
  it.each(['hello', 'hi', 'hey', 'start'])('"%s" → greeting', async (text) => {
    expect(await reply(text)).toBe(REPLIES.greeting);
  });

  it('"1" → start learning', async () => {
    expect(await reply('1')).toBe(REPLIES.startLearning);
  });

  it.each(['2', 'help'])('"%s" → help', async (text) => {
    expect(await reply(text)).toBe(REPLIES.help);
  });

  it.each(['asdf', '', '3', 'what is this?'])('"%s" → fallback', async (text) => {
    expect(await reply(text)).toBe(REPLIES.fallback);
  });

  it('ignores case, surrounding whitespace and trailing punctuation', async () => {
    expect(await reply('  HeLLo!  ')).toBe(REPLIES.greeting);
    expect(await reply('Help?')).toBe(REPLIES.help);
  });

  it('returns the exact specified copy', () => {
    expect(REPLIES.greeting).toBe(
      "Hello! 👋 Welcome to Ekatra.\n\nI'm your learning assistant."
    );
    expect(REPLIES.fallback).toBe(
      "I didn't quite understand that.\n\nSend COURSES to see available courses, or START <number> to begin."
    );
  });
});

describe('Chatbot with main-menu buttons', () => {
  const SID = 'HX' + 'f'.repeat(32);
  const withButtons = new Chatbot({ mainMenuButtonSid: SID });

  it('greeting carries the button template with the same text as fallback', async () => {
    const r = await withButtons.handleMessage({ userId: 'u1', text: 'Hi' });
    expect(r).toMatchObject({ text: REPLIES.greeting, contentSid: SID, fallbackText: REPLIES.greeting });
  });

  it('fallback carries the button template with the same text as fallback', async () => {
    const r = await withButtons.handleMessage({ userId: 'u1', text: 'gibberish' });
    expect(r).toMatchObject({ text: REPLIES.fallback, contentSid: SID, fallbackText: REPLIES.fallback });
  });

  it('"1" and "2" stay plain text (handled by the button tap itself)', async () => {
    expect((await withButtons.handleMessage({ userId: 'u1', text: '1' })).contentSid).toBeUndefined();
    expect((await withButtons.handleMessage({ userId: 'u1', text: '2' })).contentSid).toBeUndefined();
  });
});
