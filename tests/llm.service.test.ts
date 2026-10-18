import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { LLMService } from '../src/services/llm.service';

describe('LLMService', () => {
  const originalFetch = global.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch as typeof global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.resetAllMocks();
  });

  it('returns reply on successful response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ message: { content: 'Hello from LLM' } }),
    });

    const svc = new LLMService({ config: { timeoutMs: 5000 } });
    const result = await svc.complete('system prompt', 'user prompt');

    expect(result).toBe('Hello from LLM');
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:11434/api/chat',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('user prompt'),
      }),
    );
  });

  it('sends system and user messages in the request body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ message: { content: 'Hello from LLM' } }),
    });

    const svc = new LLMService({ config: { timeoutMs: 5000 } });
    await svc.complete('system prompt', 'user prompt');

    const call = mockFetch.mock.calls[0];
    if (!call) throw new Error('Expected fetch to be called');
    const body = JSON.parse(call[1].body as string);
    expect(body.messages).toEqual([
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'user prompt' },
    ]);
  });

  it('sends num_predict and temperature from config', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ message: { content: 'ok' } }),
    });

    const svc = new LLMService({
      config: {
        model: 'custom-model',
        baseUrl: 'http://custom:11434',
        timeoutMs: 3000,
        maxTokens: 100,
        temperature: 0.5,
      },
    });
    await svc.complete('system', 'user');

    const call = mockFetch.mock.calls[0];
    if (!call) throw new Error('Expected fetch to be called');
    const body = JSON.parse(call[1].body as string);
    expect(body.model).toBe('custom-model');
    expect(body.options.num_predict).toBe(100);
    expect(body.options.temperature).toBe(0.5);
  });

  it('returns null on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const svc = new LLMService({ config: { timeoutMs: 5000 } });
    const result = await svc.complete('system', 'user');

    expect(result).toBeNull();
  });

  it('returns null on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const svc = new LLMService({ config: { timeoutMs: 5000 } });
    const result = await svc.complete('system', 'user');

    expect(result).toBeNull();
  });

  it('returns null on timeout', async () => {
    mockFetch.mockImplementationOnce(() => new Promise((_, reject) => {
      setTimeout(() => reject(new DOMException('Aborted', 'AbortError')), 10);
    }));

    const svc = new LLMService({ config: { timeoutMs: 1 } });
    const result = await svc.complete('system', 'user');

    expect(result).toBeNull();
  });

  it('returns null for empty content', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ message: { content: '' } }),
    });

    const svc = new LLMService({ config: { timeoutMs: 5000 } });
    const result = await svc.complete('system', 'user');

    expect(result).toBeNull();
  });
});