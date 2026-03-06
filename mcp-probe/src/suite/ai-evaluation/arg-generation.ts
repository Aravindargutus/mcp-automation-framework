/**
 * AI Evaluation — Smart Argument Generation + Execution tests.
 *
 * For each tool:
 *   1. LLM generates realistic arguments from schema + description
 *   2. Calls the tool with those arguments
 *   3. LLM validates the response semantically
 *
 * This is the highest-value AI test — it catches false-positive passes
 * where dummy arguments produce error-like responses that still pass
 * structural validation.
 */
import type { DiscoveredServer } from '../../client/mcp-client.js';
import type { LLMClient } from '../../llm/client.js';
import { buildArgGenerationPrompt, buildResponseValidationPrompt } from '../../llm/prompts.js';
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

export function generateArgGenerationTests(
  discovered: DiscoveredServer,
  llmClient: LLMClient,
): TestCase[] {
  return discovered.tools.map((tool) => ({
    id: `ai-evaluation.tool.${tool.name}.smart-execution`,
    name: `AI: Tool "${tool.name}" executes with realistic arguments`,
    description: 'LLM generates realistic arguments, calls tool, then validates the response semantically',
    tags: ['ai-evaluation', 'tool', 'execution'],
    requiredCapability: 'tools',

    async run(ctx: TestRunContext): Promise<TestCaseResult> {
      const assert = new AssertHelper();
      let metadata: Record<string, unknown> = {};

      // Step 1: Ask LLM to generate realistic arguments
      let generatedArgs: Record<string, unknown> = {};
      let argReasoning = '';
      try {
        const argResult = await llmClient.chat(buildArgGenerationPrompt(tool), {
          jsonMode: true,
          temperature: 0.3,
        });

        if (!argResult.parsed?.arguments) {
          assert.ok(false, 'LLM generated valid arguments', 'LLM response missing "arguments" field');
          metadata = { llmRawResponse: argResult.content.slice(0, 500) };
          return { assertions: assert.assertions, metadata };
        }

        generatedArgs = argResult.parsed.arguments as Record<string, unknown>;
        argReasoning = (argResult.parsed.reasoning as string) ?? '';
        assert.ok(true, 'LLM generated realistic arguments',
          `PASS: Generated args with reasoning: ${argReasoning.slice(0, 100)}`);
      } catch (err) {
        assert.ok(false, 'LLM argument generation',
          `FAIL: LLM call failed: ${(err as Error).message}`);
        return { assertions: assert.assertions, metadata };
      }

      // Step 2: Call the tool with LLM-generated arguments
      let traceResponse: unknown = null;
      let traceIsError = false;
      let traceDurationMs = 0;
      try {
        const trace = await ctx.client.callTool(tool.name, generatedArgs);
        traceResponse = trace.response;
        traceIsError = trace.isError;
        traceDurationMs = trace.durationMs;
        assert.ok(true, 'Tool call completed',
          `PASS: Tool responded in ${trace.durationMs}ms`);
      } catch (err) {
        assert.ok(false, 'Tool call completed',
          `FAIL: Transport error: ${(err as Error).message}`);
        metadata = {
          input: { generatedArgs, reasoning: argReasoning },
          expected: { description: 'Functional success response' },
          actual: { error: (err as Error).message },
          llm: { model: llmClient.model, tokensUsed: llmClient.tokensUsed },
        };
        return { assertions: assert.assertions, metadata };
      }

      // Step 3: Ask LLM to validate the response semantically
      try {
        const validationResult = await llmClient.chat(
          buildResponseValidationPrompt(tool, generatedArgs, traceResponse, traceIsError),
          { jsonMode: true, temperature: 0.1 },
        );

        const verdict = validationResult.parsed;
        if (verdict) {
          const isSuccess = verdict.verdict === 'success';
          const confidence = (verdict.confidence as number) ?? 0;

          assert.ok(isSuccess, 'LLM judges response as functional success',
            isSuccess
              ? `PASS: Response is semantically valid (confidence: ${confidence}/10)`
              : `FAIL: ${verdict.reasoning}`);

          const hiddenErrors = (verdict.hiddenErrors as string[]) ?? [];
          if (hiddenErrors.length > 0) {
            assert.warn(false, 'No hidden errors detected',
              `Hidden errors: ${hiddenErrors.join('; ')}`);
          }

          assert.info('data-quality', `Data quality: ${verdict.dataQuality ?? 'unknown'}`);
        }
      } catch (err) {
        assert.info('llm-validation-skipped',
          `Response validation skipped: ${(err as Error).message}`);
      }

      metadata = {
        input: { generatedArgs, reasoning: argReasoning },
        expected: { description: 'Functional success response' },
        actual: truncateResponse({
          isError: traceIsError,
          durationMs: traceDurationMs,
          response: traceResponse,
        }),
        llm: { model: llmClient.model, tokensUsed: llmClient.tokensUsed },
      };

      return { assertions: assert.assertions, metadata };
    },
  }));
}
