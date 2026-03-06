/**
 * Execution Suite: Prompt Get Tests
 *
 * Calls prompts/get for each prompt and validates:
 * - Response has messages array
 * - Each message has role and content
 * - Roles are valid (user or assistant)
 */
import type { TestCase, TestRunContext, TestCaseResult } from '../types.js';
import { AssertHelper } from '../types.js';
import type { DiscoveredServer } from '../../client/mcp-client.js';

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

export function generatePromptGetTests(discovered: DiscoveredServer): TestCase[] {
  const tests: TestCase[] = [];

  for (const prompt of discovered.prompts) {
    // Build required args
    const requiredArgs: Record<string, string> = {};
    if (prompt.arguments) {
      for (const arg of prompt.arguments) {
        if (arg.required) {
          requiredArgs[arg.name] = 'test-value';
        }
      }
    }

    // Test 1: Get returns messages
    tests.push({
      id: `execution.prompt.${prompt.name}.get-returns-messages`,
      name: `Prompt "${prompt.name}" returns messages`,
      description: 'prompts/get should return a messages array',
      tags: ['execution', 'prompt'],
      requiredCapability: 'prompts',
      async run(ctx: TestRunContext): Promise<TestCaseResult> {
        const assert = new AssertHelper();
        let metadata: Record<string, unknown> = {};

        try {
          const response = await ctx.client.getPrompt(prompt.name, requiredArgs);

          if (response.error) {
            assert.ok(false, 'Prompt get succeeded',
              `FAIL: Server returned error for prompt "${prompt.name}" — ${response.error.message}`,
            );
            metadata = {
              input: { method: 'prompts/get', params: { name: prompt.name, arguments: requiredArgs } },
              expected: { description: 'Response with messages array, each having role and content' },
              actual: { error: response.error.message },
            };
            return { assertions: assert.assertions, metadata };
          }

          const msg = response.message as Record<string, unknown>;
          const result = msg?.result as Record<string, unknown>;

          if (result) {
            const messages = result.messages as Array<Record<string, unknown>> | undefined;
            assert.ok(
              Array.isArray(messages),
              'Response has messages array',
              Array.isArray(messages)
                ? `PASS: Prompt returned ${messages.length} message(s)`
                : `FAIL: Response missing "messages" array — prompts/get must return { messages: [...] }`,
            );

            if (messages && messages.length > 0) {
              for (let i = 0; i < messages.length; i++) {
                const message = messages[i];
                assert.ok(
                  typeof message.role === 'string',
                  `messages[${i}] has role`,
                  typeof message.role === 'string'
                    ? `PASS: messages[${i}].role = "${message.role}"`
                    : `FAIL: messages[${i}] missing "role" field — each message must have role "user" or "assistant"`,
                );
                assert.ok(
                  message.content !== undefined,
                  `messages[${i}] has content`,
                  message.content !== undefined
                    ? `PASS: messages[${i}] has content (type: ${typeof message.content})`
                    : `FAIL: messages[${i}] missing "content" field — each message must include content`,
                );
              }
            }

            assert.info('message-count', `${messages?.length ?? 0} messages returned`);
          } else {
            assert.ok(false, 'Prompt get returned result',
              `FAIL: prompts/get response has no "result" object — the server returned an empty or malformed response`,
            );
          }
          metadata = {
            input: { method: 'prompts/get', params: { name: prompt.name, arguments: requiredArgs } },
            expected: { description: 'Response with messages array, each having role and content' },
            actual: truncateResponse(response.message),
          };
        } catch (err) {
          assert.ok(false, 'Prompt get completed',
            `FAIL: Transport error getting prompt "${prompt.name}" — ${(err as Error).message}. The server may have crashed.`,
          );
          metadata = {
            input: { method: 'prompts/get', params: { name: prompt.name, arguments: requiredArgs } },
            expected: { description: 'Response with messages array, each having role and content' },
            actual: { error: (err as Error).message },
          };
        }

        return { assertions: assert.assertions, metadata };
      },
    });

    // Test 2: Message roles are valid
    tests.push({
      id: `execution.prompt.${prompt.name}.message-roles`,
      name: `Prompt "${prompt.name}" has valid message roles`,
      description: 'Each message should have role "user" or "assistant"',
      tags: ['execution', 'prompt'],
      requiredCapability: 'prompts',
      async run(ctx: TestRunContext): Promise<TestCaseResult> {
        const assert = new AssertHelper();
        const validRoles = ['user', 'assistant'];
        let metadata: Record<string, unknown> = {};

        try {
          const response = await ctx.client.getPrompt(prompt.name, requiredArgs);
          const msg = response.message as Record<string, unknown>;
          const result = msg?.result as Record<string, unknown>;
          const messages = result?.messages as Array<Record<string, unknown>> | undefined;

          if (messages) {
            for (let i = 0; i < messages.length; i++) {
              const role = messages[i].role as string;
              const isValid = validRoles.includes(role);
              assert.ok(
                isValid,
                `messages[${i}].role is valid`,
                isValid
                  ? `PASS: messages[${i}].role = "${role}" (valid MCP role)`
                  : `FAIL: messages[${i}].role = "${role}" — expected "user" or "assistant". Invalid roles may cause client-side errors.`,
              );
            }
          }
          metadata = {
            input: { method: 'prompts/get', params: { name: prompt.name, arguments: requiredArgs } },
            expected: { description: 'Each message role is "user" or "assistant"' },
            actual: truncateResponse({ roles: messages?.map((m) => m.role) }),
          };
        } catch (err) {
          assert.ok(false, 'Prompt get completed',
            `FAIL: Transport error getting prompt "${prompt.name}" — ${(err as Error).message}`,
          );
          metadata = {
            input: { method: 'prompts/get', params: { name: prompt.name, arguments: requiredArgs } },
            expected: { description: 'Each message role is "user" or "assistant"' },
            actual: { error: (err as Error).message },
          };
        }

        return { assertions: assert.assertions, metadata };
      },
    });
  }

  return tests;
}
