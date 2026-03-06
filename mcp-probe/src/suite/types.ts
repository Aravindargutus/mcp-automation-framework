/**
 * Test Suite interface — public API for creating custom test suites.
 *
 * Suites are registered in a registry (not hardcoded in the runner).
 * Each suite generates test cases from the discovered server state.
 */
import type { DiscoveredServer } from '../client/mcp-client.js';
import type { MCPProbeClient } from '../client/mcp-client.js';
import type { RawMCPClient } from '../client/raw-client.js';
import type { ServerConfig } from '../config/schema.js';
import type { MCPTransport } from '../transport/types.js';
import type { AssertionResult } from '../plugin/types.js';

// --- Test case definition ---

export interface TestCase {
  id: string;
  name: string;
  description: string;
  tags: string[];
  /** If true, this test requires the raw client (bypasses SDK validation) */
  requiresRawClient?: boolean;
  /** If true, test is skipped when the capability is not declared */
  requiredCapability?: string;
  /** The test function */
  run(context: TestRunContext): Promise<TestCaseResult>;
}

export interface TestRunContext {
  /** The high-level MCP client (SDK-based, paginated) */
  client: MCPProbeClient;
  /** The raw client for protocol conformance tests */
  rawClient: RawMCPClient;
  /** The underlying transport */
  transport: MCPTransport;
  /** Server config from the probe config file */
  serverConfig: ServerConfig;
  /** Discovered server state (tools, resources, prompts, caps) */
  discovered: DiscoveredServer;
  /** Unique run ID */
  runId: string;
  /** Request timeout from config */
  requestTimeoutMs: number;
  /** Assert helper */
  assert: AssertHelper;
}

export interface TestCaseResult {
  assertions: AssertionResult[];
  metadata?: Record<string, unknown>;
}

// --- Assert helper ---

export class AssertHelper {
  private results: AssertionResult[] = [];

  get assertions(): AssertionResult[] {
    return [...this.results];
  }

  get hasFailed(): boolean {
    return this.results.some((r) => !r.passed && r.severity === 'error');
  }

  /** Assert that a condition is true */
  ok(condition: boolean, name: string, message?: string): void {
    this.results.push({
      passed: condition,
      name,
      message: message ?? (condition ? 'Passed' : 'Failed'),
      severity: 'error',
    });
  }

  /** Assert strict equality */
  equal(actual: unknown, expected: unknown, name: string): void {
    const passed = actual === expected;
    this.results.push({
      passed,
      name,
      message: passed ? 'Values are equal' : `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
      expected,
      actual,
      severity: 'error',
    });
  }

  /** Assert deep equality */
  deepEqual(actual: unknown, expected: unknown, name: string): void {
    const passed = JSON.stringify(actual) === JSON.stringify(expected);
    this.results.push({
      passed,
      name,
      message: passed ? 'Values are deeply equal' : 'Values differ',
      expected,
      actual,
      severity: 'error',
    });
  }

  /** Assert that a value is of a specific type */
  typeOf(value: unknown, expectedType: string, name: string): void {
    const actualType = typeof value;
    const passed = actualType === expectedType;
    this.results.push({
      passed,
      name,
      message: passed ? `Type is ${expectedType}` : `Expected type ${expectedType}, got ${actualType}`,
      expected: expectedType,
      actual: actualType,
      severity: 'error',
    });
  }

  /** Assert that an object has a specific property */
  hasProperty(obj: unknown, property: string, name: string): void {
    const passed = obj !== null && obj !== undefined && typeof obj === 'object' && property in obj;
    this.results.push({
      passed,
      name,
      message: passed ? `Has property "${property}"` : `Missing property "${property}"`,
      severity: 'error',
    });
  }

  /** Assert that a value matches a regex pattern */
  matches(value: string, pattern: RegExp, name: string): void {
    const passed = pattern.test(value);
    this.results.push({
      passed,
      name,
      message: passed ? `Matches pattern ${pattern}` : `"${value}" does not match ${pattern}`,
      severity: 'error',
    });
  }

  /** Add a warning (non-failing assertion) */
  warn(condition: boolean, name: string, message: string): void {
    this.results.push({
      passed: condition,
      name,
      message,
      severity: 'warning',
    });
  }

  /** Add an info note */
  info(name: string, message: string): void {
    this.results.push({
      passed: true,
      name,
      message,
      severity: 'info',
    });
  }

  /** Assert that an async function throws */
  async throws(fn: () => Promise<unknown>, name: string, expectedMessage?: string): Promise<void> {
    try {
      await fn();
      this.results.push({
        passed: false,
        name,
        message: 'Expected function to throw, but it did not',
        severity: 'error',
      });
    } catch (err) {
      const message = (err as Error).message;
      if (expectedMessage) {
        const passed = message.includes(expectedMessage);
        this.results.push({
          passed,
          name,
          message: passed
            ? `Threw with expected message`
            : `Expected message containing "${expectedMessage}", got "${message}"`,
          expected: expectedMessage,
          actual: message,
          severity: 'error',
        });
      } else {
        this.results.push({
          passed: true,
          name,
          message: `Threw: ${message}`,
          severity: 'error',
        });
      }
    }
  }
}

// --- Suite interface ---

export interface TestSuite {
  /** Unique name for this suite (e.g. "protocol", "schema") */
  name: string;
  description: string;
  tags: string[];

  /** Whether this suite applies to a given server (based on capabilities) */
  isApplicable(discovered: DiscoveredServer): boolean;

  /** Generate test cases from discovered server state */
  generateTests(discovered: DiscoveredServer, serverConfig: ServerConfig): TestCase[];

  /** Optional suite-level setup */
  setup?(context: TestRunContext): Promise<void>;

  /** Optional suite-level teardown */
  teardown?(context: TestRunContext): Promise<void>;
}
