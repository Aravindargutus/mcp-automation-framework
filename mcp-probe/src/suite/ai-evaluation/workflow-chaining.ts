/**
 * AI Evaluation — Workflow Chaining test.
 *
 * Tests whether tools can be chained together in a multi-step workflow
 * where output from Tool A feeds as input to Tool B. Simulates the
 * data-flow pattern used by AI IDEs when orchestrating MCP tools.
 *
 * Only generated when there are 2+ tools.
 */
import type { DiscoveredServer } from '../../client/mcp-client.js';
import type { LLMClient } from '../../llm/client.js';
import { buildWorkflowPlanPrompt, buildWorkflowValidationPrompt } from '../../llm/prompts.js';
import { AssertHelper, type TestCase, type TestCaseResult, type TestRunContext } from '../types.js';
import type { WorkflowStep, WorkflowTrace, WorkflowTraceEntry } from './agentic-types.js';

const MIN_TOOLS = 2;
const MAX_STEPS = 4;

/**
 * Resolve output mappings by substituting $.steps[N].response.field references
 * with actual values from previous step results.
 */
function resolveOutputMappings(
  baseArgs: Record<string, unknown>,
  outputMapping: Record<string, string> | undefined | null,
  previousSteps: WorkflowTraceEntry[],
): { resolved: Record<string, unknown>; unresolved: string[] } {
  const resolved = { ...baseArgs };
  const unresolved: string[] = [];

  if (!outputMapping) return { resolved, unresolved };

  for (const [paramName, path] of Object.entries(outputMapping)) {
    const match = path.match(/^\$\.steps\[(\d+)\]\.response\.(.+)$/);
    if (!match) {
      unresolved.push(paramName);
      continue;
    }

    const stepIndex = parseInt(match[1], 10);
    const fieldPath = match[2];

    if (stepIndex >= previousSteps.length || previousSteps[stepIndex].skipped) {
      unresolved.push(paramName);
      continue;
    }

    const rawResponse = previousSteps[stepIndex].response;
    // Unwrap MCP content format to get the actual data
    const stepResponse = unwrapMCPResponse(rawResponse);
    const value = getNestedField(stepResponse, fieldPath);
    if (value === undefined) {
      unresolved.push(paramName);
      continue;
    }

    resolved[paramName] = value;
  }

  return { resolved, unresolved };
}

/** Safely traverse a nested object by dot-separated path. */
function getNestedField(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Unwrap MCP tool response to extract usable data.
 *
 * MCP tools/call returns `{ content: [{ type: "text", text: "..." }, ...] }`.
 * The text content is often JSON-encoded. This function extracts and parses
 * the first text content block so that output mappings like
 * `$.steps[0].response.city` can resolve against the actual data.
 */
function unwrapMCPResponse(response: unknown): unknown {
  if (!response || typeof response !== 'object') return response;

  const resp = response as Record<string, unknown>;
  const content = resp.content;
  if (!Array.isArray(content)) return response;

  // Find first text content block
  const textBlock = content.find(
    (c: unknown) => c && typeof c === 'object' && (c as Record<string, unknown>).type === 'text',
  ) as Record<string, unknown> | undefined;

  if (!textBlock?.text || typeof textBlock.text !== 'string') return response;

  // Try to parse as JSON; fall back to raw string
  try {
    return JSON.parse(textBlock.text as string);
  } catch {
    return textBlock.text;
  }
}

function truncateResponse(obj: unknown, maxLen = 2048): unknown {
  try {
    const str = JSON.stringify(obj);
    if (str && str.length > maxLen) {
      return { _truncated: true, _length: str.length, _preview: str.slice(0, maxLen) + '...' };
    }
    return obj;
  } catch {
    return { _error: 'Could not serialize response' };
  }
}

export function generateWorkflowChainingTests(
  discovered: DiscoveredServer,
  llmClient: LLMClient,
): TestCase[] {
  if (discovered.tools.length < MIN_TOOLS) return [];

  const validToolNames = new Set(discovered.tools.map((t) => t.name));

  return [
    {
      id: 'ai-evaluation.agentic.workflow-chaining',
      name: 'AI: Multi-step workflow chaining',
      description:
        'LLM plans a workflow where tools pass data to each other, then executes and validates data flow',
      tags: ['ai-evaluation', 'agentic', 'workflow'],

      async run(ctx: TestRunContext): Promise<TestCaseResult> {
        const assert = new AssertHelper();
        let metadata: Record<string, unknown> = {};

        // Step 1: Plan the workflow
        let workflowDescription = '';
        let plannedSteps: WorkflowStep[] = [];
        try {
          const planResult = await llmClient.chat(
            buildWorkflowPlanPrompt(discovered.tools),
            { jsonMode: true, temperature: 0.3 },
          );

          const parsed = planResult.parsed;
          if (!parsed?.steps || !Array.isArray(parsed.steps)) {
            assert.ok(false, 'Workflow planning', 'LLM response missing "steps" array');
            return { assertions: assert.assertions, metadata };
          }

          workflowDescription = (parsed.description as string) ?? 'Unnamed workflow';
          plannedSteps = (parsed.steps as WorkflowStep[])
            .filter((s) => validToolNames.has(s.toolName))
            .slice(0, MAX_STEPS);

          if (plannedSteps.length < 2) {
            assert.ok(false, 'Workflow has 2+ valid steps',
              `Only ${plannedSteps.length} valid step(s) planned`);
            return { assertions: assert.assertions, metadata };
          }

          assert.ok(true, 'Workflow planning',
            `Planned ${plannedSteps.length}-step workflow: "${workflowDescription}"`);
        } catch (err) {
          assert.ok(false, 'Workflow planning',
            `LLM call failed: ${(err as Error).message}`);
          return { assertions: assert.assertions, metadata };
        }

        // Step 2: Execute sequentially
        const executedSteps: WorkflowTraceEntry[] = [];

        for (let i = 0; i < plannedSteps.length; i++) {
          const step = plannedSteps[i];

          // Resolve output mappings from prior steps
          const { resolved, unresolved } = resolveOutputMappings(
            step.args ?? {},
            step.outputMapping,
            executedSteps,
          );

          if (unresolved.length > 0) {
            executedSteps.push({
              planned: step,
              resolvedArgs: resolved,
              response: null,
              isError: false,
              durationMs: 0,
              skipped: true,
              skipReason: `Unresolved mappings: ${unresolved.join(', ')}`,
            });
            assert.warn(false, `Step ${i + 1}: ${step.toolName} (skipped)`,
              `Could not resolve: ${unresolved.join(', ')}`);
            continue;
          }

          try {
            const trace = await ctx.client.callTool(step.toolName, resolved);
            executedSteps.push({
              planned: step,
              resolvedArgs: resolved,
              response: trace.response,
              isError: trace.isError,
              durationMs: trace.durationMs,
              skipped: false,
            });

            if (trace.isError) {
              assert.warn(false, `Step ${i + 1}: ${step.toolName}`,
                `Tool returned error (${trace.durationMs}ms)`);
            } else {
              assert.info(`step-${i + 1}-ok`,
                `Step ${i + 1}: ${step.toolName} completed in ${trace.durationMs}ms`);
            }
          } catch (err) {
            executedSteps.push({
              planned: step,
              resolvedArgs: resolved,
              response: (err as Error).message,
              isError: true,
              durationMs: 0,
              skipped: false,
            });
            assert.warn(false, `Step ${i + 1}: ${step.toolName}`,
              `Transport error: ${(err as Error).message}`);
          }
        }

        // Step 3: LLM validates the workflow
        const trace: WorkflowTrace = { description: workflowDescription, steps: executedSteps };

        try {
          const valResult = await llmClient.chat(
            buildWorkflowValidationPrompt(discovered.tools, trace),
            { jsonMode: true, temperature: 0.1 },
          );

          const parsed = valResult.parsed;
          if (parsed) {
            const verdict = (parsed.verdict as string) ?? 'failure';
            const dataFlowIntact = (parsed.dataFlowIntact as boolean) ?? false;
            const stepsCompleted = (parsed.stepsCompleted as number) ?? 0;
            const issues = (parsed.issues as string[]) ?? [];

            assert.ok(verdict !== 'failure', 'Workflow execution verdict',
              verdict === 'success'
                ? `PASS: Workflow succeeded (${stepsCompleted}/${plannedSteps.length} steps)`
                : verdict === 'partial'
                  ? `Partial success: ${stepsCompleted}/${plannedSteps.length} steps completed`
                  : `Workflow failed: ${parsed.reasoning ?? 'no reason given'}`);

            assert.ok(dataFlowIntact, 'Data flow between steps',
              dataFlowIntact
                ? 'Data correctly passed between workflow steps'
                : 'Data flow was broken between steps');

            for (const issue of issues) {
              assert.warn(false, 'Workflow issue', issue);
            }
          }
        } catch (err) {
          assert.info('validation-skipped',
            `Workflow validation skipped: ${(err as Error).message}`);
        }

        metadata = {
          input: { workflow: workflowDescription, stepCount: plannedSteps.length },
          expected: { description: 'Workflow completes with intact data flow' },
          actual: {
            stepsExecuted: executedSteps.filter((s) => !s.skipped).length,
            stepsSkipped: executedSteps.filter((s) => s.skipped).length,
            stepsErrored: executedSteps.filter((s) => s.isError).length,
            trace: executedSteps.map((s) => ({
              tool: s.planned.toolName,
              skipped: s.skipped,
              isError: s.isError,
              durationMs: s.durationMs,
              response: truncateResponse(s.response, 500),
            })),
          },
          llm: { model: llmClient.model, tokensUsed: llmClient.tokensUsed },
        };

        return { assertions: assert.assertions, metadata };
      },
    },
  ];
}
