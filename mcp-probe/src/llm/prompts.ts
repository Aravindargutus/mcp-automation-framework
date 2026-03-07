/**
 * LLM Prompt Templates — pure functions that build ChatMessage arrays
 * for the AI evaluation suite's eight test types:
 *
 * Per-tool isolation:
 *   arg-generation, response-validation, description-quality, discoverability
 *
 * Agentic (tool composition):
 *   tool-selection, workflow-chaining, scenario-execution, agentic-loop
 *
 * Each prompt enforces structured JSON output via the system message.
 */
import type { DiscoveredTool, DiscoveredResource } from '../client/mcp-client.js';
import type { AgentStep, WorkflowTrace, ScenarioSpec } from '../suite/ai-evaluation/agentic-types.js';
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

// ═══════════════════════════════════════════════════════════════════
// AGENTIC EVALUATION PROMPTS
// ═══════════════════════════════════════════════════════════════════

// ─── Tool Selection ─────────────────────────────────────────────────

/**
 * Prompt to generate N routing scenarios with expected tool answers.
 */
export function buildToolSelectionScenarioPrompt(
  tools: DiscoveredTool[],
  scenarioCount = 5,
): ChatMessage[] {
  const catalog = tools.map((t) => ({
    name: t.name,
    description: (t.description ?? 'No description').slice(0, 150),
    params: Object.keys((t.inputSchema?.properties as Record<string, unknown>) ?? {}),
  }));

  return [
    {
      role: 'system',
      content: `You are an MCP tool routing expert. Given a catalog of available tools, generate ${scenarioCount} realistic user tasks. For each task, identify which tool(s) from the catalog should be used.

RULES:
- Each task should be a natural-language request a real user would make
- Tasks should vary in complexity: some need 1 tool, some need 2+
- The correct tool(s) must be deterministic from the description — no ambiguity
- Use ONLY tool names that exist in the catalog
- Spread tasks across different tools (don't test the same tool 5 times)

Respond with ONLY valid JSON:
{
  "scenarios": [
    {
      "task": "Natural language user request",
      "expectedTools": ["tool_name_1"],
      "reasoning": "Why these tools are correct"
    }
  ]
}`,
    },
    {
      role: 'user',
      content: `Tool catalog (${tools.length} tools):\n${truncateForPrompt(catalog, 6000)}`,
    },
  ];
}

/**
 * Prompt to select tool(s) for a given task. The expected answer is NOT shown.
 */
export function buildToolSelectionTestPrompt(
  tools: DiscoveredTool[],
  task: string,
): ChatMessage[] {
  const catalog = tools.map((t) => ({
    name: t.name,
    description: (t.description ?? 'No description').slice(0, 150),
  }));

  return [
    {
      role: 'system',
      content: `You are an AI IDE routing layer (like Cursor or Claude Code). Given a user task and a catalog of available MCP tools, select which tool(s) should be called to accomplish the task.

RULES:
- Select ONLY tools from the provided catalog
- Select the MINIMUM set of tools needed — do not over-select
- If no tool fits the task, return an empty array
- Explain your reasoning briefly

Respond with ONLY valid JSON:
{
  "selectedTools": ["tool_name_1", "tool_name_2"],
  "reasoning": "Why these tools were selected",
  "confidence": <number 1-10>
}`,
    },
    {
      role: 'user',
      content: `User task: "${task}"

Available tools:\n${truncateForPrompt(catalog, 4000)}`,
    },
  ];
}

// ─── Workflow Chaining ──────────────────────────────────────────────

/**
 * Prompt to plan a multi-step workflow with output→input data flow.
 */
export function buildWorkflowPlanPrompt(tools: DiscoveredTool[]): ChatMessage[] {
  const catalog = tools.map((t) => ({
    name: t.name,
    description: (t.description ?? 'No description').slice(0, 200),
    inputSchema: t.inputSchema,
  }));

  return [
    {
      role: 'system',
      content: `You are an MCP workflow planner. Design a multi-step workflow that chains multiple tools together in a meaningful sequence.

RULES:
- Use 2-4 steps maximum
- Each step calls ONE tool from the catalog
- Generate realistic arguments for EVERY step directly
- IMPORTANT: MCP tools often return plain text, NOT structured JSON. Do NOT assume you can extract fields from a prior step's response.
- Instead of extracting from responses, share common arguments (like city, id, name) by passing them directly in each step's args.
- Use outputMapping ONLY when you are CERTAIN the prior tool returns structured JSON with that exact field name. When in doubt, pass the argument directly in args instead.
  - Format: "$.steps[N].response.FIELD_NAME" where N is a 0-based step index
- Use ONLY tool names that exist in the catalog
- The workflow should represent a realistic use case (e.g. get weather → get forecast → get alerts for the same location)

Respond with ONLY valid JSON:
{
  "description": "What this workflow accomplishes",
  "steps": [
    {
      "toolName": "first_tool",
      "args": { "city": "Miami" },
      "outputMapping": null
    },
    {
      "toolName": "second_tool",
      "args": { "city": "Miami", "extra_param": "value" },
      "outputMapping": null
    }
  ],
  "reasoning": "Why these tools chain together"
}`,
    },
    {
      role: 'user',
      content: `Available tools (${tools.length}):\n${truncateForPrompt(catalog, 8000)}`,
    },
  ];
}

/**
 * Prompt to validate a completed workflow execution trace.
 */
export function buildWorkflowValidationPrompt(
  _tools: DiscoveredTool[],
  trace: WorkflowTrace,
): ChatMessage[] {
  return [
    {
      role: 'system',
      content: `You are evaluating a multi-step MCP workflow execution. Analyze whether the workflow succeeded and whether data flowed correctly between steps.

EVALUATE:
- Did each step execute successfully (isError=false)?
- Did data from earlier steps correctly feed into later steps?
- Were any steps skipped? If so, why?
- Did the workflow accomplish its intended goal?

Respond with ONLY valid JSON:
{
  "verdict": "success" | "partial" | "failure",
  "stepsCompleted": <number>,
  "dataFlowIntact": <boolean>,
  "reasoning": "Brief analysis",
  "issues": ["list of specific problems"]
}`,
    },
    {
      role: 'user',
      content: `Workflow: "${trace.description}"

Execution trace:\n${truncateForPrompt(trace.steps, 6000)}`,
    },
  ];
}

// ─── Scenario Execution ─────────────────────────────────────────────

/**
 * Prompt to generate a realistic end-to-end scenario.
 */
export function buildScenarioGenerationPrompt(tools: DiscoveredTool[]): ChatMessage[] {
  const catalog = tools.map((t) => ({
    name: t.name,
    description: (t.description ?? 'No description').slice(0, 150),
  }));

  return [
    {
      role: 'system',
      content: `You are generating a realistic test scenario for an MCP server. Create a scenario that a real user might encounter when using an AI IDE like Cursor or Claude Code with these tools.

RULES:
- The scenario should require using 2-3 tools to complete
- Define clear, verifiable success criteria
- The scenario should be achievable with the available tools
- Keep it practical — not contrived

Respond with ONLY valid JSON:
{
  "scenario": "A user wants to...",
  "successCriteria": ["Criterion 1 was met", "Criterion 2 was met"],
  "expectedToolSequence": ["tool_a", "tool_b"],
  "difficulty": "easy" | "medium" | "hard"
}`,
    },
    {
      role: 'user',
      content: `Available tools:\n${truncateForPrompt(catalog, 4000)}`,
    },
  ];
}

/**
 * Prompt for one step in the agent loop — decide next action.
 */
export function buildAgentStepPrompt(
  tools: DiscoveredTool[],
  scenario: string,
  history: AgentStep[],
): ChatMessage[] {
  const catalog = tools.map((t) => ({
    name: t.name,
    description: (t.description ?? 'No description').slice(0, 120),
    params: Object.keys((t.inputSchema?.properties as Record<string, unknown>) ?? {}),
  }));

  const historyStr =
    history.length === 0
      ? 'No actions taken yet.'
      : history
          .map((s) => {
            const obs = s.observation
              ? `\n  Result: ${s.observation.isError ? 'ERROR' : 'OK'} (${s.observation.durationMs}ms)\n  Response: ${truncateForPrompt(s.observation.response, 500)}`
              : '\n  (not yet executed)';
            return `Step ${s.action.step}: ${s.action.action} ${s.action.toolName ?? s.action.uri ?? ''}\n  Args: ${truncateForPrompt(s.action.args, 300)}${obs}`;
          })
          .join('\n\n');

  return [
    {
      role: 'system',
      content: `You are an AI agent using MCP tools to accomplish a task. Based on the scenario, available tools, and what you've done so far, decide your next action.

RULES:
- Use information from previous step results to inform your next action
- Generate realistic arguments based on tool schemas
- If you've accomplished the scenario goals, choose "done"
- If a previous step failed, try a different approach
- Use ONLY tool names from the catalog

Respond with ONLY valid JSON:
{
  "action": "call_tool" | "done",
  "toolName": "name_of_tool (if call_tool)",
  "args": { ... (if call_tool) },
  "reasoning": "Why this action"
}`,
    },
    {
      role: 'user',
      content: `SCENARIO: ${scenario}

AVAILABLE TOOLS:\n${truncateForPrompt(catalog, 3000)}

HISTORY:\n${historyStr}

What is your next action?`,
    },
  ];
}

/**
 * Prompt to evaluate scenario success criteria.
 */
export function buildScenarioEvaluationPrompt(
  scenario: ScenarioSpec,
  history: AgentStep[],
): ChatMessage[] {
  const traceStr = history
    .map((s) => {
      const obs = s.observation
        ? `Result: ${s.observation.isError ? 'ERROR' : 'OK'}\nResponse: ${truncateForPrompt(s.observation.response, 800)}`
        : '(not executed)';
      return `Step ${s.action.step}: ${s.action.action} ${s.action.toolName ?? ''}\nArgs: ${truncateForPrompt(s.action.args, 300)}\n${obs}`;
    })
    .join('\n---\n');

  return [
    {
      role: 'system',
      content: `You are evaluating whether an AI agent successfully completed a scenario. Check each success criterion against the execution history.

RULES:
- A criterion is "met" only if there is clear evidence in the execution history
- Be strict: partial completion or error responses do not count
- Provide specific evidence for each judgment

Respond with ONLY valid JSON:
{
  "criteriaResults": [
    { "criterion": "...", "met": true/false, "evidence": "..." }
  ],
  "completionPercentage": <number 0-100>,
  "reasoning": "Overall assessment"
}`,
    },
    {
      role: 'user',
      content: `SCENARIO: ${scenario.scenario}

SUCCESS CRITERIA:
${scenario.successCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}

EXECUTION HISTORY:
${traceStr}`,
    },
  ];
}

// ─── Agentic Loop ───────────────────────────────────────────────────

/**
 * System prompt establishing the LLM as an autonomous MCP agent.
 */
export function buildAgenticLoopSystemPrompt(
  tools: DiscoveredTool[],
  resources: DiscoveredResource[],
): ChatMessage[] {
  const toolCatalog = tools.map((t) => ({
    name: t.name,
    description: (t.description ?? 'No description').slice(0, 150),
    params: Object.keys((t.inputSchema?.properties as Record<string, unknown>) ?? {}),
  }));

  const resourceList = resources.map((r) => ({
    uri: r.uri,
    name: r.name,
    description: (r.description ?? '').slice(0, 100),
  }));

  return [
    {
      role: 'system',
      content: `You are an autonomous MCP agent exploring an MCP server's capabilities. You can call tools and read resources to understand what this server offers.

AVAILABLE TOOLS:\n${truncateForPrompt(toolCatalog, 4000)}
${resources.length > 0 ? `\nAVAILABLE RESOURCES:\n${truncateForPrompt(resourceList, 2000)}` : ''}

RULES:
- Use different tools to explore — don't call the same tool repeatedly
- Generate realistic arguments for each tool call
- If a tool call fails, try a different tool or different arguments
- When you've explored enough (used 2+ different tools), choose "finish"
- Report what you learned about the server

Respond with ONLY valid JSON for each step:
{
  "action": "call_tool" | "read_resource" | "finish",
  "toolName": "name (for call_tool)",
  "args": { ... (for call_tool) },
  "uri": "resource://uri (for read_resource)",
  "reasoning": "Why this action"
}

When finishing:
{
  "action": "finish",
  "summary": "What I learned about this server",
  "findings": ["Finding 1", "Finding 2", ...]
}`,
    },
  ];
}

/**
 * Step prompt for the agentic loop — provides task + accumulated history.
 */
export function buildAgenticLoopStepPrompt(
  task: string,
  history: AgentStep[],
): ChatMessage[] {
  let historyStr: string;
  if (history.length === 0) {
    historyStr = 'No actions taken yet. Start exploring!';
  } else {
    historyStr = history
      .map((s) => {
        const obs = s.observation
          ? `→ ${s.observation.isError ? 'ERROR' : 'OK'} (${s.observation.durationMs}ms): ${truncateForPrompt(s.observation.response, 600)}`
          : '→ (pending)';
        return `[Step ${s.action.step}] ${s.action.action} ${s.action.toolName ?? s.action.uri ?? ''}\n  ${s.action.reasoning}\n  ${obs}`;
      })
      .join('\n\n');
  }

  return [
    {
      role: 'user',
      content: `TASK: ${task}

HISTORY:
${historyStr}

What is your next action?`,
    },
  ];
}

// --- Helpers ---

function truncateForPrompt(obj: unknown, maxChars: number): string {
  const str = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
  if (str.length <= maxChars) return str;
  return str.slice(0, maxChars) + '\n... (truncated)';
}
