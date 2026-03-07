/**
 * Performance Test Suite — opt-in load testing for MCP servers.
 *
 * Measures latency percentiles (P50/P95/P99), throughput (RPS),
 * and saturation point (concurrency where performance degrades).
 * Only tests read-only tools to avoid side effects.
 *
 * Enabled via config:
 *   performance:
 *     enabled: true
 *     iterations: 10
 *     maxConcurrent: 50
 *     thresholds:
 *       p95LatencyMs: 500
 *       minRps: 10
 */
import type { DiscoveredServer } from '../../client/mcp-client.js';
import type { ServerConfig } from '../../config/schema.js';
import type { TestCase, TestSuite, TestRunContext } from '../types.js';
import { generateLatencyTests, getReadOnlyTools } from './latency.js';
import { generateThroughputTests } from './throughput.js';
import { generateSaturationTests } from './saturation.js';
import { generateGoldenSignalsTest } from './golden-signals.js';

export interface PerformanceConfig {
  enabled: boolean;
  iterations: number;
  maxConcurrent: number;
  thresholds: {
    p95LatencyMs: number;
    minRps: number;
  };
}

const DEFAULT_CONFIG: PerformanceConfig = {
  enabled: false,
  iterations: 10,
  maxConcurrent: 50,
  thresholds: {
    p95LatencyMs: 500,
    minRps: 10,
  },
};

export class PerformanceSuite implements TestSuite {
  name = 'performance';
  description = 'Performance and load testing: latency percentiles, throughput, saturation';
  tags = ['performance', 'load-testing'];

  private config: PerformanceConfig;

  constructor(config?: Partial<PerformanceConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config, thresholds: { ...DEFAULT_CONFIG.thresholds, ...config?.thresholds } };
  }

  isApplicable(discovered: DiscoveredServer): boolean {
    // Opt-in: must be explicitly enabled
    return this.config.enabled && discovered.tools.length > 0;
  }

  generateTests(discovered: DiscoveredServer, serverConfig: ServerConfig): TestCase[] {
    const readOnlyTools = getReadOnlyTools(discovered, serverConfig);

    if (readOnlyTools.length === 0) {
      // No read-only tools — can't safely run performance tests
      return [];
    }

    return [
      ...generateLatencyTests(
        discovered,
        serverConfig,
        this.config.iterations,
        this.config.thresholds.p95LatencyMs,
      ),
      ...generateThroughputTests(
        discovered,
        serverConfig,
        this.config.maxConcurrent,
        this.config.thresholds.minRps,
      ),
      ...generateSaturationTests(
        discovered,
        serverConfig,
        this.config.maxConcurrent,
      ),
      ...generateGoldenSignalsTest(
        discovered,
        serverConfig,
        this.config.thresholds,
      ),
    ];
  }

  async setup(_context: TestRunContext): Promise<void> {
    // No setup needed — each test manages its own iterations
  }

  async teardown(_context: TestRunContext): Promise<void> {
    // No teardown needed
  }
}
