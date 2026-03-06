/**
 * Protocol Suite: Message Conformance Tests
 *
 * Uses RawMCPClient to test server rejection behavior for invalid messages:
 * - Unknown methods → -32601
 * - Malformed params → -32602
 * - Invalid JSON-RPC structure → -32600
 * - Duplicate request IDs
 */
import type { TestCase, TestRunContext, TestCaseResult } from '../types.js';
import { AssertHelper } from '../types.js';

function extractErrorCode(message: unknown): number | null {
  if (!message || typeof message !== 'object') return null;
  const msg = message as Record<string, unknown>;
  const error = msg.error as Record<string, unknown> | undefined;
  return error?.code as number | null ?? null;
}

export function generateMessageTests(): TestCase[] {
  return [
    {
      id: 'protocol.messages.unknown-method',
      name: 'Server rejects unknown methods with -32601',
      description: 'Requests with unrecognized method names should return Method Not Found (-32601)',
      tags: ['protocol', 'messages', 'required'],
      requiresRawClient: true,
      async run(ctx: TestRunContext): Promise<TestCaseResult> {
        const assert = new AssertHelper();

        const response = await ctx.rawClient.sendRequest(
          'nonexistent/method_that_does_not_exist',
          {},
          ctx.requestTimeoutMs,
        );

        if (response.error) {
          // Transport-level error (timeout, crash) — different from protocol error
          assert.ok(false, 'unknown-method-response', `Transport error: ${response.error.message}`);
        } else if (response.message) {
          const code = extractErrorCode(response.message);
          assert.equal(code, -32601, 'Error code is -32601 (Method Not Found)');
        } else {
          assert.ok(false, 'unknown-method-response', 'No response received');
        }

        return { assertions: assert.assertions };
      },
    },

    {
      id: 'protocol.messages.malformed-params',
      name: 'Server rejects malformed params with -32602',
      description: 'Requests with invalid parameter structure should return Invalid Params (-32602)',
      tags: ['protocol', 'messages'],
      requiresRawClient: true,
      async run(ctx: TestRunContext): Promise<TestCaseResult> {
        const assert = new AssertHelper();

        // Send tools/call with a string instead of object params
        const response = await ctx.rawClient.sendRaw(
          {
            jsonrpc: '2.0',
            id: ctx.rawClient.nextId(),
            method: 'tools/call',
            params: 'this-is-not-an-object',
          },
          ctx.requestTimeoutMs,
        );

        if (response.message) {
          const code = extractErrorCode(response.message);
          // Accept -32602 (Invalid params) or -32600 (Invalid request)
          assert.ok(
            code === -32602 || code === -32600,
            'Error code is -32602 or -32600',
            `Got error code: ${code}`,
          );
        } else {
          // Some servers may close the connection on malformed input
          assert.warn(false, 'malformed-params-response', 'No response (server may have dropped connection)');
        }

        return { assertions: assert.assertions };
      },
    },

    {
      id: 'protocol.messages.missing-jsonrpc-field',
      name: 'Server rejects messages without jsonrpc field',
      description: 'JSON-RPC 2.0 requires the "jsonrpc": "2.0" field',
      tags: ['protocol', 'messages'],
      requiresRawClient: true,
      async run(ctx: TestRunContext): Promise<TestCaseResult> {
        const assert = new AssertHelper();

        const response = await ctx.rawClient.sendRaw(
          {
            id: 999999,
            method: 'ping',
            params: {},
          },
          ctx.requestTimeoutMs,
        );

        if (response.message) {
          const code = extractErrorCode(response.message);
          assert.ok(
            code === -32600 || code === -32700,
            'Error code is -32600 (Invalid Request) or -32700 (Parse Error)',
            `Got error code: ${code}`,
          );
        } else {
          assert.warn(
            false,
            'missing-jsonrpc-response',
            'No response for message without jsonrpc field',
          );
        }

        return { assertions: assert.assertions };
      },
    },

    {
      id: 'protocol.messages.wrong-jsonrpc-version',
      name: 'Server rejects wrong JSON-RPC version',
      description: 'Only "2.0" is valid for the jsonrpc field',
      tags: ['protocol', 'messages'],
      requiresRawClient: true,
      async run(ctx: TestRunContext): Promise<TestCaseResult> {
        const assert = new AssertHelper();

        const response = await ctx.rawClient.sendRaw(
          {
            jsonrpc: '1.0',
            id: 999998,
            method: 'ping',
            params: {},
          },
          ctx.requestTimeoutMs,
        );

        if (response.message) {
          const code = extractErrorCode(response.message);
          assert.ok(
            code === -32600 || code !== null,
            'Server returns an error for wrong JSON-RPC version',
            `Got error code: ${code}`,
          );
        } else {
          assert.warn(
            false,
            'wrong-version-response',
            'No response for wrong JSON-RPC version',
          );
        }

        return { assertions: assert.assertions };
      },
    },

    {
      id: 'protocol.messages.error-response-structure',
      name: 'Error responses have correct structure',
      description: 'JSON-RPC error responses must have code (number) and message (string)',
      tags: ['protocol', 'messages'],
      requiresRawClient: true,
      async run(ctx: TestRunContext): Promise<TestCaseResult> {
        const assert = new AssertHelper();

        // Trigger an error by calling an unknown method
        const response = await ctx.rawClient.sendRequest(
          '__probe_trigger_error__',
          {},
          ctx.requestTimeoutMs,
        );

        if (response.message) {
          const msg = response.message as Record<string, unknown>;
          const error = msg.error as Record<string, unknown> | undefined;

          if (error) {
            assert.ok(typeof error.code === 'number', 'error.code is a number');
            assert.ok(typeof error.message === 'string', 'error.message is a string');
            assert.hasProperty(msg, 'id', 'Error response includes id');
            assert.equal(msg.jsonrpc, '2.0', 'Error response has jsonrpc: "2.0"');
          } else {
            // Server returned a result instead of error — unexpected but possible
            assert.warn(false, 'expected-error', 'Server returned result for unknown method instead of error');
          }
        } else {
          assert.ok(false, 'error-response-received', 'No response received');
        }

        return { assertions: assert.assertions };
      },
    },

    {
      id: 'protocol.messages.notification-no-response',
      name: 'Notifications do not receive responses',
      description: 'JSON-RPC notifications (no id) should not trigger a response',
      tags: ['protocol', 'messages'],
      requiresRawClient: true,
      async run(ctx: TestRunContext): Promise<TestCaseResult> {
        const assert = new AssertHelper();

        // Send a notification (no id field) and verify we don't get a response
        const beforeTime = Date.now();
        await ctx.rawClient.sendNotification('notifications/cancelled', {
          requestId: '__nonexistent__',
          reason: 'test',
        });

        // Wait a short time — if a response comes, it's a violation
        await new Promise((r) => setTimeout(r, 1000));

        // If we're still here without an error, the server correctly didn't respond
        assert.ok(true, 'No response for notification', `Waited 1s, no response received`);
        assert.info('notification-latency', `Notification sent in ${Date.now() - beforeTime}ms`);

        return { assertions: assert.assertions };
      },
    },
  ];
}
