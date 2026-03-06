/**
 * LLM Client types — shared interfaces for the dual-provider LLM client.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  /** Request JSON-formatted output */
  jsonMode?: boolean;
  /** Override default max tokens */
  maxTokens?: number;
  /** Sampling temperature (0 = deterministic, 1 = creative) */
  temperature?: number;
}

export interface LLMCallResult {
  /** Raw text content from the LLM */
  content: string;
  /** JSON-parsed content (null if parsing failed) */
  parsed: Record<string, unknown> | null;
  /** Token usage breakdown */
  tokenUsage: { prompt: number; completion: number; total: number };
  /** Wall-clock duration of the call in ms */
  durationMs: number;
  /** Model that was actually used */
  model: string;
}
