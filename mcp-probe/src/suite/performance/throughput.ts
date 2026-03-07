/**
 * Throughput Tests — measure maximum requests per second (RPS).
 *
 * Sends concurrent requests to read-only tools and measures
 * how many successful calls the server can handle per second.
 */
import type { DiscoveredServer } from '../../client/mcp-client.js';
import type { ServerConfig } from '../../config/schema.js';
import { AssertHelper, type TestCase, type TestRunContext } from '../types.js';
import { generateValidValue } from '../schema/fuzzer.js';
import { getReadOnlyTools } from './latency.js';

export function generateThroughputTests(
  discovered: DiscoveredServer,
  serverConfig: ServerConfig,
  maxConcurrent: number,
  minRps: number,
): TestCase[] {
  const readOnlyTools = getReadOnlyTools(discovered, serverConfig);
  if (readOnlyTools.length === 0) return [];

  const tool = readOnlyTools[0];

  return [{
    id: 'performance.throughput',
    name: `Performance: Throughput — ${tool.name}`,
    description: `Measures max RPS with ${maxConcurrent} concurrent calls to ${tool.name}`,
    tags: ['performance', 'throughput'],

    async run(ctx: TestRunContext) {
      const assert = new AssertHelper();

      // Build args
      const props = tool.inputSchema?.properties as Record<string, Record<string, unknown>> | undefined;
      const required = (tool.inputSchema?.required ?? []) as string[];
      const args: Record<string, unknown> = {};
      if (props) {
        for (const key of required) {
          args[key] = generateValidValue(props[key] ?? { type: 'string' });
        }
      }

      // Fire concurrent requests
      const totalCalls = maxConcurrent;
      const startTime = Date.now();
      let successCount = 0;
      let errorCount = 0;

      const promises = Array.from({ length: totalCalls }, async () => {
        try {
          await ctx.client.callTool(tool.name, args);
          successCount++;
        } catch {
          errorCount++;
        }
      });

      await Promise.all(promises);
      const durationSec = (Date.now() - startTime) / 1000;
      const rps = parseFloat((successCount / durationSec).toFixed(2));

      assert.ok(rps >= minRps, 'Throughput RPS',
        `${rps} RPS (min threshold: ${minRps}) — ${successCount} successes, ${errorCount} errors in ${durationSec.toFixed(2)}s`);

      if (errorCount > 0) {
        assert.warn(errorCount / totalCalls <= 0.1, 'Throughput error rate',
          `${((errorCount / totalCalls) * 100).toFixed(1)}% error rate under load`);
      }

      return {
        assertions: assert.assertions,
        metadata: {
          tool: tool.name,
          concurrent: maxConcurrent,
          totalCalls,
          successCount,
          errorCount,
          durationSec: parseFloat(durationSec.toFixed(2)),
          rps,
          threshold: minRps,
        },
      };
    },
  }];
}
