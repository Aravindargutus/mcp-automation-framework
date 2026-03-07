/**
 * AI Evaluation — Autonomous Agentic Loop test.
 *
 * The most realistic simulation: an LLM autonomously explores the MCP
 * server by deciding which tools to call, observing results, and adapting.
 * Tests tool usage breadth, error recovery, and autonomous reasoning —
 * like a mini Cursor or Claude Code agent session.
 *
 * Only generated when there are 2+ tools.
 */
import type { DiscoveredServer } from '../../client/mcp-client.js';
import type { LLMClient } from '../../llm/client.js';
import {
  buildAgenticLoopSystemPrompt,
  buildAgenticLoopStepPrompt,
} from '../../llm/prompts.js';
import { AssertHelper, type TestCase, type TestCaseResult, type TestRunContext } from '../types.js';
import type { AgentStep } from './agentic-types.js';

const MIN_TOOLS = 2;
const MAX_ITERATIONS = 5;
const TASK =
  'Explore this MCP server by calling multiple different tools to understand its capabilities. ' +
  'Use at least 2 different tools, observe the results, and report your findings.';

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

export function generateAgenticLoopTests(
  discovered: DiscoveredServer,
  llmClient: LLMClient,
): TestCase[] {
  if (discovered.tools.length < MIN_TOOLS) return [];

  const validToolNames = new Set(discovered.tools.map((t) => t.name));

  return [
    {
      id: 'ai-evaluation.agentic.agent-loop',
      name: 'AI: Autonomous agent exploration loop',
      description:
        'LLM autonomously explores the MCP server using multiple tools, adapting based on results',
      tags: ['ai-evaluation', 'agentic', 'agent-loop'],

      async run(ctx: TestRunContext): Promise<TestCaseResult> {
        const assert = new AssertHelper();
        let metadata: Record<string, unknown> = {};

        // Build the system prompt with tool/resource catalog
        const systemMessages = buildAgenticLoopSystemPrompt(
          discovered.tools,
          discovered.resources ?? [],
        );

        const history: AgentStep[] = [];
        const toolsUsed = new Set<string>();
        let errorsEncountered = 0;
        let recoveryAttempted = false;
        let loopTerminatedNormally = false;
        let agentSummary = '';
        let findings: string[] = [];

        // Agent loop
        for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
          try {
            const stepMessages = buildAgenticLoopStepPrompt(TASK, history);
            const allMessages = [...systemMessages, ...stepMessages];

            const stepResult = await llmClient.chat(allMessages, {
              jsonMode: true,
              temperature: 0.2,
            });

            const parsed = stepResult.parsed;
            if (!parsed?.action) {
              assert.info(`loop-${iteration + 1}`, 'LLM returned invalid action, stopping');
              break;
            }

            const action = parsed.action as string;

            // Handle "finish"
            if (action === 'finish') {
              agentSummary = (parsed.summary as string) ?? '';
              findings = (parsed.findings as string[]) ?? [];
              loopTerminatedNormally = true;

              history.push({
                action: {
                  step: iteration + 1,
                  action: 'finish',
                  reasoning: agentSummary,
                },
              });

              assert.info('agent-finished',
                `Agent finished after ${iteration + 1} iteration(s): "${agentSummary.slice(0, 100)}"`);
              break;
            }

            // Handle "call_tool"
            if (action === 'call_tool') {
              const toolName = parsed.toolName as string;
              const args = (parsed.args as Record<string, unknown>) ?? {};
              const reasoning = (parsed.reasoning as string) ?? '';

              if (!validToolNames.has(toolName)) {
                history.push({
                  action: { step: iteration + 1, action: 'call_tool', toolName, args, reasoning },
                  observation: {
                    step: iteration + 1,
                    response: `Tool "${toolName}" not found`,
                    isError: true,
                    durationMs: 0,
                  },
                });
                errorsEncountered++;
                continue;
              }

              try {
                const trace = await ctx.client.callTool(toolName, args);
                toolsUsed.add(toolName);

                history.push({
                  action: { step: iteration + 1, action: 'call_tool', toolName, args, reasoning },
                  observation: {
                    step: iteration + 1,
                    response: trace.response,
                    isError: trace.isError,
                    durationMs: trace.durationMs,
                  },
                });

                if (trace.isError) {
                  errorsEncountered++;
                  assert.info(`loop-${iteration + 1}`,
                    `Called ${toolName} → ERROR (${trace.durationMs}ms)`);
                } else {
                  assert.info(`loop-${iteration + 1}`,
                    `Called ${toolName} → OK (${trace.durationMs}ms)`);
                }

                // Check if agent recovered after a prior error
                if (errorsEncountered > 0 && !trace.isError && toolsUsed.size > 1) {
                  recoveryAttempted = true;
                }
              } catch (err) {
                errorsEncountered++;
                history.push({
                  action: { step: iteration + 1, action: 'call_tool', toolName, args, reasoning },
                  observation: {
                    step: iteration + 1,
                    response: (err as Error).message,
                    isError: true,
                    durationMs: 0,
                  },
                });
              }
              continue;
            }

            // Handle "read_resource"
            if (action === 'read_resource') {
              const uri = parsed.uri as string;
              const reasoning = (parsed.reasoning as string) ?? '';

              try {
                const result = await ctx.client.readResource(uri);
                history.push({
                  action: { step: iteration + 1, action: 'read_resource', uri, reasoning },
                  observation: {
                    step: iteration + 1,
                    response: result.message,
                    isError: !!result.error,
                    durationMs: result.durationMs,
                  },
                });

                assert.info(`loop-${iteration + 1}`,
                  `Read resource ${uri} → ${result.error ? 'ERROR' : 'OK'} (${result.durationMs}ms)`);
              } catch (err) {
                errorsEncountered++;
                history.push({
                  action: { step: iteration + 1, action: 'read_resource', uri, reasoning },
                  observation: {
                    step: iteration + 1,
                    response: (err as Error).message,
                    isError: true,
                    durationMs: 0,
                  },
                });
              }
              continue;
            }

            // Unknown action
            assert.info(`loop-${iteration + 1}`, `Unknown action: ${action}`);
            break;
          } catch (err) {
            assert.info(`loop-${iteration + 1}`,
              `LLM call failed: ${(err as Error).message}`);
            break;
          }
        }

        // Deterministic scoring (no additional LLM call)
        assert.ok(
          toolsUsed.size >= 2,
          'Agent used 2+ different tools',
          toolsUsed.size >= 2
            ? `Used ${toolsUsed.size} tools: ${[...toolsUsed].join(', ')}`
            : `Only used ${toolsUsed.size} tool(s): ${[...toolsUsed].join(', ')}`,
        );

        assert.ok(
          loopTerminatedNormally,
          'Agent terminated gracefully',
          loopTerminatedNormally
            ? 'Agent chose to finish on its own'
            : 'Agent hit max iterations without finishing',
        );

        if (errorsEncountered > 0) {
          assert.warn(false, 'Tool errors encountered',
            `${errorsEncountered} error(s) during exploration`);

          if (recoveryAttempted) {
            assert.info('error-recovery', 'Agent recovered from error and continued exploring');
          }
        }

        if (findings.length > 0) {
          assert.info('agent-findings', findings.join('; '));
        }

        metadata = {
          input: { task: TASK, availableTools: [...validToolNames] },
          expected: { description: 'Agent explores server using 2+ different tools' },
          actual: {
            iterations: history.length,
            uniqueToolsCalled: toolsUsed.size,
            toolsUsed: [...toolsUsed],
            errorsEncountered,
            recoveryAttempted,
            loopTerminatedNormally,
            agentSummary,
            findings,
            trace: history.map((s) => ({
              action: s.action.action,
              tool: s.action.toolName ?? s.action.uri,
              reasoning: s.action.reasoning?.slice(0, 150),
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
