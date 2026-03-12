/**
 * Agentic Runner — orchestrates parallel product agents for real-time CRUD lifecycle testing.
 *
 * Flow:
 *   1. Connect to MCP server (discovery-only), discover tools
 *   2. Classify tools and group by product prefix
 *   3. Disconnect discovery connection
 *   4. Spawn one product agent per product category (each with its own connection)
 *   5. Aggregate results, emit run:end
 */
import { randomUUID } from 'node:crypto';
import { MCPProbeClient } from '../client/mcp-client.js';
import { classifyTools, groupByEntity } from '../suite/workflow/dependency-detector.js';
import { analyzeToolDependencies } from '../suite/workflow/schema-dependency-analyzer.js';
import { runWithConcurrency } from '../runner/concurrency.js';
import { createTransport } from './transport-factory.js';
import { runProductAgent } from './product-agent.js';
import { LLMModuleSelector, selectModuleDeterministic } from '../llm/module-selector.js';
import type { LLMJudgeConfig } from '../config/schema.js';
import type { EntityGroup } from '../suite/workflow/types.js';
import type {
  AgenticRunConfig,
  AgenticRunCallbacks,
  AgenticRunResult,
} from './types.js';

/**
 * Run agentic testing — the main entry point.
 *
 * Connects to the server for discovery only, then each product agent
 * creates its own connection for isolation and parallelism.
 */
export async function runAgentic(
  config: AgenticRunConfig,
  callbacks: AgenticRunCallbacks = {},
): Promise<AgenticRunResult> {
  const runId = randomUUID();
  const startTime = Date.now();
  const { serverConfig } = config;

  // Phase 1: Discovery-only connection
  const discoveryTransport = createTransport(serverConfig);
  const discoveryClient = new MCPProbeClient(discoveryTransport, serverConfig);

  let tools;
  let classifications;
  let dependencyProfiles;
  try {
    const discovered = await discoveryClient.connect();
    tools = discovered.tools;
    classifications = classifyTools(tools);

    // Phase 1.5: Schema-driven dependency analysis.
    // Builds dependency profiles for each tool (required/optional ID params,
    // inferred families, output shapes) for precise inter-tool routing.
    dependencyProfiles = analyzeToolDependencies(tools, classifications);
  } finally {
    try {
      await discoveryClient.disconnect();
    } catch {
      // Best-effort disconnect
    }
  }

  // Group tools by product prefix
  const productGroups = new Map<string, typeof classifications>();
  for (const tool of classifications) {
    const prefix = tool.prefixGroup ?? '_default';
    if (!productGroups.has(prefix)) {
      productGroups.set(prefix, []);
    }
    productGroups.get(prefix)!.push(tool);
  }

  // Filter products if specified
  let productNames = Array.from(productGroups.keys());
  if (config.productFilter && config.productFilter.length > 0) {
    productNames = productNames.filter((p) =>
      config.productFilter!.some((f) => p.toLowerCase().includes(f.toLowerCase())),
    );
  }

  callbacks.onRunStart?.(runId, productNames);

  // Phase 2: Spawn product agents — each creates its own connection
  const agentTasks = productNames.map((productName) => async () => {
    const productClassifications = productGroups.get(productName) ?? [];
    const entityGroups = groupByEntity(productClassifications, productName);

    // Smart module selection: if user didn't specify modules, auto-select
    const modules = config.modules && config.modules.length > 0
      ? config.modules
      : await selectModulesForProduct(entityGroups, productName, config.llm);

    // Filter dependency profiles to tools in this product
    const productToolNames = new Set(productClassifications.map((c) => c.toolName));
    const productProfiles = new Map(
      [...(dependencyProfiles?.entries() ?? [])].filter(([name]) => productToolNames.has(name)),
    );

    return runProductAgent({
      productName,
      entityGroups,
      classifications: productClassifications,
      serverConfig,
      tools,
      callbacks,
      modules,
      maxEntities: config.maxEntitiesPerProduct,
      testDataOverrides: config.testDataOverrides,
      llm: config.llm,
      dependencyProfiles: productProfiles.size > 0 ? productProfiles : undefined,
    });
  });

  const agentResults = await runWithConcurrency(agentTasks, productNames.length);

  // Aggregate results
  let totalSteps = 0;
  let passedSteps = 0;
  let failedSteps = 0;
  let totalEntities = 0;

  for (const agent of agentResults) {
    totalEntities += agent.totalEntities;
    for (const entity of agent.entities) {
      for (const step of entity.steps) {
        totalSteps++;
        if (step.status === 'passed') passedSteps++;
        if (step.status === 'failed') failedSteps++;
      }
    }
  }

  const hasFailures = agentResults.some((a) => a.status === 'failed' || a.status === 'partial');

  const result: AgenticRunResult = {
    runId,
    serverName: serverConfig.name,
    status: hasFailures ? 'failed' : 'completed',
    agents: agentResults,
    totalProducts: agentResults.length,
    totalEntities,
    totalSteps,
    passedSteps,
    failedSteps,
    durationMs: Date.now() - startTime,
    discoveredToolCount: tools.length,
  };

  callbacks.onRunEnd?.(result);
  return result;
}

/**
 * Select modules for a product when none are explicitly specified.
 * Uses LLM if available, otherwise deterministic scoring.
 */
async function selectModulesForProduct(
  entityGroups: EntityGroup[],
  productName: string,
  llmConfig?: LLMJudgeConfig,
): Promise<string[] | undefined> {
  // Only consider module-scoped groups for module selection
  // Standalone groups (Users, Roles, etc.) are always included and don't need selection
  const moduleScopedGroups = entityGroups.filter((g) => g.isModuleScoped);
  if (moduleScopedGroups.length <= 1) return undefined;

  // LLM-powered selection
  if (llmConfig?.enabled) {
    try {
      const selector = new LLMModuleSelector(llmConfig);
      const result = await selector.selectModule(moduleScopedGroups, productName);
      return [result.selectedModule];
    } catch {
      // Fall through to deterministic
    }
  }

  // Deterministic fallback
  const selected = selectModuleDeterministic(moduleScopedGroups);
  return selected ? [selected] : undefined;
}
