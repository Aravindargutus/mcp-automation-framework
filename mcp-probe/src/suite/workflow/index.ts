/**
 * Workflow Test Suite — dependency-aware CRUD lifecycle testing for stateful MCP servers.
 *
 * Automatically detects tool dependencies (Create → Read → Update → Delete),
 * builds lifecycle workflows, and executes them with data piping between steps.
 *
 * Opt-in via config:
 *   workflow:
 *     enabled: true
 *     maxEntities: 2
 *     modules:
 *       - Leads
 *       - Contacts
 */
import type { DiscoveredServer } from '../../client/mcp-client.js';
import type { ServerConfig } from '../../config/schema.js';
import type { TestCase, TestSuite, TestRunContext } from '../types.js';
import { AssertHelper } from '../types.js';
import { detectDependencies } from './dependency-detector.js';
import { generateWorkflows } from './workflow-generator.js';
import { executeWorkflow } from './workflow-executor.js';
import type { WorkflowConfig } from './types.js';

const DEFAULT_CONFIG: WorkflowConfig = {
  enabled: false,
  maxEntities: 2,
};

export class WorkflowSuite implements TestSuite {
  name = 'workflow';
  description = 'Dependency-aware CRUD lifecycle workflow testing for stateful MCP servers';
  tags = ['workflow', 'stateful', 'crud'];

  private config: WorkflowConfig;

  constructor(config?: Partial<WorkflowConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  isApplicable(discovered: DiscoveredServer): boolean {
    if (!this.config.enabled) return false;
    if (discovered.tools.length < 2) return false;

    // Quick check: does this server have create+delete patterns?
    const hasCreate = discovered.tools.some((t) => /create|insert|upsert/i.test(t.name));
    const hasDelete = discovered.tools.some((t) => /delete|remove/i.test(t.name));
    return hasCreate && hasDelete;
  }

  generateTests(discovered: DiscoveredServer, _serverConfig: ServerConfig): TestCase[] {
    const graph = detectDependencies(discovered.tools);
    const workflows = generateWorkflows(graph, discovered.tools, this.config);

    if (workflows.length === 0) {
      return [];
    }

    return workflows.map((workflow) => ({
      id: workflow.id,
      name: workflow.name,
      description: workflow.description,
      tags: ['workflow', 'crud', workflow.entity],
      requiredCapability: 'tools',

      async run(ctx: TestRunContext) {
        const assert = new AssertHelper();
        const trace = await executeWorkflow(workflow, ctx, assert);

        const metadata = {
          input: {
            workflow: workflow.name,
            entity: workflow.entity,
            stepCount: workflow.steps.length,
            steps: workflow.steps.map((s) => ({
              tool: s.toolName,
              operation: s.operation,
              description: s.description,
            })),
          },
          expected: {
            description: `Full CRUD lifecycle completes with data flowing between steps for ${workflow.entity}`,
          },
          actual: {
            stepsExecuted: trace.steps.filter((s) => !s.skipped).length,
            stepsSkipped: trace.steps.filter((s) => s.skipped).length,
            stepsErrored: trace.steps.filter((s) => s.isError).length,
            cleanupExecuted: trace.cleanupSteps.filter((s) => !s.skipped).length,
            cleanupErrored: trace.cleanupSteps.filter((s) => s.isError).length,
            totalDurationMs: trace.totalDurationMs,
            stepCount: workflow.steps.length,
            dataFlow: trace.outputStore,
            trace: trace.steps.map((s) => ({
              tool: s.stepDef.toolName,
              operation: s.stepDef.operation,
              description: s.stepDef.description,
              skipped: s.skipped,
              skipReason: s.skipReason ?? null,
              isError: s.isError,
              durationMs: s.durationMs,
              extractedOutputs: s.extractedOutputs,
            })),
          },
        };

        return { assertions: assert.assertions, metadata };
      },
    }));
  }

  async setup(_context: TestRunContext): Promise<void> {
    // No global setup needed
  }

  async teardown(_context: TestRunContext): Promise<void> {
    // Cleanup is handled per-workflow in the executor
  }
}
