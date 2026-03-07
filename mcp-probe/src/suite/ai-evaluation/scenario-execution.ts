/**
 * AI Evaluation — Scenario-Based End-to-End test.
 *
 * The LLM generates a realistic user scenario, then acts as a mini agent
 * to solve it using available MCP tools. Tests whether the tool set can
 * handle real-world tasks end-to-end — like a compact Cursor or Claude Code session.
 *
 * Only generated when there are 2+ tools.
 */
import type { DiscoveredServer } from '../../client/mcp-client.js';
import type { LLMClient } from '../../llm/client.js';
import {
  buildScenarioGenerationPrompt,
  buildAgentStepPrompt,
  buildScenarioEvaluationPrompt,
} from '../../llm/prompts.js';
import { AssertHelper, type TestCase, type TestCaseResult, type TestRunContext } from '../types.js';
import type { AgentStep, ScenarioSpec, CriterionResult } from './agentic-types.js';

const MIN_TOOLS = 2;
const MAX_AGENT_STEPS = 3;

function truncateResponse(obj: unknown, maxLen = 1024): unknown {
  try {
    const str = JSON.stringify(obj);
    if (str && str.length > maxLen) {
      return { _truncated: true, _preview: str.slice(0, maxLen) + '...' };
    }
    return obj;
  } catch {
    return { _error: 'Could not serialize' };
  }
}

export function generateScenarioExecutionTests(
  discovered: DiscoveredServer,
  llmClient: LLMClient,
): TestCase[] {
  if (discovered.tools.length < MIN_TOOLS) return [];

  const validToolNames = new Set(discovered.tools.map((t) => t.name));

  return [
    {
      id: 'ai-evaluation.agentic.scenario-execution',
      name: 'AI: Scenario-based end-to-end execution',
      description:
        'LLM generates a scenario, then acts as an agent to solve it using multiple tools',
      tags: ['ai-evaluation', 'agentic', 'scenario'],

      async run(ctx: TestRunContext): Promise<TestCaseResult> {
        const assert = new AssertHelper();
        let metadata: Record<string, unknown> = {};

        // Step 1: Generate scenario
        let scenario: ScenarioSpec;
        try {
          const genResult = await llmClient.chat(
            buildScenarioGenerationPrompt(discovered.tools),
            { jsonMode: true, temperature: 0.3 },
          );

          const parsed = genResult.parsed;
          if (
            !parsed?.scenario ||
            !Array.isArray(parsed.successCriteria) ||
            (parsed.successCriteria as string[]).length === 0
          ) {
            assert.ok(false, 'Scenario generation',
              'LLM response missing scenario or successCriteria');
            return { assertions: assert.assertions, metadata };
          }

          scenario = {
            scenario: parsed.scenario as string,
            successCriteria: parsed.successCriteria as string[],
            expectedToolSequence: (parsed.expectedToolSequence as string[]) ?? [],
            difficulty: (parsed.difficulty as string) ?? 'medium',
          };

          assert.ok(true, 'Scenario generation',
            `Generated: "${scenario.scenario.slice(0, 80)}..." ` +
            `(${scenario.successCriteria.length} criteria, ${scenario.difficulty})`);
        } catch (err) {
          assert.ok(false, 'Scenario generation',
            `LLM call failed: ${(err as Error).message}`);
          return { assertions: assert.assertions, metadata };
        }

        // Step 2: Mini agent loop
        const history: AgentStep[] = [];

        for (let step = 0; step < MAX_AGENT_STEPS; step++) {
          try {
            const stepResult = await llmClient.chat(
              buildAgentStepPrompt(discovered.tools, scenario.scenario, history),
              { jsonMode: true, temperature: 0.2 },
            );

            const parsed = stepResult.parsed;
            if (!parsed?.action) {
              assert.info(`agent-step-${step + 1}`, 'LLM returned invalid action, stopping loop');
              break;
            }

            const action = parsed.action as string;

            if (action === 'done') {
              history.push({
                action: {
                  step: step + 1,
                  action: 'finish',
                  reasoning: (parsed.reasoning as string) ?? 'Task complete',
                },
              });
              assert.info('agent-finished', `Agent finished after ${step + 1} step(s)`);
              break;
            }

            if (action === 'call_tool') {
              const toolName = parsed.toolName as string;
              const args = (parsed.args as Record<string, unknown>) ?? {};

              if (!validToolNames.has(toolName)) {
                assert.warn(false, `Step ${step + 1}: invalid tool "${toolName}"`,
                  'Tool does not exist in catalog');
                history.push({
                  action: {
                    step: step + 1,
                    action: 'call_tool',
                    toolName,
                    args,
                    reasoning: (parsed.reasoning as string) ?? '',
                  },
                  observation: {
                    step: step + 1,
                    response: `Tool "${toolName}" not found`,
                    isError: true,
                    durationMs: 0,
                  },
                });
                continue;
              }

              // Execute the tool call
              try {
                const trace = await ctx.client.callTool(toolName, args);
                history.push({
                  action: {
                    step: step + 1,
                    action: 'call_tool',
                    toolName,
                    args,
                    reasoning: (parsed.reasoning as string) ?? '',
                  },
                  observation: {
                    step: step + 1,
                    response: trace.response,
                    isError: trace.isError,
                    durationMs: trace.durationMs,
                  },
                });

                assert.info(`agent-step-${step + 1}`,
                  `Called ${toolName} → ${trace.isError ? 'ERROR' : 'OK'} (${trace.durationMs}ms)`);
              } catch (err) {
                history.push({
                  action: {
                    step: step + 1,
                    action: 'call_tool',
                    toolName,
                    args,
                    reasoning: (parsed.reasoning as string) ?? '',
                  },
                  observation: {
                    step: step + 1,
                    response: (err as Error).message,
                    isError: true,
                    durationMs: 0,
                  },
                });
                assert.info(`agent-step-${step + 1}`,
                  `Called ${toolName} → transport error`);
              }
            }
          } catch (err) {
            assert.info(`agent-step-${step + 1}`,
              `LLM call failed: ${(err as Error).message}`);
            break;
          }
        }

        // Step 3: Evaluate success criteria
        let criteriaResults: CriterionResult[] = [];
        let completionPercentage = 0;

        try {
          const evalResult = await llmClient.chat(
            buildScenarioEvaluationPrompt(scenario, history),
            { jsonMode: true, temperature: 0.1 },
          );

          const parsed = evalResult.parsed;
          if (parsed?.criteriaResults && Array.isArray(parsed.criteriaResults)) {
            criteriaResults = parsed.criteriaResults as CriterionResult[];
            completionPercentage = (parsed.completionPercentage as number) ?? 0;

            assert.ok(
              completionPercentage >= 50,
              'Scenario completion >= 50%',
              `${completionPercentage}% of criteria met ` +
                `(${criteriaResults.filter((c) => c.met).length}/${criteriaResults.length})`,
            );

            for (const cr of criteriaResults) {
              if (!cr.met) {
                assert.warn(false, `Criterion: "${cr.criterion.slice(0, 60)}"`,
                  `Not met: ${cr.evidence}`);
              }
            }
          }
        } catch (err) {
          assert.info('evaluation-skipped',
            `Scenario evaluation skipped: ${(err as Error).message}`);
        }

        const toolsCalled = history
          .filter((s) => s.action.action === 'call_tool')
          .map((s) => s.action.toolName!);

        metadata = {
          input: { scenario },
          expected: { description: 'All success criteria met' },
          actual: {
            stepsExecuted: history.length,
            toolsCalled,
            uniqueToolsCalled: new Set(toolsCalled).size,
            criteriaResults,
            completionPercentage,
            agentTrace: history.map((s) => ({
              action: s.action.action,
              tool: s.action.toolName,
              reasoning: s.action.reasoning,
              isError: s.observation?.isError,
              durationMs: s.observation?.durationMs,
              response: truncateResponse(s.observation?.response, 300),
            })),
          },
          llm: { model: llmClient.model, tokensUsed: llmClient.tokensUsed },
        };

        return { assertions: assert.assertions, metadata };
      },
    },
  ];
}
