/**
 * Plugin interface — public API for extending MCP Probe.
 *
 * Plugins can:
 * - Hook into test lifecycle (before/after suite, before/after test)
 * - Verify side effects of tool calls (baseline → delta pattern)
 * - Add custom assertions
 * - Provide custom reporters
 */
import type { DiscoveredServer, DiscoveredTool, ToolCallTrace } from '../client/mcp-client.js';
import type { ServerConfig } from '../config/schema.js';

// --- Side-effect verification ---

export interface SideEffectBaseline {
  pluginName: string;
  data: unknown;
  capturedAt: number;
}

export interface SideEffectDelta {
  pluginName: string;
  changed: boolean;
  description: string;
  details?: unknown;
}

// --- Custom assertions ---

export interface AssertionResult {
  passed: boolean;
  name: string;
  message: string;
  expected?: unknown;
  actual?: unknown;
  severity: 'error' | 'warning' | 'info';
}

export interface CustomAssertion {
  name: string;
  description: string;
  appliesTo(tool: DiscoveredTool): boolean;
  assert(trace: ToolCallTrace, context: TestContext): AssertionResult | Promise<AssertionResult>;
}

// --- Test context passed to plugins ---

export interface SuiteContext {
  serverConfig: ServerConfig;
  discovered: DiscoveredServer;
  suiteName: string;
  runId: string;
}

export interface TestContext extends SuiteContext {
  testName: string;
  testId: string;
}

export interface ToolCallContext extends TestContext {
  tool: DiscoveredTool;
  args: unknown;
}

// --- Reporter interface ---

export interface ReporterEvent {
  type: 'run_start' | 'suite_start' | 'test_start' | 'test_end' | 'suite_end' | 'run_end';
  timestamp: number;
  data: unknown;
}

export interface Reporter {
  name: string;
  onEvent(event: ReporterEvent): void | Promise<void>;
  finalize(): void | Promise<void>;
}

// --- Plugin interface ---

export interface MCPProbePlugin {
  name: string;
  version: string;
  description?: string;

  /** Called once when the plugin is registered */
  initialize?(): void | Promise<void>;

  /** Called once when all testing is done */
  destroy?(): void | Promise<void>;

  // --- Lifecycle hooks ---

  onSuiteStart?(context: SuiteContext): void | Promise<void>;
  onSuiteEnd?(context: SuiteContext, results: SuiteResult): void | Promise<void>;
  onTestStart?(context: TestContext): void | Promise<void>;
  onTestEnd?(context: TestContext, result: TestResult): void | Promise<void>;

  // --- Side-effect verification ---

  /** Capture baseline state before a tool call */
  onBeforeToolCall?(context: ToolCallContext): SideEffectBaseline | Promise<SideEffectBaseline>;
  /** Compare against baseline after a tool call */
  onAfterToolCall?(
    context: ToolCallContext,
    baseline: SideEffectBaseline,
    trace: ToolCallTrace,
  ): SideEffectDelta | Promise<SideEffectDelta>;

  // --- Custom extensions ---

  customAssertions?: CustomAssertion[];
  reporter?: Reporter;
}

// --- Results (shared between suites, runner, and reporter) ---

export type TestStatus = 'passed' | 'failed' | 'skipped' | 'errored';

export interface TestResult {
  testId: string;
  testName: string;
  suiteName: string;
  status: TestStatus;
  durationMs: number;
  assertions: AssertionResult[];
  sideEffects?: SideEffectDelta[];
  error?: { message: string; stack?: string };
  metadata?: Record<string, unknown>;
}

export interface SuiteResult {
  suiteName: string;
  serverName: string;
  durationMs: number;
  tests: TestResult[];
  passed: number;
  failed: number;
  skipped: number;
  errored: number;
}
