/**
 * Latency Tests — measure P50/P95/P99 latency for each read-only tool.
 *
 * Calls each tool N times and computes percentile latencies.
 * Only targets tools marked as readOnlyHint=true (safe to call repeatedly)
 * or tools classified as read-only in the server config.
 */
import type { DiscoveredServer, DiscoveredTool } from '../../client/mcp-client.js';
import type { ServerConfig } from '../../config/schema.js';
import { AssertHelper, type TestCase, type TestRunContext } from '../types.js';
import { generateValidValue } from '../schema/fuzzer.js';

export interface LatencyResult {
  toolName: string;
  iterations: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  durations: number[];
}

/**
 * Compute percentile from sorted array.
 */
function percentile(sorted: number[], p: number): number {
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

/**
 * Build minimal valid args for a tool.
 */
function buildArgs(tool: DiscoveredTool): Record<string, unknown> {
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
 * Identify read-only tools safe for repeated calling.
 */
export function getReadOnlyTools(
  discovered: DiscoveredServer,
  serverConfig: ServerConfig,
): DiscoveredTool[] {
  const overrideReadOnly = new Set(serverConfig.toolSafety?.readOnly ?? []);
  const overrideWrite = new Set(serverConfig.toolSafety?.write ?? []);

  return discovered.tools.filter((tool) => {
    // Explicit override takes precedence
    if (overrideWrite.has(tool.name)) return false;
    if (overrideReadOnly.has(tool.name)) return true;
    // Fall back to annotation
    return tool.annotations?.readOnlyHint === true;
  });
}

export function generateLatencyTests(
  discovered: DiscoveredServer,
  serverConfig: ServerConfig,
  iterations: number,
  p95ThresholdMs: number,
): TestCase[] {
  const readOnlyTools = getReadOnlyTools(discovered, serverConfig);
  if (readOnlyTools.length === 0) return [];

  // Limit to 3 tools to keep runtime manageable
  const toolsToTest = readOnlyTools.slice(0, 3);

  return toolsToTest.map((tool) => ({
    id: `performance.latency.${tool.name}`,
    name: `Performance: Latency — ${tool.name}`,
    description: `Measures P50/P95/P99 latency over ${iterations} calls to ${tool.name}`,
    tags: ['performance', 'latency'],

    async run(ctx: TestRunContext) {
      const assert = new AssertHelper();
      const args = buildArgs(tool);
      const durations: number[] = [];

      for (let i = 0; i < iterations; i++) {
        try {
          const trace = await ctx.client.callTool(tool.name, args);
          durations.push(trace.durationMs);
        } catch {
          // Count errors but don't stop
          durations.push(-1);
        }
      }

      const successDurations = durations.filter((d) => d >= 0).sort((a, b) => a - b);

      if (successDurations.length === 0) {
        assert.ok(false, `Latency measurement — ${tool.name}`,
          'All iterations failed — cannot measure latency');
        return { assertions: assert.assertions };
      }

      const errorRate = (durations.length - successDurations.length) / durations.length;
      const p50 = percentile(successDurations, 50);
      const p95 = percentile(successDurations, 95);
      const p99 = percentile(successDurations, 99);
      const mean = Math.round(successDurations.reduce((a, b) => a + b, 0) / successDurations.length);
      const min = successDurations[0];
      const max = successDurations[successDurations.length - 1];

      // P95 latency threshold
      assert.ok(p95 <= p95ThresholdMs, `P95 latency — ${tool.name}`,
        `P95=${p95}ms (threshold: ${p95ThresholdMs}ms) | P50=${p50}ms, P99=${p99}ms, mean=${mean}ms`);

      // Error rate check
      if (errorRate > 0) {
        assert.warn(errorRate <= 0.1, `Error rate — ${tool.name}`,
          `${(errorRate * 100).toFixed(1)}% of calls failed (${durations.length - successDurations.length}/${durations.length})`);
      }

      const result: LatencyResult = {
        toolName: tool.name,
        iterations,
        p50Ms: p50,
        p95Ms: p95,
        p99Ms: p99,
        minMs: min,
        maxMs: max,
        meanMs: mean,
        durations: successDurations,
      };

      return {
        assertions: assert.assertions,
        metadata: {
          ...result,
          errorRate: parseFloat((errorRate * 100).toFixed(1)),
          threshold: p95ThresholdMs,
        },
      };
    },
  }));
}
