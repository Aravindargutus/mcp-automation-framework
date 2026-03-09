/**
 * Product Agent — runs CRUD lifecycle tests for all entities within a product category.
 *
 * Each product agent creates its own MCP connection for isolation.
 *
 * For each entity (e.g., Leads, Contacts):
 *   1. Generate a CRUD workflow from the dependency graph
 *   2. Execute steps sequentially with output piping
 *   3. Emit real-time callbacks per step
 *   4. Always run cleanup (delete) even if earlier steps fail
 */
import type { ServerConfig, LLMJudgeConfig } from '../config/schema.js';
import type { MCPProbeClient } from '../client/mcp-client.js';
import { MCPProbeClient as MCPProbeClientImpl } from '../client/mcp-client.js';
import type { DiscoveredTool } from '../client/mcp-client.js';
import type { EntityGroup, ToolClassification, WorkflowDefinition, WorkflowStepDef } from '../suite/workflow/types.js';
import { generateWorkflows } from '../suite/workflow/workflow-generator.js';
import { resolveStepArgs } from '../suite/workflow/output-resolver.js';
import { createTransport } from './transport-factory.js';
import { executeStepWithPIV } from './piv-loop.js';
import type { LLMIntentAnalyzer } from './piv-loop.js';
import { LLMIntentAnalyzerImpl } from '../llm/intent-analyzer.js';
import type {
  AgenticRunCallbacks,
  ProductAgentResult,
  EntityResult,
  StepSummary,
  StepInfo,
} from './types.js';

const STEP_DELAY_MS = 500;

export interface ProductAgentConfig {
  productName: string;
  entityGroups: EntityGroup[];
  classifications: ToolClassification[];
  serverConfig: ServerConfig;
  tools: DiscoveredTool[];
  callbacks: AgenticRunCallbacks;
  modules?: string[];
  maxEntities?: number;
  testDataOverrides?: Record<string, Record<string, unknown>>;
  llm?: LLMJudgeConfig;
}

/**
 * Run all entity CRUD lifecycles for a single product category.
 * Creates its own MCP connection and disconnects when done.
 */
export async function runProductAgent(config: ProductAgentConfig): Promise<ProductAgentResult> {
  const startTime = Date.now();
  const { productName, entityGroups, tools, callbacks, serverConfig } = config;

  // Create per-product connection
  const transport = createTransport(serverConfig);
  const client = new MCPProbeClientImpl(transport, serverConfig);

  try {
    await client.connect();

    // Generate workflows for each entity
    const graph = {
      tools: config.classifications,
      edges: [],
      entityGroups,
    };

    const workflows = generateWorkflows(graph, tools, {
      enabled: true,
      maxEntities: config.maxEntities ?? 50,
      modules: config.modules,
      testDataOverrides: config.testDataOverrides,
    });

    const entityNames = workflows.map((w) => w.entity);
    callbacks.onAgentStart?.(productName, entityNames);

    if (workflows.length === 0) {
      const result: ProductAgentResult = {
        productName,
        status: 'passed',
        entities: [],
        totalEntities: 0,
        passedEntities: 0,
        failedEntities: 0,
        durationMs: Date.now() - startTime,
      };
      callbacks.onAgentEnd?.(productName, result);
      return result;
    }

    // Build tool map for schema-aware PIV planning
    const toolMap = new Map(tools.map((t) => [t.name, t]));

    // Create LLM analyzer if configured (one instance per product agent)
    const llmAnalyzer: LLMIntentAnalyzer | undefined = config.llm?.enabled
      ? new LLMIntentAnalyzerImpl(config.llm)
      : undefined;

    // Execute each entity workflow sequentially
    const entityResults: EntityResult[] = [];

    for (const workflow of workflows) {
      const entityResult = await executeEntityWorkflow(
        workflow,
        client,
        productName,
        callbacks,
        toolMap,
        llmAnalyzer,
      );
      entityResults.push(entityResult);
    }

    const passedEntities = entityResults.filter((e) => e.status === 'passed').length;
    const failedEntities = entityResults.filter((e) => e.status === 'failed').length;

    let status: ProductAgentResult['status'] = 'passed';
    if (failedEntities === entityResults.length) status = 'failed';
    else if (failedEntities > 0) status = 'partial';

    const result: ProductAgentResult = {
      productName,
      status,
      entities: entityResults,
      totalEntities: entityResults.length,
      passedEntities,
      failedEntities,
      durationMs: Date.now() - startTime,
    };

    callbacks.onAgentEnd?.(productName, result);
    return result;
  } finally {
    try {
      await client.disconnect();
    } catch {
      // Best-effort disconnect
    }
  }
}

/**
 * Execute a single entity's CRUD workflow with real-time step callbacks.
 */
async function executeEntityWorkflow(
  workflow: WorkflowDefinition,
  client: MCPProbeClient,
  productName: string,
  callbacks: AgenticRunCallbacks,
  toolMap?: Map<string, DiscoveredTool>,
  llm?: LLMIntentAnalyzer,
): Promise<EntityResult> {
  const entityName = workflow.entity;
  const startTime = Date.now();
  const outputStore = new Map<string, unknown>();
  const stepSummaries: StepSummary[] = [];

  // Emit entity start with step info
  const stepInfos: StepInfo[] = workflow.steps.map((s) => ({
    operation: s.operation,
    toolName: s.toolName,
  }));
  callbacks.onEntityStart?.(productName, entityName, stepInfos, workflow.representedEntities);

  try {
    for (let i = 0; i < workflow.steps.length; i++) {
      const step = workflow.steps[i];
      const summary = await executeStepWithCallbacks(
        step, client, outputStore, productName, entityName, callbacks, toolMap, llm,
      );
      stepSummaries.push(summary);

      // If create step fails, skip remaining (except cleanup)
      if (summary.status === 'failed' && step.operation === 'create') {
        for (let j = i + 1; j < workflow.steps.length; j++) {
          const skipped: StepSummary = {
            operation: workflow.steps[j].operation,
            toolName: workflow.steps[j].toolName,
            status: 'skipped',
            durationMs: 0,
            isError: false,
          };
          stepSummaries.push(skipped);
          callbacks.onStepEnd?.(productName, entityName, skipped);
        }
        break;
      }

      // Delay between steps to avoid rate limiting
      if (i < workflow.steps.length - 1) {
        await sleep(STEP_DELAY_MS);
      }
    }
  } finally {
    // Always run cleanup steps
    for (const cleanupStep of workflow.cleanupSteps) {
      await executeCleanupStep(cleanupStep, client, outputStore);
    }
  }

  // Determine entity status
  const failedCount = stepSummaries.filter((s) => s.status === 'failed').length;
  const totalNonSkipped = stepSummaries.filter((s) => s.status !== 'skipped').length;

  let entityStatus: EntityResult['status'] = 'passed';
  if (totalNonSkipped === 0) entityStatus = 'skipped';
  else if (failedCount === totalNonSkipped) entityStatus = 'failed';
  else if (failedCount > 0) entityStatus = 'partial';

  const entityResult: EntityResult = {
    entityName,
    status: entityStatus,
    steps: stepSummaries,
    durationMs: Date.now() - startTime,
    representedEntities: workflow.representedEntities,
  };

  callbacks.onEntityEnd?.(productName, entityName, entityResult);
  return entityResult;
}

/**
 * Execute a single workflow step via the PIV loop, emitting callbacks.
 */
async function executeStepWithCallbacks(
  step: WorkflowStepDef,
  client: MCPProbeClient,
  outputStore: Map<string, unknown>,
  productName: string,
  entityName: string,
  callbacks: AgenticRunCallbacks,
  toolMap?: Map<string, DiscoveredTool>,
  llm?: LLMIntentAnalyzer,
): Promise<StepSummary> {
  callbacks.onStepStart?.(productName, entityName, step.operation, step.toolName);

  const tool = toolMap?.get(step.toolName);
  const pivResult = await executeStepWithPIV(step, client, outputStore, tool, {
    maxRetries: 1,
    baseDelayMs: 1000,
  }, llm);

  // Merge PIV fields into the summary
  const summary: StepSummary = {
    ...pivResult.summary,
    pivPhases: pivResult.pivPhases,
    attempts: pivResult.attempts,
    errorCategory: pivResult.errorCategory,
    planningNotes: pivResult.planningNotes.length > 0 ? pivResult.planningNotes : undefined,
  };

  callbacks.onStepEnd?.(productName, entityName, summary);
  return summary;
}

/**
 * Execute a cleanup step — never emits callbacks, never fails.
 */
async function executeCleanupStep(
  step: WorkflowStepDef,
  client: MCPProbeClient,
  outputStore: Map<string, unknown>,
): Promise<void> {
  const { resolved, unresolved } = resolveStepArgs(
    step.argsTemplate,
    step.inputMappings,
    outputStore,
  );

  if (unresolved.length > 0) return;

  try {
    await client.callTool(step.toolName, resolved);
  } catch {
    // Cleanup failures are non-fatal
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
