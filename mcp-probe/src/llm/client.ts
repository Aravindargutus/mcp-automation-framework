/**
 * LLM Client — dual-provider (Anthropic native + OpenAI-compatible).
 *
 * Auto-detects provider from baseUrl:
 *   - Contains "anthropic.com" → uses @anthropic-ai/sdk
 *   - Otherwise → uses OpenAI-compatible chat/completions endpoint via fetch
 *
 * Zero config beyond what LLMJudgeConfig already provides.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { LLMJudgeConfig } from '../config/schema.js';
import type { ChatMessage, ChatOptions, LLMCallResult } from './types.js';

const MAX_RETRIES = 3;
const CALL_TIMEOUT_MS = 60_000;

export class LLMClient {
  private baseUrl: string;
  private apiKey: string;
  readonly model: string;
  private maxTokens: number;
  private isAnthropic: boolean;
  private anthropicClient: Anthropic | null = null;
  private _totalTokensUsed = 0;

  constructor(config: LLMJudgeConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.apiKey =
      typeof config.apiKey === 'string'
        ? config.apiKey
        : process.env[config.apiKey.env] ?? '';
    this.model = config.model;
    this.maxTokens = config.maxTokens;
    this.isAnthropic = this.baseUrl.includes('anthropic.com');

    if (this.isAnthropic) {
      this.anthropicClient = new Anthropic({ apiKey: this.apiKey });
    }
  }

  get tokensUsed(): number {
    return this._totalTokensUsed;
  }

  /**
   * Send a chat completion request and return the result.
   */
  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<LLMCallResult> {
    const maxTokens = options?.maxTokens ?? this.maxTokens;
    const temperature = options?.temperature ?? 0.2;

    if (this.isAnthropic && this.anthropicClient) {
      return this.chatAnthropic(messages, maxTokens, temperature);
    }
    return this.chatOpenAI(messages, maxTokens, temperature, options?.jsonMode);
  }

  /**
   * Send a chat request expecting a JSON response. Parses automatically.
   */
  async chatJSON<T = Record<string, unknown>>(
    messages: ChatMessage[],
    options?: Omit<ChatOptions, 'jsonMode'>,
  ): Promise<{ data: T; tokenUsage: LLMCallResult['tokenUsage']; durationMs: number }> {
    const result = await this.chat(messages, { ...options, jsonMode: true });

    if (!result.parsed) {
      throw new Error(`LLM returned non-JSON response: ${result.content.slice(0, 200)}`);
    }

    return {
      data: result.parsed as T,
      tokenUsage: result.tokenUsage,
      durationMs: result.durationMs,
    };
  }

  // --- Anthropic provider ---

  private async chatAnthropic(
    messages: ChatMessage[],
    maxTokens: number,
    temperature: number,
  ): Promise<LLMCallResult> {
    const client = this.anthropicClient!;
    const start = Date.now();

    // Anthropic API: system message is separate from messages array
    const systemMessages = messages.filter((m) => m.role === 'system');
    const nonSystemMessages = messages.filter((m) => m.role !== 'system');

    const systemPrompt = systemMessages.map((m) => m.content).join('\n\n') || undefined;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await Promise.race([
          client.messages.create({
            model: this.model,
            max_tokens: maxTokens,
            temperature,
            system: systemPrompt,
            messages: nonSystemMessages.map((m) => ({
              role: m.role as 'user' | 'assistant',
              content: m.content,
            })),
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`LLM call timed out after ${CALL_TIMEOUT_MS}ms`)), CALL_TIMEOUT_MS),
          ),
        ]);

        const content =
          response.content[0]?.type === 'text' ? response.content[0].text : '';

        const tokenUsage = {
          prompt: response.usage.input_tokens,
          completion: response.usage.output_tokens,
          total: response.usage.input_tokens + response.usage.output_tokens,
        };
        this._totalTokensUsed += tokenUsage.total;

        return {
          content,
          parsed: tryParseJSON(content),
          tokenUsage,
          durationMs: Date.now() - start,
          model: response.model,
        };
      } catch (err) {
        lastError = err as Error;
        if (isRateLimitError(err)) {
          const waitMs = extractRetryAfter(err) ?? 1000 * Math.pow(2, attempt);
          await sleep(Math.min(waitMs, 30_000));
          continue;
        }
        if (isRetryableError(err) && attempt < MAX_RETRIES - 1) {
          await sleep(1000 * Math.pow(2, attempt));
          continue;
        }
        throw err;
      }
    }

    throw lastError ?? new Error('LLM call failed after retries');
  }

  // --- OpenAI-compatible provider ---

  private async chatOpenAI(
    messages: ChatMessage[],
    maxTokens: number,
    temperature: number,
    jsonMode?: boolean,
  ): Promise<LLMCallResult> {
    const start = Date.now();
    const url = `${this.baseUrl}/chat/completions`;

    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      max_tokens: maxTokens,
      temperature,
    };

    if (jsonMode) {
      body.response_format = { type: 'json_object' };
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!response.ok) {
          const errorBody = await response.text().catch(() => '');
          if (response.status === 429) {
            const waitMs = parseRetryAfterHeader(response) ?? 1000 * Math.pow(2, attempt);
            await sleep(Math.min(waitMs, 30_000));
            continue;
          }
          if (response.status >= 500 && attempt < MAX_RETRIES - 1) {
            await sleep(1000 * Math.pow(2, attempt));
            continue;
          }
          throw new Error(`LLM API error ${response.status}: ${errorBody.slice(0, 300)}`);
        }

        const data = (await response.json()) as {
          choices: Array<{ message: { content: string } }>;
          usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
          model?: string;
        };

        const content = data.choices?.[0]?.message?.content ?? '';

        const tokenUsage = {
          prompt: data.usage?.prompt_tokens ?? 0,
          completion: data.usage?.completion_tokens ?? 0,
          total: data.usage?.total_tokens ?? 0,
        };
        this._totalTokensUsed += tokenUsage.total;

        return {
          content,
          parsed: tryParseJSON(content),
          tokenUsage,
          durationMs: Date.now() - start,
          model: data.model ?? this.model,
        };
      } catch (err) {
        lastError = err as Error;
        if ((err as Error).name === 'AbortError') {
          throw new Error(`LLM call timed out after ${CALL_TIMEOUT_MS}ms`);
        }
        if (attempt < MAX_RETRIES - 1 && isRetryableError(err)) {
          await sleep(1000 * Math.pow(2, attempt));
          continue;
        }
        throw err;
      }
    }

    throw lastError ?? new Error('LLM call failed after retries');
  }
}

// --- Helpers ---

function tryParseJSON(text: string): Record<string, unknown> | null {
  try {
    // Try to extract JSON from markdown code blocks if present
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const toParse = jsonMatch ? jsonMatch[1].trim() : text.trim();
    const parsed = JSON.parse(toParse);
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

function isRateLimitError(err: unknown): boolean {
  if (err instanceof Anthropic.RateLimitError) return true;
  const msg = (err as Error)?.message ?? '';
  return msg.includes('429') || msg.toLowerCase().includes('rate limit');
}

function isRetryableError(err: unknown): boolean {
  if (err instanceof Anthropic.InternalServerError) return true;
  if (err instanceof Anthropic.APIConnectionError) return true;
  const msg = (err as Error)?.message ?? '';
  return msg.includes('5') && /\b5\d{2}\b/.test(msg);
}

function extractRetryAfter(err: unknown): number | null {
  // Anthropic SDK attaches headers in certain error types
  const headers = (err as { headers?: Record<string, string> })?.headers;
  if (headers?.['retry-after']) {
    const secs = parseFloat(headers['retry-after']);
    if (!isNaN(secs)) return secs * 1000;
  }
  return null;
}

function parseRetryAfterHeader(response: Response): number | null {
  const header = response.headers.get('retry-after');
  if (!header) return null;
  const secs = parseFloat(header);
  return isNaN(secs) ? null : secs * 1000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
