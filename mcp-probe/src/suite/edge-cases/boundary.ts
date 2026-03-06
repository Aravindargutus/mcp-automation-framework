/**
 * Edge Cases Suite: Boundary Tests
 *
 * Tests boundary conditions:
 * - Empty args, unicode, large inputs, special chars
 * - Extra unknown fields in arguments
 * - Duplicate tool calls (idempotency)
 * - Rapid ping burst
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

function findToolWithStringParam(tools: DiscoveredTool[]): { tool: DiscoveredTool; paramName: string } | null {
  for (const tool of tools) {
    const properties = (tool.inputSchema?.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const [key, schema] of Object.entries(properties)) {
      if (schema.type === 'string') {
        return { tool, paramName: key };
      }
    }
  }
  return null;
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

export function generateBoundaryTests(discovered: DiscoveredServer, _serverConfig: ServerConfig): TestCase[] {
  const tests: TestCase[] = [];
  const allTools = discovered.tools;

  if (allTools.length === 0) return tests;

  const firstTool = allTools[0];
  const toolWithString = findToolWithStringParam(allTools);

  // Test 1: Empty tool args
  tests.push({
    id: 'edge-cases.boundary.empty-tool-args',
    name: 'Server handles empty tool args',
    description: `Calling "${firstTool.name}" with empty object`,
    tags: ['edge-cases', 'boundary'],
    requiredCapability: 'tools',
    async run(ctx: TestRunContext): Promise<TestCaseResult> {
      const assert = new AssertHelper();
      const required = (firstTool.inputSchema?.required ?? []) as string[];
      let metadata: Record<string, unknown> = {};

      try {
        const trace = await ctx.client.callTool(firstTool.name, {});

        if (required.length === 0) {
          assert.ok(
            !trace.isError,
            'Tool with no required fields accepts empty args',
            !trace.isError
              ? `PASS: Tool "${firstTool.name}" has no required fields and accepted empty args as expected`
              : `FAIL: Tool "${firstTool.name}" has no required fields but returned isError=true for empty args — should accept {}`,
          );
        } else {
          const handled = trace.isError || trace.response !== undefined;
          assert.ok(
            handled,
            'Server handled empty args gracefully',
            handled
              ? `PASS: Server handled empty args for "${firstTool.name}" without crashing — returned ${trace.isError ? 'error (expected, has required fields)' : 'response'}`
              : `FAIL: Server returned neither error nor response when "${firstTool.name}" received empty args`,
          );
        }
        metadata = {
          input: { method: 'tools/call', params: { name: firstTool.name, arguments: {} } },
          expected: { description: required.length === 0 ? 'Success (no required fields)' : 'Graceful error (has required fields)' },
          actual: truncateResponse({ isError: trace.isError, response: trace.response }),
        };
      } catch (err) {
        assert.ok(false, 'Server did not crash on empty args',
          `FAIL: Server crashed when "${firstTool.name}" was called with {} — ${(err as Error).message}. Should handle gracefully even with missing fields.`,
        );
        metadata = {
          input: { method: 'tools/call', params: { name: firstTool.name, arguments: {} } },
          expected: { description: 'Graceful handling without crash' },
          actual: { error: (err as Error).message },
        };
      }

      return { assertions: assert.assertions, metadata };
    },
  });

  // Test 2: Unicode strings
  if (toolWithString) {
    const { tool, paramName } = toolWithString;
    tests.push({
      id: 'edge-cases.boundary.unicode-strings',
      name: 'Server handles unicode string inputs',
      description: `Passing unicode (emoji, CJK, RTL) to "${tool.name}.${paramName}"`,
      tags: ['edge-cases', 'boundary'],
      requiredCapability: 'tools',
      async run(ctx: TestRunContext): Promise<TestCaseResult> {
        const assert = new AssertHelper();
        const args = buildValidArgs(tool);
        args[paramName] = '测试 🎉 テスト مرحبا 한국어 Ñoño';
        let metadata: Record<string, unknown> = {};

        try {
          const trace = await ctx.client.callTool(tool.name, args);
          const handled = trace.isError || trace.response !== undefined;
          assert.ok(
            handled,
            'Server handled unicode input without crash',
            handled
              ? `PASS: Server processed unicode input for "${tool.name}.${paramName}" without crashing`
              : `FAIL: Server returned neither error nor response for unicode input — may indicate a parsing issue`,
          );
          assert.info('behavior', trace.isError
            ? `Server returned error for unicode input (acceptable — may not support multi-script strings)`
            : `Server accepted unicode input successfully (emoji, CJK, RTL, accented chars)`,
          );
          metadata = {
            input: { method: 'tools/call', params: { name: tool.name, arguments: args } },
            expected: { description: 'Graceful handling of unicode characters (emoji, CJK, RTL, accented)' },
            actual: truncateResponse({ isError: trace.isError, response: trace.response }),
          };
        } catch (err) {
          assert.ok(false, 'Server did not crash on unicode input',
            `FAIL: Server crashed when "${tool.name}.${paramName}" received unicode characters — ${(err as Error).message}. Should handle gracefully.`,
          );
          metadata = {
            input: { method: 'tools/call', params: { name: tool.name, arguments: args } },
            expected: { description: 'Graceful handling of unicode characters' },
            actual: { error: (err as Error).message },
          };
        }

        return { assertions: assert.assertions, metadata };
      },
    });
  }

  // Test 3: Large input
  if (toolWithString) {
    const { tool, paramName } = toolWithString;
    tests.push({
      id: 'edge-cases.boundary.large-input',
      name: 'Server handles large string input',
      description: `Passing 10KB string to "${tool.name}.${paramName}"`,
      tags: ['edge-cases', 'boundary'],
      requiredCapability: 'tools',
      async run(ctx: TestRunContext): Promise<TestCaseResult> {
        const assert = new AssertHelper();
        const args = buildValidArgs(tool);
        args[paramName] = 'x'.repeat(10_000);
        let metadata: Record<string, unknown> = {};

        try {
          const trace = await ctx.client.callTool(tool.name, args);
          const handled = trace.isError || trace.response !== undefined;
          assert.ok(
            handled,
            'Server handled large input without crash',
            handled
              ? `PASS: Server processed 10KB string input for "${tool.name}.${paramName}" without crashing`
              : `FAIL: Server returned neither error nor response for 10KB input — may indicate buffer/memory issue`,
          );
          assert.info('behavior', trace.isError
            ? `Server returned error for large input (acceptable — may enforce size limits)`
            : `Server accepted 10KB input successfully`,
          );
          assert.info('response-time', `${trace.durationMs}ms`);
          metadata = {
            input: { method: 'tools/call', params: { name: tool.name, arguments: { [paramName]: '(10KB string: "x" repeated 10000 times)', ...Object.fromEntries(Object.entries(args).filter(([k]) => k !== paramName)) } } },
            expected: { description: 'Graceful handling of 10KB string input' },
            actual: truncateResponse({ isError: trace.isError, durationMs: trace.durationMs, response: trace.response }),
          };
        } catch (err) {
          assert.ok(false, 'Server did not crash on large input',
            `FAIL: Server crashed when "${tool.name}.${paramName}" received 10KB string — ${(err as Error).message}. Should return error or handle gracefully.`,
          );
          metadata = {
            input: { method: 'tools/call', params: { name: tool.name, arguments: { [paramName]: '(10KB string)' } } },
            expected: { description: 'Graceful handling of 10KB string input' },
            actual: { error: (err as Error).message },
          };
        }

        return { assertions: assert.assertions, metadata };
      },
    });
  }

  // Test 4: Special characters
  if (toolWithString) {
    const { tool, paramName } = toolWithString;
    tests.push({
      id: 'edge-cases.boundary.special-chars',
      name: 'Server handles special characters in args',
      description: `Passing control characters (\\n, \\t, \\r, \\0) to "${tool.name}.${paramName}"`,
      tags: ['edge-cases', 'boundary'],
      requiredCapability: 'tools',
      async run(ctx: TestRunContext): Promise<TestCaseResult> {
        const assert = new AssertHelper();
        const args = buildValidArgs(tool);
        args[paramName] = 'line1\nline2\ttab\r\nwindows\x00null';
        let metadata: Record<string, unknown> = {};

        try {
          const trace = await ctx.client.callTool(tool.name, args);
          const handled = trace.isError || trace.response !== undefined;
          assert.ok(
            handled,
            'Server handled special characters without crash',
            handled
              ? `PASS: Server processed control characters (newline, tab, carriage return, null byte) without crashing`
              : `FAIL: Server returned neither error nor response for special character input`,
          );
          metadata = {
            input: { method: 'tools/call', params: { name: tool.name, arguments: args } },
            expected: { description: 'Graceful handling of control characters (\\n, \\t, \\r, \\0)' },
            actual: truncateResponse({ isError: trace.isError, response: trace.response }),
          };
        } catch (err) {
          assert.ok(false, 'Server did not crash on special characters',
            `FAIL: Server crashed when "${tool.name}.${paramName}" received control characters — ${(err as Error).message}. Null bytes or newlines may cause parsing issues.`,
          );
          metadata = {
            input: { method: 'tools/call', params: { name: tool.name, arguments: args } },
            expected: { description: 'Graceful handling of control characters' },
            actual: { error: (err as Error).message },
          };
        }

        return { assertions: assert.assertions, metadata };
      },
    });
  }

  // Test 5: Extra unknown fields
  tests.push({
    id: 'edge-cases.boundary.extra-unknown-fields',
    name: 'Server handles extra unknown fields in args',
    description: `Passing extra undeclared fields to "${firstTool.name}"`,
    tags: ['edge-cases', 'boundary'],
    requiredCapability: 'tools',
    async run(ctx: TestRunContext): Promise<TestCaseResult> {
      const assert = new AssertHelper();
      const args = buildValidArgs(firstTool);
      args['__unknown_extra_field__'] = 'should-be-ignored';
      args['__another_unknown__'] = 42;
      let metadata: Record<string, unknown> = {};

      try {
        const trace = await ctx.client.callTool(firstTool.name, args);
        const handled = trace.isError || trace.response !== undefined;
        assert.ok(
          handled,
          'Server handled extra fields without crash',
          handled
            ? `PASS: Server processed request with extra undeclared fields without crashing`
            : `FAIL: Server returned neither error nor response when extra unknown fields were included`,
        );
        assert.warn(
          !trace.isError,
          'extra-fields-accepted',
          !trace.isError
            ? `PASS: Server correctly ignored unknown fields per MCP spec — additional properties should not cause errors`
            : `WARN: Server returned error when extra fields were included — MCP spec recommends servers ignore unknown fields`,
        );
        metadata = {
          input: { method: 'tools/call', params: { name: firstTool.name, arguments: args } },
          expected: { description: 'Server ignores extra unknown fields (MCP spec recommendation)' },
          actual: truncateResponse({ isError: trace.isError, response: trace.response }),
        };
      } catch (err) {
        assert.ok(false, 'Server did not crash on extra fields',
          `FAIL: Server crashed when "${firstTool.name}" received extra undeclared fields — ${(err as Error).message}`,
        );
        metadata = {
          input: { method: 'tools/call', params: { name: firstTool.name, arguments: args } },
          expected: { description: 'Server ignores extra unknown fields' },
          actual: { error: (err as Error).message },
        };
      }

      return { assertions: assert.assertions, metadata };
    },
  });

  // Test 6: Duplicate tool call (idempotency check)
  tests.push({
    id: 'edge-cases.boundary.duplicate-tool-call',
    name: 'Duplicate tool call returns consistent results',
    description: `Calling "${firstTool.name}" twice with identical args`,
    tags: ['edge-cases', 'boundary'],
    requiredCapability: 'tools',
    async run(ctx: TestRunContext): Promise<TestCaseResult> {
      const assert = new AssertHelper();
      const args = buildValidArgs(firstTool);
      let metadata: Record<string, unknown> = {};

      try {
        const trace1 = await ctx.client.callTool(firstTool.name, args);
        const trace2 = await ctx.client.callTool(firstTool.name, args);

        const sameErrorStatus = trace1.isError === trace2.isError;
        assert.ok(
          sameErrorStatus,
          'Both calls have same isError status',
          sameErrorStatus
            ? `PASS: Both calls returned isError=${trace1.isError} — consistent behavior`
            : `FAIL: Call 1 returned isError=${trace1.isError} but Call 2 returned isError=${trace2.isError} — inconsistent behavior for identical requests`,
        );

        // Check structural consistency
        const r1 = trace1.response as Record<string, unknown> | undefined;
        const r2 = trace2.response as Record<string, unknown> | undefined;
        if (r1 && r2) {
          const keys1 = Object.keys(r1).sort().join(',');
          const keys2 = Object.keys(r2).sort().join(',');
          const sameStructure = keys1 === keys2;
          assert.ok(
            sameStructure,
            'Both responses have same structure',
            sameStructure
              ? `PASS: Both responses have identical structure — keys: [${keys1}]`
              : `FAIL: Response structures differ — Call 1 keys: [${keys1}], Call 2 keys: [${keys2}]`,
          );
        }

        assert.info('timing', `Call 1: ${trace1.durationMs}ms, Call 2: ${trace2.durationMs}ms`);
        metadata = {
          input: { method: 'tools/call', params: { name: firstTool.name, arguments: args }, note: 'Called twice with identical args' },
          expected: { description: 'Both calls return consistent isError status and response structure' },
          actual: { call1: truncateResponse({ isError: trace1.isError, durationMs: trace1.durationMs, response: trace1.response }), call2: truncateResponse({ isError: trace2.isError, durationMs: trace2.durationMs, response: trace2.response }) },
        };
      } catch (err) {
        assert.ok(false, 'Duplicate calls completed',
          `FAIL: Server crashed during duplicate tool calls to "${firstTool.name}" — ${(err as Error).message}`,
        );
        metadata = {
          input: { method: 'tools/call', params: { name: firstTool.name, arguments: args }, note: 'Called twice with identical args' },
          expected: { description: 'Both calls return consistent results' },
          actual: { error: (err as Error).message },
        };
      }

      return { assertions: assert.assertions, metadata };
    },
  });

  // Test 7: Rapid ping burst
  tests.push({
    id: 'edge-cases.boundary.rapid-ping',
    name: 'Server handles rapid ping burst',
    description: 'Send 5 pings in quick succession',
    tags: ['edge-cases', 'boundary'],
    async run(ctx: TestRunContext): Promise<TestCaseResult> {
      const assert = new AssertHelper();
      let metadata: Record<string, unknown> = {};

      try {
        const results = await Promise.all([
          ctx.client.ping(),
          ctx.client.ping(),
          ctx.client.ping(),
          ctx.client.ping(),
          ctx.client.ping(),
        ]);

        const successful = results.filter((r) => !r.error).length;
        assert.ok(
          successful === 5,
          `All 5 pings responded (got ${successful}/5)`,
          successful === 5
            ? `PASS: All 5 concurrent pings returned successfully — server handles burst traffic well`
            : `FAIL: Only ${successful}/5 pings succeeded — server may be dropping requests under concurrent load or rate-limiting`,
        );
        assert.info('ping-times', results.map((r) => `${r.durationMs}ms`).join(', '));
        metadata = {
          input: { method: 'ping', params: { count: 5, mode: 'concurrent' } },
          expected: { description: 'All 5 pings return successfully' },
          actual: { successful, total: 5, timings: results.map((r) => ({ durationMs: r.durationMs, error: r.error?.message })) },
        };
      } catch (err) {
        assert.ok(false, 'Rapid ping burst completed',
          `FAIL: Server crashed during rapid ping burst — ${(err as Error).message}. The server should handle concurrent pings gracefully.`,
        );
        metadata = {
          input: { method: 'ping', params: { count: 5, mode: 'concurrent' } },
          expected: { description: 'All 5 pings return successfully' },
          actual: { error: (err as Error).message },
        };
      }

      return { assertions: assert.assertions, metadata };
    },
  });

  return tests;
}
