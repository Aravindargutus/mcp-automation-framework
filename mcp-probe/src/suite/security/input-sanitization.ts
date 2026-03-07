/**
 * Input Sanitization Tests — command injection, SSRF, path traversal.
 *
 * Sends attack payloads through tool parameters and verifies the
 * server properly sanitizes inputs without crashing or executing
 * the injected commands.
 */
import type { DiscoveredServer, DiscoveredTool } from '../../client/mcp-client.js';
import { AssertHelper, type TestCase, type TestRunContext } from '../types.js';
import {
  COMMAND_INJECTION_PAYLOADS,
  SSRF_PAYLOADS,
  PATH_TRAVERSAL_PAYLOADS,
} from './payloads.js';
import { generateValidValue } from '../schema/fuzzer.js';

/**
 * Find string parameters that might be vulnerable to injection.
 */
function findInjectableParams(tool: DiscoveredTool): Array<{ name: string; type: 'command' | 'url' | 'path' | 'general' }> {
  const props = tool.inputSchema?.properties as Record<string, Record<string, unknown>> | undefined;
  if (!props) return [];

  const results: Array<{ name: string; type: 'command' | 'url' | 'path' | 'general' }> = [];

  for (const [name, schema] of Object.entries(props)) {
    if (schema.type !== 'string') continue;

    const lower = name.toLowerCase();
    const desc = ((schema.description as string) ?? '').toLowerCase();
    const combined = `${lower} ${desc}`;

    if (combined.match(/command|cmd|exec|shell|script|run/)) {
      results.push({ name, type: 'command' });
    } else if (combined.match(/url|uri|endpoint|href|link|fetch/)) {
      results.push({ name, type: 'url' });
    } else if (combined.match(/path|file|dir|folder|location|filename/)) {
      results.push({ name, type: 'path' });
    } else {
      results.push({ name, type: 'general' });
    }
  }

  return results;
}

/**
 * Build args with all required fields filled.
 */
function buildBaseArgs(tool: DiscoveredTool): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const props = tool.inputSchema?.properties as Record<string, Record<string, unknown>> | undefined;
  const required = (tool.inputSchema?.required ?? []) as string[];

  if (!props) return args;
  for (const key of required) {
    args[key] = generateValidValue(props[key] ?? { type: 'string' });
  }
  return args;
}

/**
 * Check if response indicates successful command execution (bad).
 */
function detectCommandExecution(response: unknown): boolean {
  const text = typeof response === 'string' ? response : JSON.stringify(response ?? '');
  const executionIndicators = [
    /root:.*:0:0:/,                    // /etc/passwd content
    /\/bin\/(bash|sh|zsh)/,            // Shell paths
    /uid=\d+.*gid=\d+/,               // id command output
    /total\s+\d+\n.*drwx/,            // ls -la output
    /inet\s+\d+\.\d+\.\d+\.\d+/,     // ifconfig output
    /ami-[a-f0-9]+/,                   // AWS metadata
    /instance-id/i,                     // Cloud metadata
  ];

  return executionIndicators.some((pattern) => pattern.test(text));
}

export function generateInputSanitizationTests(discovered: DiscoveredServer): TestCase[] {
  const tests: TestCase[] = [];

  // Find tool with injectable string params
  let targetTool: DiscoveredTool | undefined;
  let injectableParams: ReturnType<typeof findInjectableParams> = [];

  for (const tool of discovered.tools) {
    const params = findInjectableParams(tool);
    if (params.length > 0) {
      targetTool = tool;
      injectableParams = params;
      break;
    }
  }

  if (!targetTool) {
    // Fall back to first tool with any string param
    targetTool = discovered.tools.find((t) => {
      const props = t.inputSchema?.properties as Record<string, Record<string, unknown>> | undefined;
      return props && Object.values(props).some((p) => p.type === 'string');
    });
    if (targetTool) {
      const props = targetTool.inputSchema?.properties as Record<string, Record<string, unknown>>;
      const firstStringParam = Object.entries(props).find(([, v]) => v.type === 'string');
      if (firstStringParam) {
        injectableParams = [{ name: firstStringParam[0], type: 'general' }];
      }
    }
  }

  if (!targetTool || injectableParams.length === 0) return tests;

  const param = injectableParams[0];
  const tool = targetTool;

  // --- Command Injection Tests ---
  for (const payload of COMMAND_INJECTION_PAYLOADS.slice(0, 3)) {
    tests.push({
      id: `security.input-sanitization.cmd.${tool.name}.${payload.label.replace(/\s+/g, '-').toLowerCase()}`,
      name: `Security: Command injection — ${payload.label}`,
      description: `Tests ${tool.name}.${param.name} for command injection via ${payload.label}`,
      tags: ['security', 'input-sanitization', 'command-injection'],

      async run(ctx: TestRunContext) {
        const assert = new AssertHelper();
        const args = buildBaseArgs(tool);
        args[param.name] = payload.value;

        try {
          const trace = await ctx.client.callTool(tool.name, args);
          const wasExecuted = detectCommandExecution(trace.response);

          assert.ok(!wasExecuted, `No command execution from "${payload.label}"`,
            wasExecuted
              ? `CRITICAL: Response indicates injected command was executed`
              : 'No evidence of command execution in response');

          return {
            assertions: assert.assertions,
            metadata: { tool: tool.name, param: param.name, payload: payload.label, wasExecuted },
          };
        } catch {
          assert.ok(true, `Server rejected "${payload.label}"`,
            'Server rejected malicious input (safe behavior)');
          return { assertions: assert.assertions };
        }
      },
    });
  }

  // --- SSRF Tests ---
  for (const payload of SSRF_PAYLOADS.slice(0, 3)) {
    tests.push({
      id: `security.input-sanitization.ssrf.${tool.name}.${payload.label.replace(/\s+/g, '-').toLowerCase()}`,
      name: `Security: SSRF — ${payload.label}`,
      description: `Tests ${tool.name}.${param.name} for SSRF via ${payload.label}`,
      tags: ['security', 'input-sanitization', 'ssrf'],

      async run(ctx: TestRunContext) {
        const assert = new AssertHelper();
        const args = buildBaseArgs(tool);
        args[param.name] = payload.value;

        try {
          const trace = await ctx.client.callTool(tool.name, args);
          const responseText = JSON.stringify(trace.response ?? '');

          // Check for cloud metadata responses
          const metadataLeaked = /ami-|instance-id|project-id|compute\.internal|169\.254\.169\.254/.test(responseText);

          assert.ok(!metadataLeaked, `No cloud metadata from "${payload.label}"`,
            metadataLeaked
              ? 'CRITICAL: Response contains cloud metadata — SSRF vulnerability detected'
              : 'No cloud metadata detected in response');

          return {
            assertions: assert.assertions,
            metadata: { tool: tool.name, payload: payload.label, metadataLeaked },
          };
        } catch {
          assert.ok(true, `Server rejected "${payload.label}"`,
            'Server rejected SSRF payload (safe behavior)');
          return { assertions: assert.assertions };
        }
      },
    });
  }

  // --- Path Traversal Tests ---
  for (const payload of PATH_TRAVERSAL_PAYLOADS.slice(0, 3)) {
    tests.push({
      id: `security.input-sanitization.path.${tool.name}.${payload.label.replace(/\s+/g, '-').toLowerCase()}`,
      name: `Security: Path traversal — ${payload.label}`,
      description: `Tests ${tool.name}.${param.name} for path traversal via ${payload.label}`,
      tags: ['security', 'input-sanitization', 'path-traversal'],

      async run(ctx: TestRunContext) {
        const assert = new AssertHelper();
        const args = buildBaseArgs(tool);
        args[param.name] = payload.value;

        try {
          const trace = await ctx.client.callTool(tool.name, args);
          const responseText = JSON.stringify(trace.response ?? '');

          // Check for typical file content from traversal
          const fileLeaked = /root:.*:0:0:|\/bin\/|REGISTRY|NTLM|SAM/.test(responseText);

          assert.ok(!fileLeaked, `No file content from "${payload.label}"`,
            fileLeaked
              ? 'CRITICAL: Response contains system file content — path traversal vulnerability'
              : 'No sensitive file content detected');

          return {
            assertions: assert.assertions,
            metadata: { tool: tool.name, payload: payload.label, fileLeaked },
          };
        } catch {
          assert.ok(true, `Server rejected "${payload.label}"`,
            'Server rejected path traversal payload (safe behavior)');
          return { assertions: assert.assertions };
        }
      },
    });
  }

  return tests;
}
