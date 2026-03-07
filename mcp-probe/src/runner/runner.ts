/**
 * Test Runner — orchestrates the full test lifecycle:
 *
 * For each server:
 *   1. Create transport + client
 *   2. Connect and discover
 *   3. For each applicable suite:
 *     a. suite.setup()
 *     b. Generate test cases
 *     c. Run each test (with timeout)
 *     d. suite.teardown()
 *   4. Disconnect
 *   5. Collect results
 */
import { randomUUID } from 'node:crypto';
import type { MCPProbeConfig, ServerConfig } from '../config/schema.js';
import { StdioTransport } from '../transport/stdio.js';
import { HttpTransport } from '../transport/http.js';
import type { MCPTransport } from '../transport/types.js';
import { MCPProbeClient, type DiscoveredServer } from '../client/mcp-client.js';
import { TestSuiteRegistry } from '../suite/registry.js';
import { ProtocolSuite } from '../suite/protocol/index.js';
import { SchemaSuite } from '../suite/schema/index.js';
import { ExecutionSuite } from '../suite/execution/index.js';
import { ErrorHandlingSuite } from '../suite/error-handling/index.js';
import { EdgeCasesSuite } from '../suite/edge-cases/index.js';
import { AIEvaluationSuite } from '../suite/ai-evaluation/index.js';
import { SecuritySuite } from '../suite/security/index.js';
import { PerformanceSuite } from '../suite/performance/index.js';
import { AssertHelper, type TestCase, type TestRunContext } from '../suite/types.js';
import type { TestResult, SuiteResult } from '../plugin/types.js';
import type { MCPProbeReport, ServerReport } from '../reporter/schema.js';
import { runWithConcurrency } from './concurrency.js';

export interface RunnerOptions {
  config: MCPProbeConfig;
  registry?: TestSuiteRegistry;
  onServerStart?: (serverName: string) => void;
  onServerEnd?: (serverName: string, report: ServerReport) => void;
  onSuiteStart?: (suiteName: string, serverName: string, testCount: number) => void;
  onSuiteEnd?: (suiteName: string, serverName: string, result: SuiteResult) => void;
  onTestStart?: (testId: string, testName: string, suiteName: string, serverName: string) => void;
  onTestEnd?: (testResult: TestResult) => void;
}

/**
 * Create the default suite registry with built-in suites.
 */
function createDefaultRegistry(config?: MCPProbeConfig): TestSuiteRegistry {
  const registry = new TestSuiteRegistry();
  registry.register(new ProtocolSuite());
  registry.register(new SchemaSuite());
  registry.register(new ExecutionSuite());
  registry.register(new ErrorHandlingSuite());
  registry.register(new EdgeCasesSuite());
  // Security suite — always-on (users can exclude via suites.exclude)
  registry.register(new SecuritySuite());
  // Performance suite — opt-in via config.performance.enabled
  registry.register(new PerformanceSuite(config?.performance));
  // LLM-powered suite — only active when llmJudge.enabled=true in config
  registry.register(new AIEvaluationSuite(config?.llmJudge));
  return registry;
}

/**
 * Build auth headers from the auth config.
 */
function buildAuthHeaders(auth?: ServerConfig['auth']): Record<string, string> {
  if (!auth) return {};
  // After config loading, env refs are resolved to plain strings
  const resolveSecret = (val: string | { env: string }): string =>
    typeof val === 'string' ? val : process.env[val.env] ?? '';
  switch (auth.type) {
    case 'bearer':
      return { Authorization: `Bearer ${resolveSecret(auth.token)}` };
    case 'apikey':
      return { [auth.header]: resolveSecret(auth.key) };
    default:
      return {};
  }
}

/**
 * Create a transport from server config.
 */
function createTransport(serverConfig: ServerConfig): MCPTransport {
  const authHeaders = buildAuthHeaders(serverConfig.auth);

  switch (serverConfig.transport.type) {
    case 'stdio':
      return new StdioTransport({
        command: serverConfig.transport.command,
        args: serverConfig.transport.args,
        cwd: serverConfig.transport.cwd,
        env: serverConfig.transport.env,
      });
    case 'http':
      return new HttpTransport({
        url: serverConfig.transport.url,
        headers: { ...serverConfig.transport.headers, ...authHeaders },
      });
    case 'sse':
      return new HttpTransport({
        url: serverConfig.transport.url,
        headers: { ...serverConfig.transport.headers, ...authHeaders },
      });
    default:
      throw new Error(`Unsupported transport type: ${(serverConfig.transport as { type: string }).type}`);
  }
}

/**
 * Run a single test case with timeout and error handling.
 */
async function runTestCase(
  test: TestCase,
  context: TestRunContext,
  testTimeoutMs: number,
): Promise<TestResult> {
  const startTime = Date.now();

  // Skip if required capability is missing
  if (test.requiredCapability) {
    const caps = context.discovered.capabilities;
    if (!(test.requiredCapability in caps)) {
      return {
        testId: test.id,
        testName: test.name,
        suiteName: '',
        status: 'skipped',
        durationMs: 0,
        assertions: [{
          passed: true,
          name: 'skip-reason',
          message: `Requires capability: ${test.requiredCapability}`,
          severity: 'info',
        }],
      };
    }
  }

  try {
    const result = await Promise.race([
      test.run(context),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Test timed out after ${testTimeoutMs}ms`)), testTimeoutMs),
      ),
    ]);

    const hasFailed = result.assertions.some((a) => !a.passed && a.severity === 'error');

    return {
      testId: test.id,
      testName: test.name,
      suiteName: '',
      status: hasFailed ? 'failed' : 'passed',
      durationMs: Date.now() - startTime,
      assertions: result.assertions,
      metadata: result.metadata,
    };
  } catch (err) {
    return {
      testId: test.id,
      testName: test.name,
      suiteName: '',
      status: 'errored',
      durationMs: Date.now() - startTime,
      assertions: [],
      error: {
        message: (err as Error).message,
        stack: (err as Error).stack,
      },
    };
  }
}

/**
 * Run all tests for a single server.
 */
async function runServer(
  serverConfig: ServerConfig,
  config: MCPProbeConfig,
  registry: TestSuiteRegistry,
  runId: string,
  options: RunnerOptions,
): Promise<ServerReport> {
  const serverStartTime = Date.now();
  const suiteResults: SuiteResult[] = [];

  const transport = createTransport(serverConfig);
  const client = new MCPProbeClient(transport, serverConfig);
  let discovered: DiscoveredServer;

  // --- Connect and discover ---
  try {
    discovered = await client.connect();
  } catch (err) {
    return {
      serverName: serverConfig.name,
      durationMs: Date.now() - serverStartTime,
      connected: false,
      connectionError: (err as Error).message,
      discovered: null,
      suites: [],
      score: null,
    };
  }

  // --- Build test context ---
  const rawClient = client.getRawClient();
  const requestTimeoutMs = serverConfig.timeout?.request ?? config.defaults?.timeout?.request ?? 30_000;
  const testTimeoutMs = serverConfig.timeout?.test ?? config.defaults?.timeout?.test ?? 300_000;

  const baseContext: TestRunContext = {
    client,
    rawClient,
    transport,
    serverConfig,
    discovered,
    runId,
    requestTimeoutMs,
    assert: new AssertHelper(),
  };

  // --- Run suites ---
  const suiteIncludes = config.suites?.include ?? [
    'protocol', 'schema', 'execution', 'error-handling', 'edge-cases', 'security',
    ...(config.performance?.enabled ? ['performance'] : []),
    ...(config.llmJudge?.enabled ? ['ai-evaluation'] : []),
  ];
  const suiteExcludes = config.suites?.exclude ?? [];
  const suites = registry.getFiltered(suiteIncludes, suiteExcludes);

  for (const suite of suites) {
    if (!suite.isApplicable(discovered)) continue;

    const suiteStartTime = Date.now();
    const tests = suite.generateTests(discovered, serverConfig);

    // Emit suite start
    options.onSuiteStart?.(suite.name, serverConfig.name, tests.length);

    // Suite setup
    if (suite.setup) {
      try {
        await suite.setup(baseContext);
      } catch (err) {
        const failedResult: SuiteResult = {
          suiteName: suite.name,
          serverName: serverConfig.name,
          durationMs: Date.now() - suiteStartTime,
          tests: [],
          passed: 0,
          failed: 0,
          skipped: 0,
          errored: 1,
        };
        suiteResults.push(failedResult);
        options.onSuiteEnd?.(suite.name, serverConfig.name, failedResult);
        continue;
      }
    }

    // Run tests
    const testResults: TestResult[] = [];
    for (const test of tests) {
      options.onTestStart?.(test.id, test.name, suite.name, serverConfig.name);
      const result = await runTestCase(test, baseContext, testTimeoutMs);
      result.suiteName = suite.name;
      testResults.push(result);
      options.onTestEnd?.(result);
    }

    // Suite teardown
    if (suite.teardown) {
      try {
        await suite.teardown(baseContext);
      } catch {
        // Best-effort teardown
      }
    }

    const suiteResult: SuiteResult = {
      suiteName: suite.name,
      serverName: serverConfig.name,
      durationMs: Date.now() - suiteStartTime,
      tests: testResults,
      passed: testResults.filter((t) => t.status === 'passed').length,
      failed: testResults.filter((t) => t.status === 'failed').length,
      skipped: testResults.filter((t) => t.status === 'skipped').length,
      errored: testResults.filter((t) => t.status === 'errored').length,
    };
    suiteResults.push(suiteResult);
    options.onSuiteEnd?.(suite.name, serverConfig.name, suiteResult);
  }

  // --- Disconnect ---
  try {
    await client.disconnect();
  } catch {
    // Best-effort disconnect
  }

  // --- Calculate score ---
  const score = calculateScore(suiteResults);

  return {
    serverName: serverConfig.name,
    durationMs: Date.now() - serverStartTime,
    connected: true,
    connectionError: null,
    discovered: {
      serverInfo: discovered.serverInfo,
      protocolVersion: discovered.protocolVersion,
      toolCount: discovered.tools.length,
      resourceCount: discovered.resources.length,
      promptCount: discovered.prompts.length,
    },
    suites: suiteResults,
    score,
  };
}

/**
 * Calculate the overall score from suite results.
 */
function calculateScore(suiteResults: SuiteResult[]): ServerReport['score'] {
  const allTests = suiteResults.flatMap((s) => s.tests);
  if (allTests.length === 0) return null;

  const total = allTests.filter((t) => t.status !== 'skipped').length;
  if (total === 0) return null;

  const passed = allTests.filter((t) => t.status === 'passed').length;
  const percentage = Math.round((passed / total) * 100);

  let grade: string;
  if (percentage >= 90) grade = 'A';
  else if (percentage >= 75) grade = 'B';
  else if (percentage >= 60) grade = 'C';
  else if (percentage >= 45) grade = 'D';
  else grade = 'F';

  return { percentage, grade, passed, total };
}

/**
 * Run the full test suite across all configured servers.
 */
export async function run(options: RunnerOptions): Promise<MCPProbeReport> {
  const { config } = options;
  const registry = options.registry ?? createDefaultRegistry(config);
  const runId = randomUUID();
  const startTime = Date.now();

  const maxConcurrent = config.defaults?.maxConcurrent ?? 10;

  const serverTasks = config.servers.map((serverConfig) => async () => {
    options.onServerStart?.(serverConfig.name);
    const report = await runServer(serverConfig, config, registry, runId, options);
    options.onServerEnd?.(serverConfig.name, report);
    return report;
  });

  const serverReports = await runWithConcurrency(serverTasks, maxConcurrent);

  return {
    schemaVersion: '1.0',
    runId,
    timestamp: new Date().toISOString(),
    duration: Date.now() - startTime,
    config: {
      serverCount: config.servers.length,
      suites: config.suites?.include ?? ['protocol', 'schema', 'execution', 'error-handling', 'edge-cases'],
    },
    servers: serverReports,
  };
}
