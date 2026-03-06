/**
 * AI Evaluation — Tool Set Discoverability test.
 *
 * A single suite-level test that sends ALL tool names + descriptions
 * to the LLM, asking it to identify:
 *   - Confusing tool pairs with overlapping purposes
 *   - Naming inconsistencies
 *   - Obvious functional gaps
 *
 * Only generated when there are 2+ tools (no point with a single tool).
 */
import type { DiscoveredServer } from '../../client/mcp-client.js';
import type { LLMClient } from '../../llm/client.js';
import { buildDiscoverabilityPrompt } from '../../llm/prompts.js';
import { AssertHelper, type TestCase, type TestCaseResult, type TestRunContext } from '../types.js';

export function generateDiscoverabilityTests(
  discovered: DiscoveredServer,
  llmClient: LLMClient,
): TestCase[] {
  if (discovered.tools.length < 2) return [];

  return [
    {
      id: 'ai-evaluation.suite.tool-discoverability',
      name: 'AI: Tool set discoverability analysis',
      description: 'LLM evaluates whether tools are distinguishable and well-organized for AI agents',
      tags: ['ai-evaluation', 'suite-level', 'documentation'],

      async run(_ctx: TestRunContext): Promise<TestCaseResult> {
        const assert = new AssertHelper();
        let metadata: Record<string, unknown> = {};

        try {
          const result = await llmClient.chat(buildDiscoverabilityPrompt(discovered.tools), {
            jsonMode: true,
            temperature: 0.2,
          });

          const parsed = result.parsed;
          if (!parsed) {
            assert.info('parse-error', 'Could not parse discoverability analysis');
            metadata = { llmRawResponse: result.content.slice(0, 500) };
            return { assertions: assert.assertions, metadata };
          }

          const score = (parsed.overallScore as number) ?? 5;
          const confusingPairs = (parsed.confusingPairs as Array<{ tools: string[]; reason: string }>) ?? [];
          const namingIssues = (parsed.namingIssues as Array<{ tool: string; issue: string }>) ?? [];
          const recommendations = (parsed.recommendations as string[]) ?? [];

          // Main assertion
          assert.ok(score >= 7, 'Tool set discoverability >= 7',
            score >= 7
              ? `PASS: Score ${score}/10 — tools are well-organized`
              : `Score ${score}/10 — ${confusingPairs.length} confusing pair(s) found`);

          // Report confusing pairs as warnings
          for (const pair of confusingPairs) {
            assert.warn(false, `Confusing pair: ${pair.tools.join(' ↔ ')}`, pair.reason);
          }

          // Report naming issues
          for (const issue of namingIssues) {
            assert.warn(false, `Naming issue: ${issue.tool}`, issue.issue);
          }

          // Report recommendations
          if (recommendations.length > 0) {
            assert.info('recommendations', recommendations.join('; '));
          }

          metadata = {
            input: { toolCount: discovered.tools.length },
            expected: { description: 'Discoverability score >= 7/10' },
            actual: {
              score,
              confusingPairs: confusingPairs.length,
              namingIssues: namingIssues.length,
            },
            llm: {
              model: llmClient.model,
              tokensUsed: result.tokenUsage.total,
            },
          };
        } catch (err) {
          assert.ok(false, 'LLM discoverability analysis',
            `FAIL: LLM call failed: ${(err as Error).message}`);
        }

        return { assertions: assert.assertions, metadata };
      },
    },
  ];
}
