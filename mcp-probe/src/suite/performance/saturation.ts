/**
 * Saturation Tests — ramp concurrency to find degradation point.
 *
 * Incrementally increases concurrent requests from 1 to maxConcurrent,
 * measuring latency at each level. Reports the concurrency level where
 * latency exceeds 2x the baseline (single-request latency).
 */
import type { DiscoveredServer } from '../../client/mcp-client.js';
import type { ServerConfig } from '../../config/schema.js';
import { AssertHelper, type TestCase, type TestRunContext } from '../types.js';
import { generateValidValue } from '../schema/fuzzer.js';
import { getReadOnlyTools } from './latency.js';

export interface SaturationPoint {
  concurrency: number;
  meanLatencyMs: number;
  errorCount: number;
}

export function generateSaturationTests(
  discovered: DiscoveredServer,
  serverConfig: ServerConfig,
  maxConcurrent: number,
): TestCase[] {
  const readOnlyTools = getReadOnlyTools(discovered, serverConfig);
  if (readOnlyTools.length === 0) return [];

  const tool = readOnlyTools[0];

  return [{
    id: 'performance.saturation',
    name: `Performance: Saturation — ${tool.name}`,
    description: `Ramps concurrency 1→${maxConcurrent} to find degradation point for ${tool.name}`,
    tags: ['performance', 'saturation'],

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

      const levels = [1, 2, 5, 10, 20, 50].filter((n) => n <= maxConcurrent);
      const points: SaturationPoint[] = [];
      let baselineLatency = 0;
      let degradationPoint = -1;

      for (const concurrency of levels) {
        const durations: number[] = [];
        let errors = 0;

        const promises = Array.from({ length: concurrency }, async () => {
          try {
            const trace = await ctx.client.callTool(tool.name, args);
            durations.push(trace.durationMs);
          } catch {
            errors++;
          }
        });

        await Promise.all(promises);

        const successDurations = durations.sort((a, b) => a - b);
        const meanLatency = successDurations.length > 0
          ? Math.round(successDurations.reduce((a, b) => a + b, 0) / successDurations.length)
          : 0;

        points.push({ concurrency, meanLatencyMs: meanLatency, errorCount: errors });

        // Establish baseline at concurrency=1
        if (concurrency === 1 && meanLatency > 0) {
          baselineLatency = meanLatency;
        }

        // Detect degradation (2x baseline)
        if (baselineLatency > 0 && meanLatency > baselineLatency * 2 && degradationPoint === -1) {
          degradationPoint = concurrency;
        }

        // Stop if error rate is too high
        if (errors > concurrency * 0.5) break;
      }

      if (baselineLatency === 0) {
        assert.ok(false, 'Saturation baseline',
          'Could not establish baseline latency — tool calls failed at concurrency=1');
        return { assertions: assert.assertions };
      }

      if (degradationPoint === -1) {
        assert.ok(true, 'Saturation resistance',
          `No degradation detected up to ${levels[levels.length - 1]} concurrent calls ` +
          `(baseline: ${baselineLatency}ms)`);
      } else {
        assert.warn(false, 'Saturation point detected',
          `Performance degrades at ${degradationPoint} concurrent calls ` +
          `(baseline: ${baselineLatency}ms, at degradation: ${points.find((p) => p.concurrency === degradationPoint)?.meanLatencyMs}ms)`);
      }

      // Report full ramp data
      const summary = points.map((p) =>
        `${p.concurrency}c: ${p.meanLatencyMs}ms (${p.errorCount} errors)`,
      ).join(' | ');
      assert.info('saturation-ramp', `Ramp results: ${summary}`);

      return {
        assertions: assert.assertions,
        metadata: {
          tool: tool.name,
          baselineLatencyMs: baselineLatency,
          degradationPoint,
          maxConcurrentTested: levels[levels.length - 1],
          points,
        },
      };
    },
  }];
}
