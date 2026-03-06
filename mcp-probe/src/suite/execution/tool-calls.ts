/**
 * Execution Suite: Tool Call Tests
 *
 * Actually calls each discovered tool with valid inputs and validates:
 * - Response has content array with proper structure
 * - isError flag is false for valid calls
 * - Response time is reasonable
 */
import type { TestCase, TestRunContext, TestCaseResult } from '../types.js';
import { AssertHelper } from '../types.js';
import type { DiscoveredServer, DiscoveredTool } from '../../client/mcp-client.js';
import type { ServerConfig } from '../../config/schema.js';
import { generateValidValue } from '../schema/fuzzer.js';

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

export function generateToolCallTests(discovered: DiscoveredServer, _serverConfig: ServerConfig): TestCase[] {
  const tests: TestCase[] = [];

  for (const tool of discovered.tools) {

    // Test 1: Call returns content
    tests.push({
      id: `execution.tool.${tool.name}.call-returns-content`,
      name: `Tool "${tool.name}" returns valid content`,
      description: 'Calling with valid args should return a response with content array',
      tags: ['execution', 'tool'],
      requiredCapability: 'tools',
      async run(ctx: TestRunContext): Promise<TestCaseResult> {
        const assert = new AssertHelper();
        const args = buildValidArgs(tool);
        let metadata: Record<string, unknown> = {};

        try {
          const trace = await ctx.client.callTool(tool.name, args);

          assert.ok(
            !trace.isError,
            'Tool call did not return isError',
            trace.isError
              ? `FAIL: Server returned isError=true — tool "${tool.name}" rejected valid arguments. Check if the generated args match expected format.`
              : `PASS: Tool "${tool.name}" executed successfully with isError=false in ${trace.durationMs}ms`,
          );

          const result = trace.response as Record<string, unknown> | undefined;
          if (result && result.content !== undefined) {
            const content = result.content as unknown[];
            assert.ok(
              Array.isArray(result.content),
              'Response has content array',
              Array.isArray(result.content)
                ? `PASS: Response contains content array with ${content.length} item(s)`
                : `FAIL: content field exists but is not an array — got ${typeof result.content}`,
            );
          } else if (result !== undefined) {
            assert.ok(true, 'Response received (non-standard content structure)',
              `PASS: Response received but uses non-standard structure. Keys: ${Object.keys(result).join(', ')}`,
            );
          } else {
            assert.ok(false, 'Tool call returned a response',
              `FAIL: Tool "${tool.name}" returned null/undefined response — expected a result object with content array`,
            );
          }

          assert.info('response-time', `Responded in ${trace.durationMs}ms`);
          metadata = {
            input: { method: 'tools/call', params: { name: tool.name, arguments: args } },
            expected: { description: 'Response with content array, isError=false' },
            actual: truncateResponse({ isError: trace.isError, durationMs: trace.durationMs, response: trace.response }),
          };
        } catch (err) {
          assert.ok(false, 'Tool call completed without transport error',
            `FAIL: Transport error calling "${tool.name}" — ${(err as Error).message}. The server may have crashed or disconnected.`,
          );
          metadata = {
            input: { method: 'tools/call', params: { name: tool.name, arguments: args } },
            expected: { description: 'Response with content array, isError=false' },
            actual: { error: (err as Error).message },
          };
        }

        return { assertions: assert.assertions, metadata };
      },
    });

    // Test 2: Content structure
    tests.push({
      id: `execution.tool.${tool.name}.content-structure`,
      name: `Tool "${tool.name}" content items have valid structure`,
      description: 'Each content item should have a type field (text, image, or resource)',
      tags: ['execution', 'tool'],
      requiredCapability: 'tools',
      async run(ctx: TestRunContext): Promise<TestCaseResult> {
        const assert = new AssertHelper();
        const args = buildValidArgs(tool);
        let metadata: Record<string, unknown> = {};

        try {
          const trace = await ctx.client.callTool(tool.name, args);
          const result = trace.response as Record<string, unknown> | undefined;
          const content = result?.content as Array<Record<string, unknown>> | undefined;

          if (content && Array.isArray(content)) {
            for (let i = 0; i < content.length; i++) {
              const item = content[i];
              assert.ok(
                typeof item.type === 'string',
                `content[${i}] has type field`,
                typeof item.type === 'string'
                  ? `PASS: content[${i}].type = "${item.type}"`
                  : `FAIL: content[${i}] missing "type" field — each content item must declare type as "text", "image", or "resource"`,
              );

              if (item.type === 'text') {
                assert.ok(
                  typeof item.text === 'string',
                  `content[${i}] text item has text field`,
                  typeof item.text === 'string'
                    ? `PASS: Text content present (${(item.text as string).length} chars)`
                    : `FAIL: content[${i}] has type="text" but is missing the "text" string field`,
                );
              } else if (item.type === 'image') {
                assert.ok(
                  typeof item.data === 'string',
                  `content[${i}] image item has data field`,
                  typeof item.data === 'string'
                    ? `PASS: Image data present (base64, ${(item.data as string).length} chars)`
                    : `FAIL: content[${i}] has type="image" but is missing the "data" base64 string field`,
                );
                assert.ok(
                  typeof item.mimeType === 'string',
                  `content[${i}] image item has mimeType`,
                  typeof item.mimeType === 'string'
                    ? `PASS: Image mimeType = "${item.mimeType}"`
                    : `FAIL: content[${i}] has type="image" but is missing the "mimeType" field (e.g., "image/png")`,
                );
              } else if (item.type === 'resource') {
                const hasResource = item.resource !== undefined;
                assert.ok(
                  hasResource,
                  `content[${i}] resource item has resource field`,
                  hasResource
                    ? `PASS: Embedded resource object present`
                    : `FAIL: content[${i}] has type="resource" but is missing the "resource" object field`,
                );
              }
            }

            if (content.length === 0) {
              assert.info('empty-content', 'Tool returned empty content array — no items to validate');
            }
          } else {
            assert.info('no-content-array', `Response does not use standard content array structure — got keys: ${result ? Object.keys(result).join(', ') : 'null'}`);
          }
          metadata = {
            input: { method: 'tools/call', params: { name: tool.name, arguments: args } },
            expected: { description: 'Each content item has type field (text/image/resource) with corresponding data fields' },
            actual: truncateResponse({ isError: trace.isError, response: trace.response }),
          };
        } catch (err) {
          assert.ok(false, 'Tool call completed',
            `FAIL: Transport error calling "${tool.name}" — ${(err as Error).message}`,
          );
          metadata = {
            input: { method: 'tools/call', params: { name: tool.name, arguments: args } },
            expected: { description: 'Each content item has type field (text/image/resource) with corresponding data fields' },
            actual: { error: (err as Error).message },
          };
        }

        return { assertions: assert.assertions, metadata };
      },
    });

    // Test 3: Response time
    tests.push({
      id: `execution.tool.${tool.name}.response-time`,
      name: `Tool "${tool.name}" responds within timeout`,
      description: 'Tool should respond within a reasonable time',
      tags: ['execution', 'tool', 'performance'],
      requiredCapability: 'tools',
      async run(ctx: TestRunContext): Promise<TestCaseResult> {
        const assert = new AssertHelper();
        const args = buildValidArgs(tool);
        let metadata: Record<string, unknown> = {};

        try {
          const trace = await ctx.client.callTool(tool.name, args);
          assert.warn(
            trace.durationMs < 30_000,
            'response-under-30s',
            trace.durationMs < 30_000
              ? `PASS: Responded in ${trace.durationMs}ms (under 30s limit)`
              : `WARN: Slow response — ${trace.durationMs}ms exceeds 30s recommended limit. Consider optimizing tool "${tool.name}".`,
          );
          assert.warn(
            trace.durationMs < 5_000,
            'response-under-5s',
            trace.durationMs < 5_000
              ? `PASS: Responded in ${trace.durationMs}ms (under 5s ideal target)`
              : `WARN: Response took ${trace.durationMs}ms — ideally should be under 5s for good UX.`,
          );
          assert.info('latency', `${trace.durationMs}ms`);
          metadata = {
            input: { method: 'tools/call', params: { name: tool.name, arguments: args } },
            expected: { description: 'Response under 30s (ideal: under 5s)' },
            actual: { durationMs: trace.durationMs, isError: trace.isError },
          };
        } catch (err) {
          assert.ok(false, 'Tool call completed',
            `FAIL: Tool "${tool.name}" timed out or crashed — ${(err as Error).message}`,
          );
          metadata = {
            input: { method: 'tools/call', params: { name: tool.name, arguments: args } },
            expected: { description: 'Response under 30s (ideal: under 5s)' },
            actual: { error: (err as Error).message },
          };
        }

        return { assertions: assert.assertions, metadata };
      },
    });
  }

  return tests;
}
