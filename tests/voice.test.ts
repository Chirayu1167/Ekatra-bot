import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DisabledVoiceService, OpenAIVoiceService } from '../src/services/voice.service';
import { isVoiceNote } from '../src/types/whatsapp';
import type { VoiceNote } from '../src/types/whatsapp';

const writeFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:fs/promises', () => ({ writeFile: writeFileMock }));

const voiceNote: VoiceNote = {
  mediaUrl: 'https://api.twilio.com/2010-04-01/Accounts/ACxxx/Media/MExxx',
  contentType: 'audio/ogg',
};

describe('DisabledVoiceService', () => {
  it('transcribe returns null', async () => {
    const svc = new DisabledVoiceService();
    const result = await svc.stt.transcribe(voiceNote, { accountSid: 'ACx', authToken: 'tok' });
    expect(result).toBeNull();
  });

  it('synthesize returns null', async () => {
    const svc = new DisabledVoiceService();
    const result = await svc.tts.synthesize('hello');
    expect(result).toBeNull();
  });
});

describe('OpenAIVoiceService STT', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('transcribes audio via OpenAI API', async () => {
    // First call: download media (arrayBuffer), second: transcribe (json)
    fetchMock.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(100),
    } as Response);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: 'Hello, this is a test' }),
    } as Response);

    const svc = new OpenAIVoiceService({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      publicBaseUrl: 'https://example.com',
    });

    const result = await svc.transcribe(
      voiceNote,
      { accountSid: 'ACx', authToken: 'tok' },
    );
    expect(result).toBe('Hello, this is a test');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns null when STT fails', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));

    const svc = new OpenAIVoiceService({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      publicBaseUrl: 'https://example.com',
    });

    const result = await svc.transcribe(
      voiceNote,
      { accountSid: 'ACx', authToken: 'tok' },
    );
    expect(result).toBeNull();
  });

  it('returns null on non-ok response', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
    } as Response);

    const svc = new OpenAIVoiceService({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      publicBaseUrl: 'https://example.com',
    });

    const result = await svc.transcribe(
      voiceNote,
      { accountSid: 'ACx', authToken: 'tok' },
    );
    expect(result).toBeNull();
  });
});

describe('OpenAIVoiceService TTS', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    writeFileMock.mockResolvedValue(undefined);
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    writeFileMock.mockReset();
  });

  it('synthesizes text to audio URL', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(100),
    } as Response);
    writeFileMock.mockResolvedValue(undefined);

    const svc = new OpenAIVoiceService({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      mediaDir: './media',
      publicBaseUrl: 'https://example.com',
    });

    const result = await svc.synthesize('hello world');
    expect(result).toMatch(/^https:\/\/example\.com\/media\/voice-[a-f0-9]{16}\.mp3$/);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/audio/speech',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-test',
          'Content-Type': 'application/json',
        }),
      }),
    );
  });

  it('returns null when no publicBaseUrl', async () => {
    const svc = new OpenAIVoiceService({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      mediaDir: './media',
    });

    const result = await svc.synthesize('hello');
    expect(result).toBeNull();
  });

  it('returns null when TTS fails', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));

    const svc = new OpenAIVoiceService({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      mediaDir: './media',
      publicBaseUrl: 'https://example.com',
    });

    const result = await svc.synthesize('hello');
    expect(result).toBeNull();
  });
});

describe('isVoiceNote', () => {

  it('identifies audio media as voice note', () => {
    const msg = {
      messageSid: 'SMxxx',
      from: 'whatsapp:+14155238886',
      to: 'whatsapp:+14155238886',
      body: '',
      numMedia: 1,
      mediaUrl: 'https://api.twilio.com/...',
      mediaContentType: 'audio/ogg',
    };
    expect(isVoiceNote(msg)).toBe(true);
  });

  it('rejects text messages', () => {
    const msg = {
      messageSid: 'SMxxx',
      from: 'whatsapp:+14155238886',
      to: 'whatsapp:+14155238886',
      body: 'hello',
      numMedia: 0,
    };
    expect(isVoiceNote(msg)).toBe(false);
  });

  it('rejects non-audio media', () => {
    const msg = {
      messageSid: 'SMxxx',
      from: 'whatsapp:+1415523886',
      to: 'whatsapp:+1415523886',
      body: '',
      numMedia: 1,
      mediaUrl: 'https://api.twilio.com/...',
      mediaContentType: 'image/jpeg',
    };
    expect(isVoiceNote(msg)).toBe(false);
  });
});
