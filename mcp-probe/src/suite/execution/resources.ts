/**
 * Execution Suite: Resource Read Tests
 *
 * Reads each discovered resource and validates:
 * - Response has contents array
 * - Each content item has uri and either text or blob
 * - Content type matches declared mimeType (if any)
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

export function generateResourceReadTests(discovered: DiscoveredServer): TestCase[] {
  const tests: TestCase[] = [];

  for (const resource of discovered.resources) {
    // Test 1: Resource is readable
    tests.push({
      id: `execution.resource.${resource.uri}.readable`,
      name: `Resource "${resource.name}" is readable`,
      description: 'resources/read should return valid response with contents array',
      tags: ['execution', 'resource'],
      requiredCapability: 'resources',
      async run(ctx: TestRunContext): Promise<TestCaseResult> {
        const assert = new AssertHelper();
        let metadata: Record<string, unknown> = {};

        try {
          const response = await ctx.client.readResource(resource.uri);

          if (response.error) {
            assert.ok(false, 'Resource read succeeded',
              `FAIL: Server returned error reading resource "${resource.name}" (URI: ${resource.uri}) — ${response.error.message}`,
            );
            metadata = {
              input: { method: 'resources/read', params: { uri: resource.uri } },
              expected: { description: 'Response with contents array, each having uri and text/blob' },
              actual: { error: response.error.message },
            };
            return { assertions: assert.assertions, metadata };
          }

          const msg = response.message as Record<string, unknown>;
          const result = msg?.result as Record<string, unknown>;

          if (result) {
            const contents = result.contents as Array<Record<string, unknown>> | undefined;
            assert.ok(
              Array.isArray(contents),
              'Response has contents array',
              Array.isArray(contents)
                ? `PASS: Resource returned contents array with ${contents.length} item(s)`
                : `FAIL: Response missing "contents" array — resources/read must return { contents: [...] }`,
            );

            if (contents && contents.length > 0) {
              for (let i = 0; i < contents.length; i++) {
                const item = contents[i];
                assert.ok(
                  typeof item.uri === 'string',
                  `contents[${i}] has uri`,
                  typeof item.uri === 'string'
                    ? `PASS: contents[${i}].uri = "${item.uri}"`
                    : `FAIL: contents[${i}] missing "uri" string field — each content item must include the resource URI`,
                );
                const hasTextOrBlob = typeof item.text === 'string' || typeof item.blob === 'string';
                assert.ok(
                  hasTextOrBlob,
                  `contents[${i}] has text or blob`,
                  hasTextOrBlob
                    ? `PASS: contents[${i}] has ${typeof item.text === 'string' ? 'text' : 'blob'} content`
                    : `FAIL: contents[${i}] missing both "text" and "blob" fields — each content item must have one`,
                );
              }
            }

            assert.info('content-count', `${contents?.length ?? 0} content items returned`);
          } else {
            assert.ok(false, 'Resource read returned result',
              `FAIL: resources/read response has no "result" object — the server may have returned an empty or malformed response`,
            );
          }
          metadata = {
            input: { method: 'resources/read', params: { uri: resource.uri } },
            expected: { description: 'Response with contents array, each having uri and text/blob' },
            actual: truncateResponse(response.message),
          };
        } catch (err) {
          assert.ok(false, 'Resource read completed',
            `FAIL: Transport error reading resource "${resource.name}" — ${(err as Error).message}. The server may have crashed.`,
          );
          metadata = {
            input: { method: 'resources/read', params: { uri: resource.uri } },
            expected: { description: 'Response with contents array, each having uri and text/blob' },
            actual: { error: (err as Error).message },
          };
        }

        return { assertions: assert.assertions, metadata };
      },
    });

    // Test 2: Content type matches mimeType
    if (resource.mimeType) {
      tests.push({
        id: `execution.resource.${resource.uri}.content-type`,
        name: `Resource "${resource.name}" content matches declared mimeType`,
        description: `Declared mimeType: ${resource.mimeType}`,
        tags: ['execution', 'resource'],
        requiredCapability: 'resources',
        async run(ctx: TestRunContext): Promise<TestCaseResult> {
          const assert = new AssertHelper();
          let metadata: Record<string, unknown> = {};

          try {
            const response = await ctx.client.readResource(resource.uri);
            const msg = response.message as Record<string, unknown>;
            const result = msg?.result as Record<string, unknown>;
            const contents = result?.contents as Array<Record<string, unknown>> | undefined;

            if (contents && contents.length > 0) {
              const item = contents[0];
              if (item.mimeType) {
                assert.equal(item.mimeType, resource.mimeType, 'Content mimeType matches declared mimeType');
              } else {
                assert.info('no-content-mimetype', `Content item does not declare mimeType — resource declared "${resource.mimeType}" but content omits it`);
              }

              // text/* mimeTypes should use text field, not blob
              if (resource.mimeType && resource.mimeType.startsWith('text/')) {
                assert.warn(
                  typeof item.text === 'string',
                  'text-mime-uses-text',
                  typeof item.text === 'string'
                    ? `PASS: text/* resource correctly uses "text" field`
                    : `WARN: Resource declares mimeType "${resource.mimeType}" but content uses "blob" instead of "text" — text/* types should use the text field`,
                );
              }
            }
            metadata = {
              input: { method: 'resources/read', params: { uri: resource.uri } },
              expected: { description: `Content mimeType matches declared "${resource.mimeType}"` },
              actual: truncateResponse(response.message),
            };
          } catch (err) {
            assert.ok(false, 'Resource read completed',
              `FAIL: Transport error reading resource "${resource.name}" — ${(err as Error).message}`,
            );
            metadata = {
              input: { method: 'resources/read', params: { uri: resource.uri } },
              expected: { description: `Content mimeType matches declared "${resource.mimeType}"` },
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
