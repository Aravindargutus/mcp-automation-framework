/**
 * AI Evaluation — Tool Selection / Routing test.
 *
 * Simulates how an AI IDE (Cursor, Claude Code) routes user requests
 * to the correct MCP tool. Tests whether the LLM can correctly identify
 * which tool(s) to use from a catalog of available tools.
 *
 * Only generated when there are 3+ tools (routing is trivial with fewer).
 */
import type { DiscoveredServer } from '../../client/mcp-client.js';
import type { LLMClient } from '../../llm/client.js';
import {
  buildToolSelectionScenarioPrompt,
  buildToolSelectionTestPrompt,
} from '../../llm/prompts.js';
import { AssertHelper, type TestCase, type TestCaseResult, type TestRunContext } from '../types.js';

const SCENARIO_COUNT = 5;
const MIN_TOOLS = 3;

export function generateToolSelectionTests(
  discovered: DiscoveredServer,
  llmClient: LLMClient,
): TestCase[] {
  if (discovered.tools.length < MIN_TOOLS) return [];

  const validToolNames = new Set(discovered.tools.map((t) => t.name));

  return [
    {
      id: 'ai-evaluation.agentic.tool-selection',
      name: 'AI: Tool selection routing accuracy',
      description:
        'LLM generates user tasks, then a separate LLM call must route each task to the correct tool(s)',
      tags: ['ai-evaluation', 'agentic', 'tool-selection'],

      async run(_ctx: TestRunContext): Promise<TestCaseResult> {
        const assert = new AssertHelper();
        let metadata: Record<string, unknown> = {};
        const scenarioResults: Array<{
          task: string;
          expected: string[];
          selected: string[];
          precision: number;
          recall: number;
        }> = [];

        // Step 1: Generate routing scenarios
        let scenarios: Array<{ task: string; expectedTools: string[]; reasoning: string }> = [];
        try {
          const genResult = await llmClient.chat(
            buildToolSelectionScenarioPrompt(discovered.tools, SCENARIO_COUNT),
            { jsonMode: true, temperature: 0.3 },
          );

          const parsed = genResult.parsed;
          if (!parsed?.scenarios || !Array.isArray(parsed.scenarios)) {
            assert.ok(false, 'Scenario generation', 'LLM response missing "scenarios" array');
            return { assertions: assert.assertions, metadata };
          }

          scenarios = (parsed.scenarios as typeof scenarios).filter(
            (s) =>
              s.task &&
              Array.isArray(s.expectedTools) &&
              s.expectedTools.every((t: string) => validToolNames.has(t)),
          );

          if (scenarios.length === 0) {
            assert.ok(false, 'Valid scenarios generated', 'No scenarios had valid tool names');
            return { assertions: assert.assertions, metadata };
          }

          assert.ok(true, 'Scenario generation',
            `Generated ${scenarios.length} routing scenario(s)`);
        } catch (err) {
          assert.ok(false, 'Scenario generation',
            `LLM call failed: ${(err as Error).message}`);
          return { assertions: assert.assertions, metadata };
        }

        // Step 2: Test each scenario
        let totalPrecision = 0;
        let totalRecall = 0;

        for (const scenario of scenarios) {
          try {
            const testResult = await llmClient.chat(
              buildToolSelectionTestPrompt(discovered.tools, scenario.task),
              { jsonMode: true, temperature: 0.1 },
            );

            const parsed = testResult.parsed;
            const selectedTools = (
              (parsed?.selectedTools as string[]) ?? []
            ).filter((t) => validToolNames.has(t));

            const expectedSet = new Set(scenario.expectedTools);
            const selectedSet = new Set(selectedTools);

            // Precision: of selected tools, how many are correct?
            const truePositives = selectedTools.filter((t) => expectedSet.has(t)).length;
            const precision = selectedTools.length > 0 ? truePositives / selectedTools.length : 0;

            // Recall: of expected tools, how many were selected?
            const recall =
              scenario.expectedTools.length > 0
                ? truePositives / scenario.expectedTools.length
                : 1;

            totalPrecision += precision;
            totalRecall += recall;

            scenarioResults.push({
              task: scenario.task,
              expected: scenario.expectedTools,
              selected: selectedTools,
              precision,
              recall,
            });

            if (precision < 1 || recall < 1) {
              const extra = selectedTools.filter((t) => !expectedSet.has(t));
              const missed = scenario.expectedTools.filter((t) => !selectedSet.has(t));
              assert.warn(
                false,
                `Routing: "${scenario.task.slice(0, 60)}..."`,
                `Expected [${scenario.expectedTools.join(', ')}], got [${selectedTools.join(', ')}]` +
                  (extra.length > 0 ? ` | Over-selected: ${extra.join(', ')}` : '') +
                  (missed.length > 0 ? ` | Missed: ${missed.join(', ')}` : ''),
              );
            }
          } catch (err) {
            assert.warn(false, `Routing test for scenario`,
              `LLM call failed: ${(err as Error).message}`);
          }
        }

        // Step 3: Aggregate scores
        const count = scenarios.length || 1;
        const avgPrecision = totalPrecision / count;
        const avgRecall = totalRecall / count;

        assert.ok(
          avgPrecision >= 0.7,
          'Average routing precision >= 70%',
          `Precision: ${(avgPrecision * 100).toFixed(0)}% — ` +
            (avgPrecision >= 0.7 ? 'agent avoids selecting wrong tools' : 'agent over-selects tools'),
        );

        assert.ok(
          avgRecall >= 0.7,
          'Average routing recall >= 70%',
          `Recall: ${(avgRecall * 100).toFixed(0)}% — ` +
            (avgRecall >= 0.7 ? 'agent finds the right tools' : 'agent misses correct tools'),
        );

        metadata = {
          input: { scenarioCount: scenarios.length, toolCount: discovered.tools.length },
          expected: { description: 'Precision and recall >= 70% for tool routing' },
          actual: {
            scenarios: scenarioResults,
            averagePrecision: Math.round(avgPrecision * 100),
            averageRecall: Math.round(avgRecall * 100),
          },
          llm: { model: llmClient.model, tokensUsed: llmClient.tokensUsed },
        };

        return { assertions: assert.assertions, metadata };
      },
    },
  ];
}
