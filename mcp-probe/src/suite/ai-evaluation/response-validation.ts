/**
 * AI Evaluation — Response Semantic Validation tests.
 *
 * For each tool, calls with the current dummy args (same as execution suite),
 * then asks the LLM to detect hidden failures — responses that pass structural
 * validation but contain error messages, empty data, or validation failures.
 *
 * This directly addresses the "false positive" problem where isError=false
 * but the response body describes a failure.
 */
import type { DiscoveredServer, DiscoveredTool } from '../../client/mcp-client.js';
import type { LLMClient } from '../../llm/client.js';
import { buildResponseValidationPrompt } from '../../llm/prompts.js';
import { generateValidValue } from '../schema/fuzzer.js';
import { AssertHelper, type TestCase, type TestCaseResult, type TestRunContext } from '../types.js';

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

function buildValidArgs(tool: DiscoveredTool): Record<string, unknown> {
  const properties = (tool.inputSchema?.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = (tool.inputSchema?.required ?? []) as string[];
  const args: Record<string, unknown> = {};
  for (const key of required) {
    args[key] = generateValidValue(properties[key] ?? { type: 'string' });
  }
  return args;
}

export function generateResponseValidationTests(
  discovered: DiscoveredServer,
  llmClient: LLMClient,
): TestCase[] {
  return discovered.tools.map((tool) => ({
    id: `ai-evaluation.tool.${tool.name}.response-validation`,
    name: `AI: Tool "${tool.name}" response semantic check`,
    description: 'Calls tool with default args, LLM checks for hidden failures in the response',
    tags: ['ai-evaluation', 'tool', 'validation'],
    requiredCapability: 'tools',

    async run(ctx: TestRunContext): Promise<TestCaseResult> {
      const assert = new AssertHelper();
      const args = buildValidArgs(tool);
      let metadata: Record<string, unknown> = {};

      // Step 1: Call the tool with default dummy args
      let traceResponse: unknown = null;
      let traceIsError = false;
      try {
        const trace = await ctx.client.callTool(tool.name, args);
        traceResponse = trace.response;
        traceIsError = trace.isError;

        if (trace.isError) {
          // If the tool itself reports an error, note it but still let LLM analyze
          assert.info('tool-reported-error', 'Tool returned isError=true');
        }
      } catch (err) {
        assert.ok(false, 'Tool call completed',
          `FAIL: Transport error: ${(err as Error).message}`);
        return { assertions: assert.assertions, metadata };
      }

      // Step 2: Ask LLM to validate the response semantically
      try {
        const validationResult = await llmClient.chat(
          buildResponseValidationPrompt(tool, args, traceResponse, traceIsError),
          { jsonMode: true, temperature: 0.1 },
        );

        const verdict = validationResult.parsed;
        if (verdict) {
          const dataQuality = (verdict.dataQuality as string) ?? 'unknown';
          const hiddenErrors = (verdict.hiddenErrors as string[]) ?? [];

          // Main assertion: is the response free of hidden errors?
          const isClean = verdict.verdict !== 'failure' && hiddenErrors.length === 0;
          assert.ok(isClean, 'No hidden errors in response',
            isClean
              ? `PASS: Response appears genuine (quality: ${dataQuality})`
              : `FAIL: Hidden failure detected — ${verdict.reasoning}`);

          // Report hidden errors individually
          for (const error of hiddenErrors) {
            assert.warn(false, 'Hidden error', error);
          }

          // Note if response is just a template/empty
          if (dataQuality === 'empty' || dataQuality === 'template') {
            assert.warn(false, 'Response contains meaningful data',
              `Response data quality: ${dataQuality}`);
          }

          assert.info('verdict', `LLM verdict: ${verdict.verdict} (confidence: ${verdict.confidence}/10)`);
        }

        metadata = {
          input: { method: 'tools/call', params: { name: tool.name, arguments: args } },
          expected: { description: 'Response without hidden errors or misleading success' },
          actual: truncateResponse({ isError: traceIsError, response: traceResponse }),
          llm: {
            model: llmClient.model,
            verdict: verdict?.verdict,
            confidence: verdict?.confidence,
            tokensUsed: validationResult.tokenUsage.total,
          },
        };
      } catch (err) {
        assert.ok(false, 'LLM response validation',
          `FAIL: LLM call failed: ${(err as Error).message}`);
        metadata = {
          input: { method: 'tools/call', params: { name: tool.name, arguments: args } },
          actual: truncateResponse({ isError: traceIsError, response: traceResponse }),
        };
      }

      return { assertions: assert.assertions, metadata };
    },
  }));
}
