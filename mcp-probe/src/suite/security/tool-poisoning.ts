/**
 * Tool Poisoning Tests — verify tool annotations match actual behavior.
 *
 * MCP tools can declare hints like readOnlyHint, destructiveHint,
 * and idempotentHint. This test suite cross-checks these annotations
 * against actual behavior to detect tools that may be "lying" about
 * their safety characteristics (a key MCP attack vector).
 */
import type { DiscoveredServer, DiscoveredTool } from '../../client/mcp-client.js';
import { AssertHelper, type TestCase, type TestRunContext } from '../types.js';
import { generateValidValue } from '../schema/fuzzer.js';

/**
 * Keywords that suggest a tool performs write operations.
 */
const WRITE_INDICATORS = [
  'create', 'update', 'delete', 'remove', 'modify', 'set', 'put',
  'post', 'write', 'insert', 'drop', 'alter', 'add', 'change',
  'send', 'publish', 'deploy', 'execute', 'run', 'install',
];

const READ_INDICATORS = [
  'get', 'list', 'read', 'fetch', 'search', 'find', 'query',
  'describe', 'show', 'view', 'check', 'status', 'info',
  'count', 'lookup', 'retrieve',
];

/**
 * Infer expected behavior from tool name and description.
 */
function inferToolBehavior(tool: DiscoveredTool): {
  likelyReadOnly: boolean;
  likelyDestructive: boolean;
  confidence: 'high' | 'medium' | 'low';
} {
  const text = `${tool.name} ${tool.description ?? ''}`.toLowerCase();

  const writeScore = WRITE_INDICATORS.filter((w) => text.includes(w)).length;
  const readScore = READ_INDICATORS.filter((r) => text.includes(r)).length;

  const destructiveWords = ['delete', 'remove', 'drop', 'destroy', 'purge', 'wipe', 'erase'];
  const likelyDestructive = destructiveWords.some((w) => text.includes(w));

  if (writeScore === 0 && readScore > 0) {
    return { likelyReadOnly: true, likelyDestructive: false, confidence: 'high' };
  }
  if (writeScore > 0 && readScore === 0) {
    return { likelyReadOnly: false, likelyDestructive, confidence: 'high' };
  }
  if (writeScore > readScore) {
    return { likelyReadOnly: false, likelyDestructive, confidence: 'medium' };
  }
  return { likelyReadOnly: readScore > 0, likelyDestructive: false, confidence: 'low' };
}

export function generateToolPoisoningTests(discovered: DiscoveredServer): TestCase[] {
  const tests: TestCase[] = [];

  // --- Test 1: Annotation consistency check ---
  tests.push({
    id: 'security.tool-poisoning.annotation-consistency',
    name: 'Security: Tool annotation consistency',
    description: 'Cross-checks tool annotations against inferred behavior from names/descriptions',
    tags: ['security', 'tool-poisoning'],

    async run(_ctx: TestRunContext) {
      const assert = new AssertHelper();
      const suspiciousTools: Array<{ name: string; issue: string }> = [];

      for (const tool of discovered.tools) {
        const annotations = tool.annotations;
        const inferred = inferToolBehavior(tool);

        // Check: Tool claims readOnly but name/desc suggests writes
        if (annotations?.readOnlyHint === true && !inferred.likelyReadOnly && inferred.confidence !== 'low') {
          suspiciousTools.push({
            name: tool.name,
            issue: `Claims readOnly but name/description suggests write operations (confidence: ${inferred.confidence})`,
          });
        }

        // Check: Tool doesn't declare destructive but name/desc suggests destruction
        if (annotations?.destructiveHint !== true && inferred.likelyDestructive && inferred.confidence !== 'low') {
          suspiciousTools.push({
            name: tool.name,
            issue: `Missing destructiveHint but name/description suggests destructive behavior (confidence: ${inferred.confidence})`,
          });
        }

        // Check: Tool has no annotations at all (best practice violation)
        if (!annotations || Object.keys(annotations).length === 0) {
          assert.warn(false, `Missing annotations: ${tool.name}`,
            `Tool "${tool.name}" has no safety annotations — best practice is to declare readOnlyHint/destructiveHint`);
        }
      }

      if (suspiciousTools.length === 0) {
        assert.ok(true, 'Tool annotations consistent',
          'All tool annotations are consistent with their names/descriptions');
      } else {
        for (const suspicious of suspiciousTools) {
          assert.ok(false, `Suspicious annotation: ${suspicious.name}`,
            suspicious.issue);
        }
      }

      return {
        assertions: assert.assertions,
        metadata: {
          toolCount: discovered.tools.length,
          suspiciousCount: suspiciousTools.length,
          suspicious: suspiciousTools,
        },
      };
    },
  });

  // --- Test 2: Idempotency verification ---
  const idempotentTools = discovered.tools.filter(
    (t) => t.annotations?.idempotentHint === true && t.annotations?.readOnlyHint === true,
  );

  if (idempotentTools.length > 0) {
    const tool = idempotentTools[0];
    tests.push({
      id: `security.tool-poisoning.idempotency.${tool.name}`,
      name: `Security: Idempotency verification — ${tool.name}`,
      description: `Calls idempotent tool "${tool.name}" twice and verifies consistent response`,
      tags: ['security', 'tool-poisoning', 'idempotency'],

      async run(ctx: TestRunContext) {
        const assert = new AssertHelper();
        const props = tool.inputSchema?.properties as Record<string, Record<string, unknown>> | undefined;
        const required = (tool.inputSchema?.required ?? []) as string[];
        const args: Record<string, unknown> = {};

        if (props) {
          for (const key of required) {
            args[key] = generateValidValue(props[key] ?? { type: 'string' });
          }
        }

        try {
          const trace1 = await ctx.client.callTool(tool.name, args);
          const trace2 = await ctx.client.callTool(tool.name, args);

          const response1 = JSON.stringify(trace1.response);
          const response2 = JSON.stringify(trace2.response);

          assert.ok(
            response1 === response2,
            `Idempotent tool "${tool.name}" returns consistent results`,
            response1 === response2
              ? 'Two identical calls returned identical responses'
              : 'Responses differ — tool may not be truly idempotent',
          );

          return {
            assertions: assert.assertions,
            metadata: {
              tool: tool.name,
              responsesMatch: response1 === response2,
            },
          };
        } catch (err) {
          assert.warn(false, `Idempotency test failed for "${tool.name}"`,
            `Could not verify: ${(err as Error).message}`);
          return { assertions: assert.assertions };
        }
      },
    });
  }

  // --- Test 3: Description vs schema mismatch ---
  tests.push({
    id: 'security.tool-poisoning.description-schema-mismatch',
    name: 'Security: Description vs schema alignment',
    description: 'Checks for tools where description mentions parameters not present in the schema (potential hidden functionality)',
    tags: ['security', 'tool-poisoning'],

    async run(_ctx: TestRunContext) {
      const assert = new AssertHelper();
      let mismatches = 0;

      for (const tool of discovered.tools) {
        if (!tool.description) continue;

        const props = tool.inputSchema?.properties as Record<string, unknown> | undefined;
        const paramNames = props ? Object.keys(props) : [];
        const desc = tool.description.toLowerCase();

        // Check if description mentions common param-like words not in schema
        const potentialParams = desc.match(/\b(?:file|path|url|command|query|script|code|token|key|password|host|port|database)\b/g);
        if (potentialParams) {
          for (const param of new Set(potentialParams)) {
            // Only flag if the word clearly refers to a parameter concept not in schema
            const inSchema = paramNames.some((p) => p.toLowerCase().includes(param));
            if (!inSchema && ['command', 'script', 'code', 'password', 'token'].includes(param)) {
              assert.warn(false, `Undeclared sensitive param: ${tool.name}`,
                `Description mentions "${param}" but no matching parameter in schema — potential hidden functionality`);
              mismatches++;
            }
          }
        }
      }

      if (mismatches === 0) {
        assert.ok(true, 'Description-schema alignment',
          'No suspicious mismatches between tool descriptions and schemas');
      }

      return {
        assertions: assert.assertions,
        metadata: { mismatches },
      };
    },
  });

  return tests;
}
