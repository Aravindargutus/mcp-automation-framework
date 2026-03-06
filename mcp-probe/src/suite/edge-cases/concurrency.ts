/**
 * Edge Cases Suite: Concurrency Tests
 *
 * Tests server behavior under concurrent requests:
 * - Parallel tool calls
 * - Parallel list operations
 * - Request cancellation
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

export function generateConcurrencyTests(discovered: DiscoveredServer, _serverConfig: ServerConfig): TestCase[] {
  const tests: TestCase[] = [];
  const allTools = discovered.tools;

  // Test 1: Parallel tool calls (need 3+ tools)
  if (allTools.length >= 3) {
    const toolsToTest = allTools.slice(0, 3);
    tests.push({
      id: 'edge-cases.concurrency.parallel-tool-calls',
      name: 'Server handles parallel tool calls',
      description: `Calling 3 tools concurrently: ${toolsToTest.map((t) => t.name).join(', ')}`,
      tags: ['edge-cases', 'concurrency'],
      requiredCapability: 'tools',
      async run(ctx: TestRunContext): Promise<TestCaseResult> {
        const assert = new AssertHelper();
        const toolsToCall = allTools.slice(0, 3);
        const argsPerTool = toolsToCall.map((t) => buildValidArgs(t));
        let metadata: Record<string, unknown> = {};

        try {
          const results = await Promise.all(
            toolsToCall.map((tool, idx) => ctx.client.callTool(tool.name, argsPerTool[idx])),
          );

          for (let i = 0; i < results.length; i++) {
            const trace = results[i];
            assert.ok(
              !trace.isError,
              `Parallel call "${toolsToCall[i].name}" succeeded`,
              !trace.isError
                ? `PASS: "${toolsToCall[i].name}" responded successfully in ${trace.durationMs}ms during concurrent execution`
                : `FAIL: "${toolsToCall[i].name}" returned isError=true during parallel execution — may fail under concurrency`,
            );
          }

          assert.info(
            'timings',
            results.map((r, i) => `${toolsToCall[i].name}: ${r.durationMs}ms`).join(', '),
          );
          metadata = {
            input: { method: 'tools/call (x3 parallel)', params: toolsToCall.map((t, i) => ({ name: t.name, arguments: argsPerTool[i] })) },
            expected: { description: 'All 3 parallel tool calls succeed without errors' },
            actual: results.map((r, i) => ({ tool: toolsToCall[i].name, isError: r.isError, durationMs: r.durationMs })),
          };
        } catch (err) {
          assert.ok(false, 'Parallel tool calls completed',
            `FAIL: Server crashed during parallel execution of 3 tools — ${(err as Error).message}. The server may not support concurrent requests.`,
          );
          metadata = {
            input: { method: 'tools/call (x3 parallel)', params: toolsToCall.map((t, i) => ({ name: t.name, arguments: argsPerTool[i] })) },
            expected: { description: 'All 3 parallel tool calls succeed' },
            actual: { error: (err as Error).message },
          };
        }

        return { assertions: assert.assertions, metadata };
      },
    });
  } else if (allTools.length >= 1) {
    // If fewer than 3 tools, call the same tool 3 times concurrently
    const tool = allTools[0];
    tests.push({
      id: 'edge-cases.concurrency.parallel-same-tool',
      name: 'Server handles parallel calls to same tool',
      description: `Calling "${tool.name}" 3 times concurrently`,
      tags: ['edge-cases', 'concurrency'],
      requiredCapability: 'tools',
      async run(ctx: TestRunContext): Promise<TestCaseResult> {
        const assert = new AssertHelper();
        const args = buildValidArgs(tool);
        let metadata: Record<string, unknown> = {};

        try {
          const results = await Promise.all([
            ctx.client.callTool(tool.name, args),
            ctx.client.callTool(tool.name, args),
            ctx.client.callTool(tool.name, args),
          ]);

          const succeeded = results.filter((r) => !r.isError).length;
          assert.ok(
            succeeded === 3,
            `All 3 parallel calls succeeded (${succeeded}/3)`,
            succeeded === 3
              ? `PASS: All 3 concurrent calls to "${tool.name}" succeeded — server handles parallel requests well`
              : `FAIL: Only ${succeeded}/3 concurrent calls to "${tool.name}" succeeded — server may have race conditions or concurrency limits`,
          );
          assert.info('timings', results.map((r, i) => `call${i + 1}: ${r.durationMs}ms`).join(', '));
          metadata = {
            input: { method: 'tools/call (x3 parallel, same tool)', params: { name: tool.name, arguments: args } },
            expected: { description: 'All 3 parallel calls to same tool succeed' },
            actual: results.map((r, i) => ({ call: i + 1, isError: r.isError, durationMs: r.durationMs })),
          };
        } catch (err) {
          assert.ok(false, 'Parallel calls completed',
            `FAIL: Server crashed during 3 concurrent calls to "${tool.name}" — ${(err as Error).message}`,
          );
          metadata = {
            input: { method: 'tools/call (x3 parallel, same tool)', params: { name: tool.name, arguments: args } },
            expected: { description: 'All 3 parallel calls succeed' },
            actual: { error: (err as Error).message },
          };
        }

        return { assertions: assert.assertions, metadata };
      },
    });
  }

  // Test 2: Parallel list operations
  tests.push({
    id: 'edge-cases.concurrency.parallel-list-ops',
    name: 'Server handles parallel list operations',
    description: 'Calling tools/list, resources/list, prompts/list concurrently',
    tags: ['edge-cases', 'concurrency'],
    async run(ctx: TestRunContext): Promise<TestCaseResult> {
      const assert = new AssertHelper();
      const caps = ctx.discovered.capabilities;
      let metadata: Record<string, unknown> = {};

      try {
        const promises: Promise<{ method: string; result: unknown }>[] = [];
        const methods: string[] = [];

        if ('tools' in caps) {
          methods.push('tools/list');
          promises.push(
            ctx.rawClient.sendRequest('tools/list', {}, ctx.requestTimeoutMs)
              .then((r) => ({ method: 'tools/list', result: r })),
          );
        }
        if ('resources' in caps) {
          methods.push('resources/list');
          promises.push(
            ctx.rawClient.sendRequest('resources/list', {}, ctx.requestTimeoutMs)
              .then((r) => ({ method: 'resources/list', result: r })),
          );
        }
        if ('prompts' in caps) {
          methods.push('prompts/list');
          promises.push(
            ctx.rawClient.sendRequest('prompts/list', {}, ctx.requestTimeoutMs)
              .then((r) => ({ method: 'prompts/list', result: r })),
          );
        }

        if (promises.length === 0) {
          assert.info('no-capabilities', 'No list operations to test — server declares no capabilities');
          return { assertions: assert.assertions };
        }

        const results = await Promise.all(promises);

        for (const { method, result } of results) {
          const raw = result as { message: unknown; error?: Error };
          const noError = !raw.error;
          assert.ok(
            noError,
            `${method} responded without error`,
            noError
              ? `PASS: ${method} returned successfully during concurrent execution`
              : `FAIL: ${method} returned error during concurrent execution — ${raw.error?.message}. May fail under parallel load.`,
          );
        }

        assert.info('parallel-count', `${results.length} list operations completed in parallel`);
        metadata = {
          input: { methods, mode: 'concurrent' },
          expected: { description: 'All list operations return successfully in parallel' },
          actual: results.map(({ method, result }) => {
            const raw = result as { message: unknown; error?: Error };
            return { method, hasError: !!raw.error, error: raw.error?.message };
          }),
        };
      } catch (err) {
        assert.ok(false, 'Parallel list operations completed',
          `FAIL: Server crashed during concurrent list operations — ${(err as Error).message}. The server should handle parallel list requests.`,
        );
        metadata = {
          input: { methods: ['tools/list', 'resources/list', 'prompts/list'], mode: 'concurrent' },
          expected: { description: 'All list operations return successfully' },
          actual: { error: (err as Error).message },
        };
      }

      return { assertions: assert.assertions, metadata };
    },
  });

  // Test 3: Cancellation
  if (allTools.length > 0) {
    const tool = allTools[0];
    tests.push({
      id: 'edge-cases.concurrency.cancellation',
      name: 'Server handles request cancellation',
      description: `Send tool call to "${tool.name}" then immediately cancel it`,
      tags: ['edge-cases', 'concurrency'],
      requiredCapability: 'tools',
      async run(ctx: TestRunContext): Promise<TestCaseResult> {
        const assert = new AssertHelper();
        const args = buildValidArgs(tool);
        let metadata: Record<string, unknown> = {};

        try {
          // Get the next request ID that will be used
          const nextId = ctx.rawClient.nextId();

          // Start a tool call (don't await yet)
          const callPromise = ctx.rawClient.sendRequest('tools/call', {
            name: tool.name,
            arguments: args,
          }, ctx.requestTimeoutMs);

          // Immediately send cancellation
          await ctx.rawClient.sendNotification('notifications/cancelled', {
            requestId: nextId,
            reason: 'mcp-probe cancellation test',
          });

          // Wait for whatever happens
          const response = await callPromise;

          // Server should either:
          // 1. Complete normally (didn't process cancellation in time)
          // 2. Return a cancellation error
          // Either is acceptable — we just don't want a crash
          const responded = response.message !== null || response.error !== undefined;
          assert.ok(
            responded,
            'Server responded after cancellation attempt',
            responded
              ? `PASS: Server responded after cancellation was sent — did not crash or hang`
              : `FAIL: Server returned null response after cancellation — may have entered an inconsistent state`,
          );

          if (response.error) {
            assert.info('cancellation-result', `Server acknowledged cancellation — returned error: ${response.error.message}`);
          } else {
            assert.info('cancellation-result', 'Request completed despite cancellation (acceptable — server may process faster than cancellation arrives)');
          }
          metadata = {
            input: { method: 'tools/call + notifications/cancelled', params: { toolCall: { name: tool.name, arguments: args }, cancellation: { requestId: nextId, reason: 'mcp-probe cancellation test' } } },
            expected: { description: 'Server responds without crashing (may complete normally or acknowledge cancellation)' },
            actual: truncateResponse({ hasResponse: !!response.message, hasError: !!response.error, error: response.error?.message }),
          };
        } catch (err) {
          // Timeout or transport error
          const msg = (err as Error).message;
          const crashed = msg.includes('closed') || msg.includes('EPIPE');
          assert.warn(
            !crashed,
            'cancellation-no-crash',
            crashed
              ? `WARN: Server connection lost after cancellation attempt — ${msg}. The server may have crashed when processing the cancellation notification.`
              : `PASS: Server handled cancellation gracefully — ${msg}`,
          );
          metadata = {
            input: { method: 'tools/call + notifications/cancelled', params: { name: tool.name, arguments: args } },
            expected: { description: 'Server handles cancellation without crashing' },
            actual: { error: msg, connectionLost: crashed },
          };
        }

        return { assertions: assert.assertions, metadata };
      },
    });
  }

  return tests;
}
