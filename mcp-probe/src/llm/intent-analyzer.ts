/**
 * LLM Intent Analyzer — implements the LLMIntentAnalyzer interface from piv-loop.ts.
 *
 * Three capabilities:
 *   1. planArgs()     — PRIMARY: generate full args from tool description + schema + context
 *   2. suggestArgs()  — LEGACY: fill missing required fields only (kept for interface compat)
 *   3. diagnoseError() — analyze a failure and suggest a fix
 */
import { LLMClient } from './client.js';
import type { LLMJudgeConfig } from '../config/schema.js';
import type { LLMIntentAnalyzer } from '../agentic/piv-loop.js';
import type { ChatMessage } from './types.js';

const PLAN_ARGS_SYSTEM_PROMPT = `You are an API testing agent generating the REQUEST BODY for MCP tool calls.
Your goal is to produce a realistic "body" argument object that will make this API call succeed.

CRITICAL RULES:
1. ONLY generate the "body" field. Do NOT generate path_variables, query_params, or headers —
   those are URL routing parameters handled by the workflow engine. Your output will be IGNORED
   for path_variables, query_params, and headers.
2. For body arrays (data, tags, modules, users, territories, fields, layouts, etc.):
   always include at least one item with ALL required fields filled.
3. For body objects with NO "required" array or no "properties": infer the needed structure
   from the tool name and description. E.g., "Create Users" needs body.users[{...}],
   "Create Territories" needs body.territories[{...}].
4. Use "MCPProbeTest" prefix for name/label/title fields to make test data recognizable.
5. For email fields: use "mcpprobe_test@example.com"
6. For enum fields: pick the first valid value.
7. For date-time fields: use "2025-01-15T10:00:00+00:00"
8. For ID fields in body: use the provided real IDs from availableOutputs when possible.
   Match by resource type (e.g., profile_id → fetched_profile_id, tag_id → fetched_tag_id).
   If no matching ID is available, use "test-id-placeholder".
9. For COQL/SQL query fields: generate a valid query like "SELECT id, Full_Name FROM {entity} LIMIT 5"
10. For module/entity fields in body: use the provided entity name.
11. NEVER override fields already set in existingArgs — those come from inputMappings and are authoritative.
12. For search word/criteria fields: use "MCPProbeTest" as the search term.
13. Respect maxLength constraints on string fields (e.g., tag names ≤ 25 chars).
14. For phone fields: use "+1-555-0100"
15. SAMPLE DATA REFERENCE: If availableOutputs contains "__sampleData__", it is a REAL record
    fetched from this API's list/read endpoint. This is your PRIMARY reference for field formats:
    - Study the exact format, casing, and character patterns of each field value
    - Generate test values that MATCH the same format but with slightly different content
    - For name/label/title fields: use a similar pattern, e.g., if sample has "My Portal",
      use "MCPProbeTest Portal" (preserve casing style and allowed characters)
    - For enum-like string fields with specific values: use the EXACT same value from the sample
      (it may be the only valid value the API accepts)
    - For numeric fields: use a value similar in range to the sample
    - For fields with specific patterns (URLs, codes, formats): match the exact pattern
    - NEVER copy ID fields from the sample — those reference existing records
    - This is CRITICAL for APIs with undocumented validation patterns not exposed in the schema

Respond ONLY with JSON: { "plannedArgs": { "body": {...} }, "confidence": 0.0-1.0, "reasoning": "brief explanation" }`;

export class LLMIntentAnalyzerImpl implements LLMIntentAnalyzer {
  private client: LLMClient;

  constructor(config: LLMJudgeConfig) {
    this.client = new LLMClient(config);
  }

  async planArgs(
    toolName: string,
    toolDescription: string,
    schema: Record<string, unknown>,
    operation: string,
    entity: string,
    stepDescription: string,
    availableOutputs: Record<string, unknown>,
    existingArgs: Record<string, unknown>,
  ): Promise<{ plannedArgs: Record<string, unknown>; confidence: number; reasoning: string }> {
    const outputContext = Object.keys(availableOutputs).length > 0
      ? `\n\nAvailable IDs from previous workflow steps (use these for ID fields):\n${JSON.stringify(availableOutputs, null, 2)}`
      : '\n\nNo IDs available from previous steps yet.';

    const existingContext = Object.keys(existingArgs).length > 0
      ? `\n\nAlready-resolved args (from inputMappings — DO NOT override these):\n${JSON.stringify(existingArgs, null, 2)}`
      : '';

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: PLAN_ARGS_SYSTEM_PROMPT,
      },
      {
        role: 'user',
        content: `Tool: ${toolName}\nTool Description: ${toolDescription || 'No description provided'}\nOperation: ${operation}\nEntity/Module: ${entity}\nStep Context: ${stepDescription}\nSchema:\n${JSON.stringify(schema, null, 2)}${outputContext}${existingContext}`,
      },
    ];

    const result = await this.client.chatJSON<{
      plannedArgs: Record<string, unknown>;
      confidence: number;
      reasoning: string;
    }>(messages, { maxTokens: 2048, temperature: 0.1 });

    const data = result.data;

    // Validate plannedArgs is an object
    if (!data.plannedArgs || typeof data.plannedArgs !== 'object' || Array.isArray(data.plannedArgs)) {
      return { plannedArgs: {}, confidence: 0, reasoning: 'LLM returned invalid plannedArgs' };
    }

    return data;
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
- PATTERN_NOT_MATCHED / FIELDS_VALIDATION_ERROR: If availableOutputs contains "__sampleData__",
  study the real record's field formats and generate values matching those exact patterns.
  The sample data shows what the API actually accepts.

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

    const data = result.data;

    // Validate suggestedFix is actually an object — LLM might return a string or other type
    if (data.suggestedFix !== undefined && data.suggestedFix !== null) {
      if (typeof data.suggestedFix !== 'object' || Array.isArray(data.suggestedFix)) {
        data.suggestedFix = undefined; // Discard invalid fix
      }
    }

    return data;
  }
}
