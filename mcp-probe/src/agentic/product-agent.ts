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
import { resolveStepArgs, unwrapMCPResponse } from '../suite/workflow/output-resolver.js';
import { singularize } from '../suite/workflow/crud-patterns.js';
import { createTransport } from './transport-factory.js';
import { executeStepWithPIV } from './piv-loop.js';
import type { LLMIntentAnalyzer } from './piv-loop.js';
import { LLMIntentAnalyzerImpl } from '../llm/intent-analyzer.js';
import { IdRegistry } from '../suite/workflow/id-registry.js';
import type { ToolDependencyProfile } from '../suite/workflow/schema-dependency-analyzer.js';
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
  /** Schema-driven dependency profiles (from analyzeToolDependencies). */
  dependencyProfiles?: Map<string, ToolDependencyProfile>;
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
    }, config.dependencyProfiles);

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

    // Execute each entity workflow sequentially.
    // Shared ID registry propagates fetched_*_id values across entity workflows,
    // enabling hierarchical API patterns where entity B needs IDs from entity A.
    // IdRegistry provides family-aware lookup (e.g., "portal" family resolves
    // regardless of exact key format) and cross-entity propagation.
    const entityResults: EntityResult[] = [];
    const sharedIdRegistry = new IdRegistry();

    for (const workflow of workflows) {
      const entityResult = await executeEntityWorkflow(
        workflow,
        client,
        productName,
        callbacks,
        toolMap,
        llmAnalyzer,
        sharedIdRegistry,
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
  sharedIdRegistry?: IdRegistry,
): Promise<EntityResult> {
  const entityName = workflow.entity;
  const startTime = Date.now();
  // Use IdRegistry instead of plain Map so singular/plural key variants
  // (e.g., fetched_portal_id vs fetched_portals_id) resolve correctly
  // within a single entity workflow, not just cross-entity.
  const outputStore = new IdRegistry();
  const stepSummaries: StepSummary[] = [];

  // Seed per-entity outputStore with cross-entity IDs from the shared registry.
  // This enables hierarchical APIs where entity B needs IDs from entity A
  // (e.g., Tasks need portal_id from Portal entity, project_id from Project entity).
  // The IdRegistry provides family-aware lookup so "fetched_portal_id" is found
  // even if the exact key format differs slightly.
  if (sharedIdRegistry) {
    for (const [key, value] of sharedIdRegistry.entries()) {
      outputStore.set(key, value);
    }
  }

  // Emit entity start with step info
  const stepInfos: StepInfo[] = workflow.steps.map((s) => ({
    operation: s.operation,
    toolName: s.toolName,
  }));
  callbacks.onEntityStart?.(productName, entityName, stepInfos, workflow.representedEntities);

  // Pre-flight sample data probe: if no pre-create reads exist in the workflow,
  // fall back to probing the toolMap for a list/getAll tool to capture real field formats.
  // When pre-create reads ARE in the workflow, sample data is extracted after they run
  // in the main loop (see extractSampleFromStepOutput below).
  const hasPreCreateReads = workflow.steps.some((s) => {
    const createIdx = workflow.steps.findIndex((cs) => cs.operation === 'create');
    return s.operation === 'read' && workflow.steps.indexOf(s) < createIdx;
  });
  if (!hasPreCreateReads) {
    await probeSampleData(workflow, client, outputStore, toolMap);
  }

  try {
    for (let i = 0; i < workflow.steps.length; i++) {
      const step = workflow.steps[i];
      const summary = await executeStepWithCallbacks(
        step, client, outputStore, productName, entityName, callbacks, toolMap, llm,
      );
      stepSummaries.push(summary);

      // After a pre-create read step passes, extract sample data for the create step.
      // This captures real field values (e.g., portal names) from existing records
      // so the LLM/schema filler can generate create args that match API patterns.
      const createStepIdx = workflow.steps.findIndex((s) => s.operation === 'create');
      if (summary.status === 'passed' && step.operation === 'read'
          && i < createStepIdx && !outputStore.has('__sampleData__')) {
        // The PIV validate phase already stored extracted outputs in outputStore.
        // Try to build sample data from the step's outputMappings results.
        for (const om of step.outputMappings) {
          const val = outputStore.get(om.name);
          if (val && typeof val === 'object' && !Array.isArray(val)) {
            const sample = sanitizeSampleRecord(val as Record<string, unknown>);
            if (Object.keys(sample).length > 0) {
              outputStore.set('__sampleData__', sample);
              console.log(`[preCreateRead] ✓ Sample data from ${step.toolName}: ${Object.keys(sample).join(', ')}`);
              break;
            }
          }
        }
        // Fallback: re-call the tool to get raw response for sample extraction
        // (outputMappings may only capture IDs, not full records)
        if (!outputStore.has('__sampleData__')) {
          try {
            const { resolved } = resolveStepArgs(step.argsTemplate, step.inputMappings, outputStore);
            const trace = await client.callTool(step.toolName, resolved);
            const unwrapped = safeUnwrapMCPResponse(trace.response);
            if (unwrapped) {
              const sample = extractFirstRecord(unwrapped);
              if (sample && Object.keys(sample).length > 0) {
                outputStore.set('__sampleData__', sample);
                console.log(`[preCreateRead] ✓ Sample data (re-probe) from ${step.toolName}: ${Object.keys(sample).join(', ')}`);
              }
            }
          } catch {
            // Best-effort — don't fail the workflow
          }
        }
      }

      // If create step fails, skip only steps that depend on createdRecordId.
      // Independent steps (no inputMappings referencing createdRecordId) still run.
      if (summary.status === 'failed' && step.operation === 'create') {
        for (let j = i + 1; j < workflow.steps.length; j++) {
          const nextStep = workflow.steps[j];
          const dependsOnCreate = nextStep.inputMappings.some(
            (m) => m.fromOutput === 'createdRecordId',
          );
          if (dependsOnCreate) {
            const skipped: StepSummary = {
              operation: nextStep.operation,
              toolName: nextStep.toolName,
              status: 'skipped',
              durationMs: 0,
              isError: false,
            };
            stepSummaries.push(skipped);
            callbacks.onStepEnd?.(productName, entityName, skipped);
          } else {
            // Independent step — run it even though create failed
            const indepSummary = await executeStepWithCallbacks(
              nextStep, client, outputStore, productName, entityName, callbacks, toolMap, llm,
            );
            stepSummaries.push(indepSummary);
            if (j < workflow.steps.length - 1) {
              await sleep(STEP_DELAY_MS);
            }
          }
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

  // Propagate fetched_*_id keys back to shared registry for cross-entity access.
  // createdRecordId is NOT propagated — it's entity-specific and gets deleted in cleanup.
  if (sharedIdRegistry) {
    for (const [key, value] of outputStore.entries()) {
      if (key.startsWith('fetched_')) {
        sharedIdRegistry.set(key, value);
      }
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

/**
 * Pre-flight Sample Data Probe — calls a list/read endpoint before create steps
 * to capture real field formats from existing records.
 *
 * When APIs enforce undocumented validation patterns (e.g., portal_name format),
 * the schema alone doesn't reveal the required format. By fetching existing records
 * first, the LLM can see real field values and generate similarly-formatted test data.
 *
 * Best-effort: never fails the workflow if probing fails.
 */
async function probeSampleData(
  workflow: WorkflowDefinition,
  client: MCPProbeClient,
  outputStore: Map<string, unknown>,
  toolMap?: Map<string, DiscoveredTool>,
): Promise<void> {
  // Only probe if workflow has a create or upsert step
  const hasCreate = workflow.steps.some((s) =>
    s.operation === 'create' || s.operation === 'upsert',
  );
  if (!hasCreate) return;

  // Already have sample data? Skip.
  if (outputStore.has('__sampleData__')) return;

  // Strategy 1: Find a read/list step in the workflow that can run before the create step.
  // "List all" tools (e.g., getAllPortals) work without createdRecordId even if they
  // have an inputMapping for it — we filter those mappings out and try anyway.
  for (const step of workflow.steps) {
    if (step.operation !== 'read' && step.operation !== 'list' && step.operation !== 'search') {
      continue;
    }

    // Filter out createdRecordId mappings — list-all tools don't actually need them
    const nonCreateMappings = step.inputMappings.filter(
      (m) => m.fromOutput !== 'createdRecordId',
    );

    // Try to resolve this step's args from the current outputStore (without create-dependent mappings)
    const { resolved, unresolved } = resolveStepArgs(
      step.argsTemplate,
      nonCreateMappings,
      outputStore,
    );
    if (unresolved.length > 0) continue;

    try {
      const trace = await client.callTool(step.toolName, resolved);
      // callTool returns ToolCallTrace — extract the MCP response from trace.response
      const unwrapped = safeUnwrapMCPResponse(trace.response);
      if (!unwrapped) continue;

      const sample = extractFirstRecord(unwrapped);
      if (sample && Object.keys(sample).length > 0) {
        console.log(`[probeSampleData] ✓ Got sample from ${step.toolName}: ${Object.keys(sample).join(', ')}`);
        outputStore.set('__sampleData__', sample);
        return;
      }
    } catch {
      continue; // Try next candidate
    }
  }

  // Strategy 2: Search the toolMap for a list/getAll tool matching the entity.
  // This catches tools not included in the workflow steps.
  if (!toolMap) return;

  const entityLower = workflow.entity.toLowerCase();
  const entitySingular = singularize(entityLower);
  // Normalize: strip underscores/hyphens for matching (e.g., "all_portals" → "allportals"
  // matches "getAllPortals" → "getallportals")
  const entityClean = entityLower.replace(/[_-]/g, '');
  const entitySingularClean = entitySingular.replace(/[_-]/g, '');

  for (const [toolName, tool] of toolMap) {
    const nameLower = toolName.toLowerCase();
    const nameClean = nameLower.replace(/[_-]/g, '');

    // Must be a list/getAll pattern
    if (!/(?:getall|get_all|list|get_records|get_\w*record)/i.test(nameLower)) continue;

    // Must relate to our entity (check both raw and normalized forms)
    if (!nameLower.includes(entityLower) && !nameLower.includes(entitySingular)
        && !nameClean.includes(entityClean) && !nameClean.includes(entitySingularClean)) continue;

    // Build minimal args from the tool's schema
    const args = buildMinimalProbeArgs(tool, outputStore);
    if (!args) continue;

    try {
      const trace = await client.callTool(toolName, args);
      // callTool returns ToolCallTrace — extract the MCP response from trace.response
      const unwrapped = safeUnwrapMCPResponse(trace.response);
      if (!unwrapped) continue;

      const sample = extractFirstRecord(unwrapped);
      if (sample && Object.keys(sample).length > 0) {
        console.log(`[probeSampleData] ✓ Got sample from ${toolName}: ${Object.keys(sample).join(', ')}`);
        outputStore.set('__sampleData__', sample);
        return;
      }
    } catch {
      continue;
    }
  }
}

/**
 * Safely unwrap an MCP response to get the parsed JSON content.
 */
export function safeUnwrapMCPResponse(response: unknown): unknown {
  try {
    return unwrapMCPResponse(response);
  } catch {
    return null;
  }
}

/**
 * Extract the first record from an API response.
 * Handles common response shapes: { data: [...] }, [...], { records: [...] }, etc.
 *
 * Strips internal/system fields (IDs, timestamps, URLs) to keep only
 * the user-facing field formats that are useful as templates.
 */
export function extractFirstRecord(response: unknown): Record<string, unknown> | null {
  if (!response || typeof response !== 'object') return null;

  // Direct array
  if (Array.isArray(response)) {
    const first = response[0];
    return first && typeof first === 'object' && !Array.isArray(first)
      ? sanitizeSampleRecord(first as Record<string, unknown>)
      : null;
  }

  const obj = response as Record<string, unknown>;

  // Check known array field names first (most common API response shapes)
  const knownArrayFields = [
    'data', 'records', 'portals', 'projects', 'tasks',
    'milestones', 'modules', 'items', 'results', 'entries',
    'contacts', 'leads', 'deals', 'accounts', 'users',
    'bugs', 'forums', 'events', 'timesheets', 'activities',
  ];

  for (const field of knownArrayFields) {
    const arr = obj[field];
    if (Array.isArray(arr) && arr.length > 0) {
      const first = arr[0];
      if (first && typeof first === 'object' && !Array.isArray(first)) {
        return sanitizeSampleRecord(first as Record<string, unknown>);
      }
    }
  }

  // Fallback: find any array field in the response
  for (const value of Object.values(obj)) {
    if (Array.isArray(value) && value.length > 0) {
      const first = value[0];
      if (first && typeof first === 'object' && !Array.isArray(first)) {
        return sanitizeSampleRecord(first as Record<string, unknown>);
      }
    }
  }

  return null;
}

/**
 * Remove internal/system fields from a sample record to keep it focused
 * on user-facing field formats. Keeps the record compact for LLM context.
 */
export function sanitizeSampleRecord(record: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  // Fields to exclude: internal IDs, system timestamps, URLs, large nested objects
  const excludePatterns = /^(id|_id|id_string|created_by|modified_by|created_time|modified_time|link|url|href|self|avatar|photo|image|thumbnail|\\$)/i;

  for (const [key, value] of Object.entries(record)) {
    if (excludePatterns.test(key)) continue;

    // Keep primitives and simple arrays; skip deeply nested objects to save tokens
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      sanitized[key] = value;
    } else if (Array.isArray(value) && value.length > 0 && typeof value[0] !== 'object') {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

/**
 * Build minimal args for a probe tool call using the tool's schema.
 * Only fills required path_variables from the output store.
 * Returns null if required args can't be satisfied.
 */
export function buildMinimalProbeArgs(
  tool: DiscoveredTool,
  outputStore: Map<string, unknown>,
): Record<string, unknown> | null {
  if (!tool.inputSchema) return {};

  const schema = tool.inputSchema as Record<string, unknown>;
  const properties = schema.properties as Record<string, unknown> | undefined;
  const required = (schema.required as string[]) ?? [];

  const args: Record<string, unknown> = {};

  for (const field of required) {
    if (field === 'path_variables' && properties?.path_variables) {
      const pvSchema = properties.path_variables as Record<string, unknown>;
      const pvRequired = (pvSchema.required as string[]) ?? [];

      const pathVars: Record<string, unknown> = {};
      for (const pvField of pvRequired) {
        // Try to find this value in the output store (multiple key patterns)
        const fetchedKey = `fetched_${pvField}`;
        if (outputStore.has(fetchedKey)) {
          pathVars[pvField] = outputStore.get(fetchedKey);
        } else if (outputStore.has(pvField)) {
          pathVars[pvField] = outputStore.get(pvField);
        } else {
          // Can't resolve required path variable — this tool needs IDs we don't have
          return null;
        }
      }
      args.path_variables = pathVars;
    } else if (field === 'query_params') {
      args.query_params = {};
    } else if (field === 'body') {
      args.body = {};
    } else if (field === 'headers') {
      args.headers = {};
    }
  }

  return args;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
