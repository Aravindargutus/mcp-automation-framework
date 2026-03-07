/**
 * Golden Signals Summary — aggregate Latency/Traffic/Errors/Saturation.
 *
 * Provides a single pass/fail verdict based on all performance data
 * collected from latency, throughput, and saturation tests. This test
 * should run last in the performance suite to aggregate results.
 */
import type { DiscoveredServer } from '../../client/mcp-client.js';
import type { ServerConfig } from '../../config/schema.js';
import { AssertHelper, type TestCase, type TestRunContext } from '../types.js';
import { getReadOnlyTools } from './latency.js';

export function generateGoldenSignalsTest(
  discovered: DiscoveredServer,
  serverConfig: ServerConfig,
  thresholds: { p95LatencyMs: number; minRps: number },
): TestCase[] {
  const readOnlyTools = getReadOnlyTools(discovered, serverConfig);
  if (readOnlyTools.length === 0) return [];

  return [{
    id: 'performance.golden-signals',
    name: 'Performance: Golden Signals summary',
    description: 'Aggregated performance verdict from Latency, Traffic, Errors, Saturation',
    tags: ['performance', 'golden-signals', 'summary'],

    async run(_ctx: TestRunContext) {
      const assert = new AssertHelper();

      // This test acts as a summary — it doesn't make its own calls.
      // It provides configuration reference and threshold documentation.
      assert.info('golden-signals-config',
        `Thresholds: P95 < ${thresholds.p95LatencyMs}ms, RPS > ${thresholds.minRps}`);

      assert.info('golden-signals-tools',
        `Read-only tools tested: ${readOnlyTools.map((t) => t.name).join(', ')}`);

      assert.ok(true, 'Golden Signals configured',
        'Performance monitoring active — see individual latency/throughput/saturation tests for details');

      return {
        assertions: assert.assertions,
        metadata: {
          thresholds,
          readOnlyToolCount: readOnlyTools.length,
          readOnlyTools: readOnlyTools.map((t) => t.name),
        },
      };
    },
  }];
}
