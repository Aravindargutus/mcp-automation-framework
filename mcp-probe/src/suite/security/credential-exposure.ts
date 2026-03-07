/**
 * Credential Exposure Tests — scan tool responses for leaked secrets.
 *
 * Calls each tool with valid inputs and scans the response for
 * AWS keys, JWTs, connection strings, stack traces, and other
 * sensitive data that should never appear in tool output.
 */
import type { DiscoveredServer, DiscoveredTool } from '../../client/mcp-client.js';
import { AssertHelper, type TestCase, type TestRunContext } from '../types.js';
import { CREDENTIAL_PATTERNS } from './payloads.js';
import { generateValidValue } from '../schema/fuzzer.js';

/**
 * Build valid arguments for a tool using its schema.
 */
function buildValidArgs(tool: DiscoveredTool): Record<string, unknown> {
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
 * Deep scan response for credential patterns.
 */
function deepScanResponse(response: unknown): Array<{
  label: string;
  severity: 'critical' | 'high' | 'medium';
  match: string;
}> {
  const findings: Array<{ label: string; severity: 'critical' | 'high' | 'medium'; match: string }> = [];
  const text = typeof response === 'string' ? response : JSON.stringify(response ?? '');

  for (const { label, pattern, severity } of CREDENTIAL_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      // Redact the actual value for safety
      const redacted = match[0].length > 8
        ? match[0].slice(0, 4) + '***' + match[0].slice(-4)
        : '***';
      findings.push({ label, severity, match: redacted });
    }
  }

  return findings;
}

export function generateCredentialExposureTests(discovered: DiscoveredServer): TestCase[] {
  const tests: TestCase[] = [];

  // Test up to 5 tools to keep test count manageable
  const toolsToTest = discovered.tools.slice(0, 5);

  for (const tool of toolsToTest) {
    tests.push({
      id: `security.credential-exposure.${tool.name}`,
      name: `Security: Credential scan — ${tool.name}`,
      description: `Calls ${tool.name} with valid inputs and scans response for leaked credentials`,
      tags: ['security', 'credential-exposure'],

      async run(ctx: TestRunContext) {
        const assert = new AssertHelper();
        const args = buildValidArgs(tool);

        try {
          const trace = await ctx.client.callTool(tool.name, args);
          const findings = deepScanResponse(trace.response);

          const criticalFindings = findings.filter((f) => f.severity === 'critical');
          const highFindings = findings.filter((f) => f.severity === 'high');
          const mediumFindings = findings.filter((f) => f.severity === 'medium');

          // Critical: AWS keys, JWTs, private keys, connection strings
          assert.ok(
            criticalFindings.length === 0,
            `No critical credentials in ${tool.name} response`,
            criticalFindings.length > 0
              ? `CRITICAL: Found ${criticalFindings.map((f) => `${f.label} (${f.match})`).join(', ')}`
              : 'No critical credentials detected',
          );

          // High: API keys, bearer tokens, passwords
          if (highFindings.length > 0) {
            assert.warn(false, `High-severity credential check — ${tool.name}`,
              `Found: ${highFindings.map((f) => f.label).join(', ')}`);
          }

          // Medium: Stack traces, internal paths
          if (mediumFindings.length > 0) {
            assert.warn(false, `Info disclosure check — ${tool.name}`,
              `Found: ${mediumFindings.map((f) => f.label).join(', ')}`);
          }

          if (findings.length === 0) {
            assert.info(`${tool.name}-clean`, `${tool.name}: No credential exposure detected`);
          }

          return {
            assertions: assert.assertions,
            metadata: {
              tool: tool.name,
              findingsCount: findings.length,
              findings: findings.map((f) => ({ label: f.label, severity: f.severity })),
            },
          };
        } catch (err) {
          assert.info(`${tool.name}-error`,
            `${tool.name}: Tool call failed (${(err as Error).message}) — not a security concern`);
          return { assertions: assert.assertions };
        }
      },
    });
  }

  return tests;
}
