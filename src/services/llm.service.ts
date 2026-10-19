import { silentLogger, type Logger } from '../logger';
import { recordLlmCall, recordLlmTokens } from './metrics.service';
import type { LlmClient } from './courseTutor';

export interface LLMServiceConfig {
  model: string;
  baseUrl: string;
  timeoutMs: number;
  maxTokens: number;
  temperature: number;
}

export interface LLMServiceDeps {
  config: Partial<LLMServiceConfig>;
  logger?: Logger;
}

const DEFAULT_CONFIG: LLMServiceConfig = {
  model: 'qwen2.5:1.5b-instruct-q4_k_m',
  baseUrl: 'http://localhost:11434',
  timeoutMs: 10_000,
  maxTokens: 250,
  temperature: 0.2,
};

/**
 * Thin Ollama chat client. It knows nothing about courses: scope is enforced by CourseTutor.
 * Any error or timeout returns null so callers fall back instead of failing a learner message.
 */
export class LLMService implements LlmClient {
  private readonly config: LLMServiceConfig;
  private readonly logger: Logger;

  constructor(deps: LLMServiceDeps) {
    this.config = { ...DEFAULT_CONFIG, ...deps.config };
    this.logger = deps.logger ?? silentLogger;
  }

  async complete(system: string, user: string): Promise<string | null> {
    try {
      const response = await fetch(`${this.config.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          stream: false,
          options: { num_predict: this.config.maxTokens, temperature: this.config.temperature },
        }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
      if (!response.ok) {
        recordLlmCall(this.config.model, 'http_error');
        recordLlmTokens(this.config.model, 'input', Math.ceil((system.length + user.length) / 4));
        this.logger.warn('llm.request_failed', { status: response.status, model: this.config.model });
        return null;
      }
      const data = (await response.json()) as { message?: { content?: string } };
      const content = data.message?.content?.trim() || null;
      recordLlmCall(this.config.model, content ? 'success' : 'empty');
      if (content) recordLlmTokens(this.config.model, 'output', Math.ceil(content.length / 4));
      return content;
    } catch (err) {
      const timedOut = err instanceof DOMException && err.name === 'TimeoutError';
      recordLlmCall(this.config.model, timedOut ? 'timeout' : 'error');
      this.logger.warn(timedOut ? 'llm.timeout' : 'llm.error', {
        model: this.config.model,
        ...(timedOut ? { timeoutMs: this.config.timeoutMs } : { error: String(err) }),
      });
      return null;
    }
  }
}
