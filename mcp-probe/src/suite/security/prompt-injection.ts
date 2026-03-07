/**
 * Prompt Injection Tests — MCP-specific prompt injection payloads.
 *
 * Injects adversarial prompts into tool string arguments to test
 * whether the server blindly executes injected instructions or
 * leaks sensitive information.
 */
import type { DiscoveredServer, DiscoveredTool } from '../../client/mcp-client.js';
import { AssertHelper, type TestCase, type TestRunContext } from '../types.js';
import { PROMPT_INJECTION_PAYLOADS, CREDENTIAL_PATTERNS, SENSITIVE_KEYWORDS } from './payloads.js';

/**
 * Find the first string parameter in a tool's input schema.
 */
function findStringParam(tool: DiscoveredTool): string | null {
  const props = tool.inputSchema?.properties as Record<string, { type?: string }> | undefined;
  if (!props) return null;
  for (const [name, schema] of Object.entries(props)) {
    if (schema.type === 'string') return name;
  }
  return null;
}

/**
 * Build minimal valid args for a tool, filling required fields with safe defaults.
 */
function buildBaseArgs(tool: DiscoveredTool): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const props = tool.inputSchema?.properties as Record<string, Record<string, unknown>> | undefined;
  const required = (tool.inputSchema?.required ?? []) as string[];

  if (!props) return args;

  for (const key of required) {
    const schema = props[key] ?? { type: 'string' };
    switch (schema.type) {
      case 'string': args[key] = 'test'; break;
      case 'number': case 'integer': args[key] = 1; break;
      case 'boolean': args[key] = true; break;
      case 'array': args[key] = []; break;
      case 'object': args[key] = {}; break;
      default: args[key] = 'test';
    }
  }
  return args;
}

/**
 * Check if a response contains leaked credentials or sensitive data.
 */
function scanForLeaks(response: unknown): Array<{ label: string; severity: string }> {
  const findings: Array<{ label: string; severity: string }> = [];
  const text = typeof response === 'string' ? response : JSON.stringify(response ?? '');

  for (const { label, pattern, severity } of CREDENTIAL_PATTERNS) {
    if (pattern.test(text)) {
      findings.push({ label, severity });
    }
  }

  const lowerText = text.toLowerCase();
  for (const keyword of SENSITIVE_KEYWORDS) {
    if (lowerText.includes(keyword) && lowerText.includes('=')) {
      findings.push({ label: `Potential ${keyword} exposure`, severity: 'medium' });
    }
  }

  return findings;
}

export function generatePromptInjectionTests(discovered: DiscoveredServer): TestCase[] {
  const tests: TestCase[] = [];

  // Find a tool with at least one string parameter
  const targetTool = discovered.tools.find((t) => findStringParam(t) !== null);
  if (!targetTool) return tests;

  const stringParam = findStringParam(targetTool)!;

  for (const payload of PROMPT_INJECTION_PAYLOADS) {
    tests.push({
      id: `security.prompt-injection.${targetTool.name}.${payload.label.replace(/\s+/g, '-').toLowerCase()}`,
      name: `Security: Prompt injection — ${payload.label}`,
      description: `Injects "${payload.label}" payload into ${targetTool.name}.${stringParam} and checks for data leaks`,
      tags: ['security', 'prompt-injection'],

      async run(ctx: TestRunContext) {
        const assert = new AssertHelper();
        const args = buildBaseArgs(targetTool);
        args[stringParam] = payload.value;

        try {
          const trace = await ctx.client.callTool(targetTool.name, args);
          const responseText = JSON.stringify(trace.response ?? '');

          // Check for credential leaks in response
          const leaks = scanForLeaks(trace.response);
          assert.ok(
            leaks.filter((l) => l.severity === 'critical').length === 0,
            `No critical data leaks from "${payload.label}"`,
            leaks.length > 0
              ? `Found ${leaks.length} potential leak(s): ${leaks.map((l) => l.label).join(', ')}`
              : 'No credentials or secrets detected in response',
          );

          // Check if response contains environment variables
          const envVarPattern = /(?:PATH|HOME|USER|NODE_ENV|DATABASE_URL|API_KEY|SECRET)\s*[=:]\s*\S+/;
          assert.ok(
            !envVarPattern.test(responseText),
            `No env vars leaked from "${payload.label}"`,
            envVarPattern.test(responseText)
              ? 'Response appears to contain environment variable values'
              : 'No environment variable leakage detected',
          );

          // Warn if response is suspiciously large (may indicate data dump)
          if (responseText.length > 10000) {
            assert.warn(false, `Response size check for "${payload.label}"`,
              `Unusually large response (${responseText.length} chars) — may indicate data exfiltration`);
          }

          return {
            assertions: assert.assertions,
            metadata: {
              tool: targetTool.name,
              param: stringParam,
              payload: payload.label,
              responseLength: responseText.length,
              leaksFound: leaks,
            },
          };
        } catch (err) {
          // Server rejecting the input is acceptable (not a security failure)
          assert.ok(true, `Server handled "${payload.label}"`,
            `Server rejected/errored on injection payload (safe behavior): ${(err as Error).message}`);
          return { assertions: assert.assertions };
        }
      },
    });
  }

  return tests;
}
