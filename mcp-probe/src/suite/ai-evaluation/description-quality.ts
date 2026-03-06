/**
 * AI Evaluation — Tool Description Quality tests.
 *
 * For each tool, asks the LLM to rate description quality on a 1-10 scale.
 * A good description helps AI agents understand when and how to use a tool.
 *
 * - Score >= 7: PASS
 * - Score 5-6: WARN (needs improvement)
 * - Score < 5: FAIL (poor quality)
 */
import type { DiscoveredServer } from '../../client/mcp-client.js';
import type { LLMClient } from '../../llm/client.js';
import { buildDescriptionQualityPrompt } from '../../llm/prompts.js';
import { AssertHelper, type TestCase, type TestCaseResult, type TestRunContext } from '../types.js';

export function generateDescriptionQualityTests(
  discovered: DiscoveredServer,
  llmClient: LLMClient,
): TestCase[] {
  return discovered.tools.map((tool) => ({
    id: `ai-evaluation.tool.${tool.name}.description-quality`,
    name: `AI: Tool "${tool.name}" description quality`,
    description: 'LLM rates how well an AI agent can understand this tool from its description',
    tags: ['ai-evaluation', 'tool', 'documentation'],

    async run(_ctx: TestRunContext): Promise<TestCaseResult> {
      const assert = new AssertHelper();
      let metadata: Record<string, unknown> = {};

      try {
        const result = await llmClient.chat(buildDescriptionQualityPrompt(tool), {
          jsonMode: true,
          temperature: 0.2,
        });

        const parsed = result.parsed;
        if (!parsed?.score) {
          assert.info('llm-parse-error', 'Could not parse LLM quality score');
          metadata = { llmRawResponse: result.content.slice(0, 500) };
          return { assertions: assert.assertions, metadata };
        }

        const score = parsed.score as number;
        const reasoning = (parsed.reasoning as string) ?? '';
        const issues = (parsed.issues as string[]) ?? [];
        const suggestions = (parsed.suggestions as string[]) ?? [];

        if (score >= 7) {
          assert.ok(true, 'Description quality >= 7',
            `PASS: Score ${score}/10. ${reasoning}`);
        } else if (score >= 5) {
          assert.warn(false, 'Description quality >= 7',
            `Score ${score}/10 (needs improvement). ${reasoning}`);
        } else {
          assert.ok(false, 'Description quality >= 5',
            `FAIL: Score ${score}/10 (poor). ${reasoning}`);
        }

        // Report specific issues
        for (const issue of issues) {
          assert.info('issue', issue);
        }

        // Report suggestions
        if (suggestions.length > 0) {
          assert.info('suggestions', suggestions.join('; '));
        }

        metadata = {
          input: {
            toolName: tool.name,
            description: tool.description ?? 'NONE',
            schemaPropertyCount: Object.keys(
              (tool.inputSchema?.properties as Record<string, unknown>) ?? {},
            ).length,
          },
          expected: { description: 'Description quality score >= 7/10' },
          actual: { score, reasoning, issues, suggestions },
          llm: {
            model: llmClient.model,
            tokensUsed: result.tokenUsage.total,
          },
        };
      } catch (err) {
        assert.ok(false, 'LLM description quality check',
          `FAIL: LLM call failed: ${(err as Error).message}`);
      }

      return { assertions: assert.assertions, metadata };
    },
  }));
}
