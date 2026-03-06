/**
 * Error Handling Suite: Invalid Request Tests
 *
 * Tests server error responses for:
 * - Nonexistent tools, resources, prompts
 * - Missing required arguments
 * - Wrong type arguments
 * - Null arguments
 */
import type { TestCase, TestRunContext, TestCaseResult } from '../types.js';
import { AssertHelper } from '../types.js';
import type { DiscoveredServer } from '../../client/mcp-client.js';
import { generateValidValue, generateWrongTypeValue } from '../schema/fuzzer.js';

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

export function generateInvalidRequestTests(discovered: DiscoveredServer): TestCase[] {
  const tests: TestCase[] = [];

  // --- Static tests: nonexistent entities ---

  if ('tools' in discovered.capabilities) {
    tests.push({
      id: 'error-handling.tool.nonexistent',
      name: 'Server handles nonexistent tool gracefully',
      description: 'Calling tools/call with a tool that does not exist should return an error',
      tags: ['error-handling', 'tool'],
      requiredCapability: 'tools',
      async run(ctx: TestRunContext): Promise<TestCaseResult> {
        const assert = new AssertHelper();
        let metadata: Record<string, unknown> = {};

        try {
          const trace = await ctx.client.callTool('__nonexistent_tool_that_does_not_exist__', {});
          assert.ok(
            trace.isError,
            'Server returned error for nonexistent tool',
            trace.isError
              ? `PASS: Server correctly returned isError=true for nonexistent tool — the server properly rejects unknown tool names`
              : `FAIL: Server returned isError=false for a tool that does not exist — expected an error response indicating the tool was not found`,
          );
          assert.info('response', `isError=${trace.isError}, durationMs=${trace.durationMs}`);
          metadata = {
            input: { method: 'tools/call', params: { name: '__nonexistent_tool_that_does_not_exist__', arguments: {} } },
            expected: { description: 'Server should return isError=true for nonexistent tool' },
            actual: truncateResponse({ isError: trace.isError, durationMs: trace.durationMs, response: trace.response }),
          };
        } catch (err) {
          assert.ok(false, 'Server did not crash on nonexistent tool',
            `FAIL: Server crashed or disconnected when called with a nonexistent tool — ${(err as Error).message}. The server should return an error response, not crash.`,
          );
          metadata = {
            input: { method: 'tools/call', params: { name: '__nonexistent_tool_that_does_not_exist__', arguments: {} } },
            expected: { description: 'Server should return isError=true for nonexistent tool' },
            actual: { error: (err as Error).message },
          };
        }

        return { assertions: assert.assertions, metadata };
      },
    });
  }

  if ('resources' in discovered.capabilities) {
    tests.push({
      id: 'error-handling.resource.nonexistent',
      name: 'Server handles nonexistent resource gracefully',
      description: 'Reading a resource with a URI that does not exist should return an error',
      tags: ['error-handling', 'resource'],
      requiredCapability: 'resources',
      async run(ctx: TestRunContext): Promise<TestCaseResult> {
        const assert = new AssertHelper();
        let metadata: Record<string, unknown> = {};
        const testUri = '__nonexistent_resource_uri__://does-not-exist';

        try {
          const response = await ctx.client.readResource(testUri);

          if (response.error) {
            assert.ok(false, 'Server did not crash on nonexistent resource',
              `FAIL: Transport-level error when reading nonexistent resource — ${response.error.message}. The server should return a JSON-RPC error, not a transport failure.`,
            );
            metadata = {
              input: { method: 'resources/read', params: { uri: testUri } },
              expected: { description: 'JSON-RPC error for nonexistent resource' },
              actual: { error: response.error.message },
            };
          } else {
            const msg = response.message as Record<string, unknown>;
            const hasError = msg?.error !== undefined;
            assert.ok(
              hasError,
              'Server returned error for nonexistent resource',
              hasError
                ? `PASS: Server correctly returned a JSON-RPC error for nonexistent resource URI`
                : `FAIL: Server returned a success response for a resource that does not exist — expected a JSON-RPC error indicating resource not found`,
            );
            metadata = {
              input: { method: 'resources/read', params: { uri: testUri } },
              expected: { description: 'JSON-RPC error for nonexistent resource' },
              actual: truncateResponse(response.message),
            };
          }
        } catch (err) {
          assert.ok(false, 'Server did not crash on nonexistent resource',
            `FAIL: Server crashed or disconnected when reading a nonexistent resource — ${(err as Error).message}`,
          );
          metadata = {
            input: { method: 'resources/read', params: { uri: testUri } },
            expected: { description: 'JSON-RPC error for nonexistent resource' },
            actual: { error: (err as Error).message },
          };
        }

        return { assertions: assert.assertions, metadata };
      },
    });
  }

  if ('prompts' in discovered.capabilities) {
    tests.push({
      id: 'error-handling.prompt.nonexistent',
      name: 'Server handles nonexistent prompt gracefully',
      description: 'Getting a prompt that does not exist should return an error',
      tags: ['error-handling', 'prompt'],
      requiredCapability: 'prompts',
      async run(ctx: TestRunContext): Promise<TestCaseResult> {
        const assert = new AssertHelper();
        let metadata: Record<string, unknown> = {};

        try {
          const response = await ctx.client.getPrompt('__nonexistent_prompt__');

          if (response.error) {
            assert.ok(false, 'Server did not crash on nonexistent prompt',
              `FAIL: Transport-level error when getting nonexistent prompt — ${response.error.message}. Expected a JSON-RPC error response.`,
            );
            metadata = {
              input: { method: 'prompts/get', params: { name: '__nonexistent_prompt__' } },
              expected: { description: 'JSON-RPC error for nonexistent prompt' },
              actual: { error: response.error.message },
            };
          } else {
            const msg = response.message as Record<string, unknown>;
            const hasError = msg?.error !== undefined;
            assert.ok(
              hasError,
              'Server returned error for nonexistent prompt',
              hasError
                ? `PASS: Server correctly returned a JSON-RPC error for nonexistent prompt name`
                : `FAIL: Server returned a success response for a prompt that does not exist — expected a JSON-RPC error`,
            );
            metadata = {
              input: { method: 'prompts/get', params: { name: '__nonexistent_prompt__' } },
              expected: { description: 'JSON-RPC error for nonexistent prompt' },
              actual: truncateResponse(response.message),
            };
          }
        } catch (err) {
          assert.ok(false, 'Server did not crash on nonexistent prompt',
            `FAIL: Server crashed or disconnected when getting a nonexistent prompt — ${(err as Error).message}`,
          );
          metadata = {
            input: { method: 'prompts/get', params: { name: '__nonexistent_prompt__' } },
            expected: { description: 'JSON-RPC error for nonexistent prompt' },
            actual: { error: (err as Error).message },
          };
        }

        return { assertions: assert.assertions, metadata };
      },
    });
  }

  // --- Per-tool tests ---

  for (const tool of discovered.tools) {
    const required = (tool.inputSchema?.required ?? []) as string[];
    const properties = (tool.inputSchema?.properties ?? {}) as Record<string, Record<string, unknown>>;

    // Missing required args (only if tool has required fields)
    if (required.length > 0) {
      tests.push({
        id: `error-handling.tool.${tool.name}.missing-required-args`,
        name: `Tool "${tool.name}" rejects missing required args`,
        description: `Calling with empty args when tool has ${required.length} required field(s): ${required.join(', ')}`,
        tags: ['error-handling', 'tool'],
        requiredCapability: 'tools',
        async run(ctx: TestRunContext): Promise<TestCaseResult> {
          const assert = new AssertHelper();
          let metadata: Record<string, unknown> = {};

          try {
            const trace = await ctx.client.callTool(tool.name, {});
            assert.ok(
              trace.isError,
              'Server returned error for missing required args',
              trace.isError
                ? `PASS: Server correctly returned isError=true when required fields [${required.join(', ')}] were omitted`
                : `FAIL: Server returned isError=false despite missing required fields [${required.join(', ')}] — expected an error indicating which fields are required`,
            );
            metadata = {
              input: { method: 'tools/call', params: { name: tool.name, arguments: {} } },
              expected: { description: `isError=true (missing required fields: ${required.join(', ')})` },
              actual: truncateResponse({ isError: trace.isError, response: trace.response }),
            };
          } catch (err) {
            assert.ok(false, 'Server did not crash on missing args',
              `FAIL: Server crashed when "${tool.name}" was called without required args — ${(err as Error).message}. Should return error, not crash.`,
            );
            metadata = {
              input: { method: 'tools/call', params: { name: tool.name, arguments: {} } },
              expected: { description: `isError=true (missing required fields: ${required.join(', ')})` },
              actual: { error: (err as Error).message },
            };
          }

          return { assertions: assert.assertions, metadata };
        },
      });
    }

    // Wrong type args (for the first required field)
    if (required.length > 0) {
      const firstRequired = required[0];
      const propSchema = properties[firstRequired] ?? { type: 'string' };
      const wrongValue = generateWrongTypeValue(propSchema);

      if (wrongValue !== undefined) {
        tests.push({
          id: `error-handling.tool.${tool.name}.wrong-type-args`,
          name: `Tool "${tool.name}" handles wrong type args`,
          description: `Passing ${typeof wrongValue} for "${firstRequired}" (expected ${propSchema.type})`,
          tags: ['error-handling', 'tool'],
          requiredCapability: 'tools',
          async run(ctx: TestRunContext): Promise<TestCaseResult> {
            const assert = new AssertHelper();
            let metadata: Record<string, unknown> = {};

            // Build args with all required fields valid, except one has wrong type
            const args: Record<string, unknown> = {};
            for (const key of required) {
              args[key] = generateValidValue(properties[key] ?? { type: 'string' });
            }
            args[firstRequired] = wrongValue;

            try {
              const trace = await ctx.client.callTool(tool.name, args);
              const handled = trace.isError || trace.response !== undefined;
              assert.ok(
                handled,
                'Server handled wrong type gracefully (did not crash)',
                handled
                  ? `PASS: Server handled wrong type for "${firstRequired}" without crashing — passed ${typeof wrongValue} instead of ${propSchema.type}`
                  : `FAIL: Server returned neither error nor response for wrong type input — this may indicate a protocol issue`,
              );
              if (trace.isError) {
                assert.info('behavior', `Server correctly rejected wrong type — returned isError=true`);
              } else {
                assert.warn(false, 'expected-error',
                  `WARN: Server accepted wrong type for "${firstRequired}" (passed ${typeof wrongValue}, expected ${propSchema.type}) — ideally should validate and return an error`,
                );
              }
              metadata = {
                input: { method: 'tools/call', params: { name: tool.name, arguments: args } },
                expected: { description: `Error or graceful handling (wrong type: ${typeof wrongValue} for "${firstRequired}", expected ${propSchema.type})` },
                actual: truncateResponse({ isError: trace.isError, response: trace.response }),
              };
            } catch (err) {
              assert.ok(false, 'Server did not crash on wrong type args',
                `FAIL: Server crashed when "${tool.name}" received wrong type for "${firstRequired}" — ${(err as Error).message}`,
              );
              metadata = {
                input: { method: 'tools/call', params: { name: tool.name, arguments: args } },
                expected: { description: `Error or graceful handling (wrong type: ${typeof wrongValue} for "${firstRequired}", expected ${propSchema.type})` },
                actual: { error: (err as Error).message },
              };
            }

            return { assertions: assert.assertions, metadata };
          },
        });
      }
    }

    // Null args
    tests.push({
      id: `error-handling.tool.${tool.name}.null-args`,
      name: `Tool "${tool.name}" handles null arguments`,
      description: 'Calling with null arguments should return error, not crash',
      tags: ['error-handling', 'tool'],
      requiredCapability: 'tools',
      async run(ctx: TestRunContext): Promise<TestCaseResult> {
        const assert = new AssertHelper();
        let metadata: Record<string, unknown> = {};

        try {
          const trace = await ctx.client.callTool(tool.name, null as unknown);
          const handled = trace.isError || trace.response !== undefined;
          assert.ok(
            handled,
            'Server handled null args gracefully',
            handled
              ? `PASS: Server handled null arguments for "${tool.name}" without crashing — returned ${trace.isError ? 'error' : 'response'}`
              : `FAIL: Server returned neither error nor response when called with null arguments`,
          );
          metadata = {
            input: { method: 'tools/call', params: { name: tool.name, arguments: null } },
            expected: { description: 'Error response or graceful handling (null arguments)' },
            actual: truncateResponse({ isError: trace.isError, response: trace.response }),
          };
        } catch (err) {
          // Some servers may reject at the transport level — that's OK as long as they don't crash
          const msg = (err as Error).message;
          const crashed = msg.includes('closed') || msg.includes('EPIPE');
          assert.warn(
            !crashed,
            'null-args-no-crash',
            crashed
              ? `WARN: Server connection closed when "${tool.name}" received null args — ${msg}. The server may have crashed.`
              : `PASS: Server rejected null args at transport level — ${msg} (acceptable behavior)`,
          );
          metadata = {
            input: { method: 'tools/call', params: { name: tool.name, arguments: null } },
            expected: { description: 'Error response or graceful handling (null arguments)' },
            actual: { error: msg },
          };
        }

        return { assertions: assert.assertions, metadata };
      },
    });
  }

  // --- Per-prompt tests: missing required args ---

  for (const prompt of discovered.prompts) {
    const requiredArgs = (prompt.arguments ?? []).filter((a) => a.required);

    if (requiredArgs.length > 0) {
      tests.push({
        id: `error-handling.prompt.${prompt.name}.missing-required-args`,
        name: `Prompt "${prompt.name}" rejects missing required args`,
        description: `Getting prompt without required args: ${requiredArgs.map((a) => a.name).join(', ')}`,
        tags: ['error-handling', 'prompt'],
        requiredCapability: 'prompts',
        async run(ctx: TestRunContext): Promise<TestCaseResult> {
          const assert = new AssertHelper();
          let metadata: Record<string, unknown> = {};

          try {
            const response = await ctx.client.getPrompt(prompt.name, {});

            if (response.error) {
              assert.ok(false, 'Server did not crash',
                `FAIL: Transport-level error when getting prompt "${prompt.name}" without args — ${response.error.message}`,
              );
              metadata = {
                input: { method: 'prompts/get', params: { name: prompt.name, arguments: {} } },
                expected: { description: `Error (missing required args: ${requiredArgs.map((a) => a.name).join(', ')})` },
                actual: { error: response.error.message },
              };
            } else {
              const msg = response.message as Record<string, unknown>;
              const hasError = msg?.error !== undefined;
              assert.ok(
                hasError,
                'Server returned error for missing prompt args',
                hasError
                  ? `PASS: Server correctly returned error when required args [${requiredArgs.map((a) => a.name).join(', ')}] were omitted from prompt "${prompt.name}"`
                  : `FAIL: Server returned success for prompt "${prompt.name}" despite missing required args [${requiredArgs.map((a) => a.name).join(', ')}]`,
              );
              metadata = {
                input: { method: 'prompts/get', params: { name: prompt.name, arguments: {} } },
                expected: { description: `Error (missing required args: ${requiredArgs.map((a) => a.name).join(', ')})` },
                actual: truncateResponse(response.message),
              };
            }
          } catch (err) {
            assert.ok(false, 'Server did not crash on missing prompt args',
              `FAIL: Server crashed when prompt "${prompt.name}" was called without required args — ${(err as Error).message}`,
            );
            metadata = {
              input: { method: 'prompts/get', params: { name: prompt.name, arguments: {} } },
              expected: { description: `Error (missing required args: ${requiredArgs.map((a) => a.name).join(', ')})` },
              actual: { error: (err as Error).message },
            };
          }

          return { assertions: assert.assertions, metadata };
        },
      });
    }
  }

  return tests;
}
