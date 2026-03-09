/**
 * LLM Intent Analyzer — implements the LLMIntentAnalyzer interface from piv-loop.ts.
 *
 * Two capabilities:
 *   1. suggestArgs() — generate args for a tool when schema-aware filling has gaps
 *   2. diagnoseError() — analyze a failure and suggest a fix
 *
 * Both are called only when deterministic methods are insufficient.
 */
import { LLMClient } from './client.js';
import type { LLMJudgeConfig } from '../config/schema.js';
import type { LLMIntentAnalyzer } from '../agentic/piv-loop.js';
import type { ChatMessage } from './types.js';

export class LLMIntentAnalyzerImpl implements LLMIntentAnalyzer {
  private client: LLMClient;

  constructor(config: LLMJudgeConfig) {
    this.client = new LLMClient(config);
  }

  async suggestArgs(
    toolName: string,
    description: string,
    schema: Record<string, unknown>,
    operation: string,
    entity: string,
  ): Promise<{ suggestedArgs: Record<string, unknown>; confidence: number; reasoning: string }> {
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `You are an API testing expert. Given a tool's JSON Schema, suggest argument values for testing.

CRITICAL RULES:
- ONLY fill fields listed in "required" arrays — NEVER fill optional fields
- Use realistic but recognizable test values (prefix with "MCPProbeTest" where appropriate)
- For enum fields, pick the first value
- For module/entity fields, use the provided entity name
- For ID fields that reference other records, use placeholder "test-id-placeholder"
- For date-time fields, use a recent ISO timestamp
- For email fields, use "test@mcpprobe.dev"

Respond ONLY with JSON: { "suggestedArgs": {...}, "confidence": 0.0-1.0, "reasoning": "brief explanation" }`,
      },
      {
        role: 'user',
        content: `Tool: ${toolName}\nOperation: ${operation}\nEntity: ${entity}\nDescription: ${description || 'No description'}\nSchema:\n${JSON.stringify(schema, null, 2)}`,
      },
    ];

    const result = await this.client.chatJSON<{
      suggestedArgs: Record<string, unknown>;
      confidence: number;
      reasoning: string;
    }>(messages, { maxTokens: 1024, temperature: 0.1 });

    return result.data;
  }

  async diagnoseError(
    toolName: string,
    args: Record<string, unknown>,
    errorResponse: unknown,
    schema: Record<string, unknown>,
    availableOutputs?: Record<string, unknown>,
  ): Promise<{ diagnosis: string; suggestedFix?: Record<string, unknown>; shouldRetry: boolean }> {
    // Build output context for the LLM — show available IDs from previous steps
    const outputContext = availableOutputs && Object.keys(availableOutputs).length > 0
      ? `\n\nAvailable IDs from previous workflow steps (use these to fix wrong ID values):\n${JSON.stringify(availableOutputs, null, 2)}`
      : '';

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `You are an API debugging expert. Analyze this API call failure and suggest a fix.

Rules:
- If the error is an auth/permission issue, set shouldRetry: false (cannot fix by changing args)
- If the error is a validation issue with fixable args, provide suggestedFix with corrected top-level args
- Only suggest fixing required fields — never add optional fields
- suggestedFix should be a partial object that can be merged into the original args
- IMPORTANT: If the error mentions an invalid ID, check the available IDs from previous steps.
  Match the parameter name to the most appropriate ID (e.g., tag_id → fetched_tag_id,
  record_id → createdRecordId, layout_id → fetched_layout_id)

Respond ONLY with JSON: { "diagnosis": "brief explanation", "suggestedFix": {...} or null, "shouldRetry": true/false }`,
      },
      {
        role: 'user',
        content: `Tool: ${toolName}\nArgs sent:\n${JSON.stringify(args, null, 2)}\nError response:\n${JSON.stringify(errorResponse)}\nTool schema:\n${JSON.stringify(schema, null, 2)}${outputContext}`,
      },
    ];

    const result = await this.client.chatJSON<{
      diagnosis: string;
      suggestedFix?: Record<string, unknown>;
      shouldRetry: boolean;
    }>(messages, { maxTokens: 512, temperature: 0.1 });

    return result.data;
  }
}
