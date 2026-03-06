/**
 * LLM Prompt Templates — pure functions that build ChatMessage arrays
 * for the AI evaluation suite's four test types.
 *
 * Each prompt enforces structured JSON output via the system message.
 */
import type { DiscoveredTool } from '../client/mcp-client.js';
import type { ChatMessage } from './types.js';

/**
 * Prompt for generating realistic tool arguments from schema.
 */
export function buildArgGenerationPrompt(tool: DiscoveredTool): ChatMessage[] {
  return [
    {
      role: 'system',
      content: `You are an API testing expert. Generate realistic, semantically meaningful arguments for an MCP tool call.

RULES:
- Generate arguments that a real user would actually provide
- Use realistic placeholder values (real-looking names, plausible IDs like "4567890123456", proper email formats, etc.)
- Respect ALL constraints in the schema: required fields, types, enums, min/max, patterns
- For nested objects, generate complete valid structures — never leave required sub-fields empty
- For IDs, use plausible numeric or string IDs (not empty strings, not "test-value")
- For arrays that need items, include 1-2 realistic entries
- If a field has an enum, pick the most common/default value

Respond with ONLY valid JSON:
{
  "arguments": { ... },
  "reasoning": "Brief explanation of value choices"
}`,
    },
    {
      role: 'user',
      content: `Tool: ${tool.name}
Description: ${tool.description ?? 'No description provided'}
Input Schema:
${JSON.stringify(tool.inputSchema, null, 2)}`,
    },
  ];
}

/**
 * Prompt for semantic validation of a tool's response.
 */
export function buildResponseValidationPrompt(
  tool: DiscoveredTool,
  args: unknown,
  response: unknown,
  isError: boolean,
): ChatMessage[] {
  return [
    {
      role: 'system',
      content: `You are an MCP tool response validator. Analyze whether a tool response indicates genuine functional success or contains a hidden failure.

COMMON FALSE-POSITIVE PATTERNS TO DETECT:
- Response body contains error messages but isError flag is false
- Response says "mandatory field missing" or similar validation errors
- Response returns empty/null data when meaningful data was expected
- Response returns a generic template or placeholder instead of real data
- Response describes a permission or authentication failure
- Response returns HTTP error details wrapped in a success envelope

IMPORTANT: A response that says something like "field X is required" or "not found" is a FAILURE even if isError=false.

Respond with ONLY valid JSON:
{
  "verdict": "success" | "failure" | "inconclusive",
  "confidence": <number 1-10>,
  "reasoning": "Brief explanation of your judgment",
  "hiddenErrors": ["list of error messages found in the response body"],
  "dataQuality": "meaningful" | "empty" | "template" | "error_message"
}`,
    },
    {
      role: 'user',
      content: `Tool: ${tool.name}
Description: ${tool.description ?? 'No description'}
Arguments sent:
${JSON.stringify(args, null, 2)}
isError flag: ${isError}
Response body:
${truncateForPrompt(response, 4000)}`,
    },
  ];
}

/**
 * Prompt for evaluating tool description quality for AI agent usability.
 */
export function buildDescriptionQualityPrompt(tool: DiscoveredTool): ChatMessage[] {
  return [
    {
      role: 'system',
      content: `You are evaluating an MCP tool's description for AI agent usability. Rate how well an AI agent could understand when and how to use this tool based solely on its name, description, and schema.

SCORING CRITERIA:
- 9-10: Crystal clear purpose, complete parameter docs with examples, constraints noted
- 7-8: Good description, most params documented, clear when to use it
- 5-6: Vague description, missing param docs, ambiguous purpose
- 3-4: Minimal or misleading description, AI would likely misuse the tool
- 1-2: No description, cryptic name, impossible to use correctly

EVALUATE:
- Is the tool name descriptive?
- Does the description explain WHAT the tool does and WHEN to use it?
- Are parameter descriptions present and helpful?
- Are constraints and valid values documented?
- Would an AI agent know what arguments to provide?

Respond with ONLY valid JSON:
{
  "score": <number 1-10>,
  "reasoning": "Brief explanation of the score",
  "issues": ["list of specific problems found"],
  "suggestions": ["list of concrete improvement suggestions"]
}`,
    },
    {
      role: 'user',
      content: `Tool name: ${tool.name}
Description: ${tool.description ?? 'NONE'}
Input Schema:
${JSON.stringify(tool.inputSchema, null, 2)}`,
    },
  ];
}

/**
 * Prompt for analyzing tool set discoverability and naming quality.
 */
export function buildDiscoverabilityPrompt(tools: DiscoveredTool[]): ChatMessage[] {
  const toolSummaries = tools.map((t) => ({
    name: t.name,
    description: (t.description ?? 'No description').slice(0, 120),
    paramCount: Object.keys((t.inputSchema?.properties as Record<string, unknown>) ?? {}).length,
  }));

  return [
    {
      role: 'system',
      content: `You are analyzing a set of MCP tools for discoverability and usability by AI agents. Identify naming, overlap, and confusion issues.

EVALUATE:
- Are tool names clear and distinguishable from each other?
- Are there tools with overlapping or confusing purposes?
- Is the naming convention consistent (e.g., verb_noun pattern)?
- Are there obvious functional gaps (e.g., "create" exists but no "delete")?
- Would an AI agent struggle to pick the right tool for a task?

Respond with ONLY valid JSON:
{
  "overallScore": <number 1-10>,
  "confusingPairs": [{"tools": ["name1", "name2"], "reason": "why they are confusing"}],
  "namingIssues": [{"tool": "name", "issue": "description of the problem"}],
  "missingTools": ["description of obvious gaps"],
  "recommendations": ["actionable improvement suggestions"]
}`,
    },
    {
      role: 'user',
      content: `Tool set (${tools.length} tools):
${truncateForPrompt(toolSummaries, 6000)}`,
    },
  ];
}

// --- Helpers ---

function truncateForPrompt(obj: unknown, maxChars: number): string {
  const str = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
  if (str.length <= maxChars) return str;
  return str.slice(0, maxChars) + '\n... (truncated)';
}
