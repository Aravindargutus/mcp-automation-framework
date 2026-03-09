/**
 * Workflow Generator — builds CRUD lifecycle workflows from the dependency graph.
 *
 * For each entity (e.g., Leads, Contacts), generates a workflow:
 *   Create → Read → Update → Search → Delete
 *
 * Each step includes arg templates, output mappings, and input mappings
 * so the executor can pipe data between steps.
 */
import type { DiscoveredTool } from '../../client/mcp-client.js';
import type {
  CRUDOperation,
  EntityGroup,
  DependencyGraph,
  ToolClassification,
  WorkflowDefinition,
  WorkflowStepDef,
  WorkflowConfig,
} from './types.js';
import { generateValidValue } from '../schema/fuzzer.js';
import { fillRequiredFields } from '../../agentic/schema-aware-builder.js';
import {
  getTestDataFromSchema,
  getUpdateTestData,
  RESPONSE_ID_PATHS,
  extractResourceFamily,
  isPrimaryEntity,
  singularize,
} from './crud-patterns.js';

/**
 * Compute a signature for an EntityGroup based on its sorted tool names.
 * Entities with identical signatures have the same tools and can be deduped.
 */
function computeToolSignature(entity: EntityGroup): string {
  const allTools = [
    ...entity.create, ...entity.read, ...entity.update,
    ...entity.delete, ...entity.search, ...entity.other,
  ];
  return allTools.slice().sort().join('|');
}

/**
 * Deduplicate entity groups that have identical tool sets.
 * Returns the deduped list plus a map from representative entity name
 * to the list of all entity names it represents.
 */
function deduplicateEntities(
  entities: EntityGroup[],
): { deduped: EntityGroup[]; representedMap: Map<string, string[]> } {
  const signatureGroups = new Map<string, EntityGroup[]>();

  for (const entity of entities) {
    const sig = computeToolSignature(entity);
    if (!signatureGroups.has(sig)) signatureGroups.set(sig, []);
    signatureGroups.get(sig)!.push(entity);
  }

  const deduped: EntityGroup[] = [];
  const representedMap = new Map<string, string[]>();

  for (const [, group] of signatureGroups) {
    group.sort((a, b) => a.entityName.localeCompare(b.entityName));
    deduped.push(group[0]);
    if (group.length > 1) {
      representedMap.set(group[0].entityName, group.map((g) => g.entityName));
    }
  }

  deduped.sort((a, b) => a.entityName.localeCompare(b.entityName));
  return { deduped, representedMap };
}

/**
 * Generate CRUD lifecycle workflows from the dependency graph.
 */
export function generateWorkflows(
  graph: DependencyGraph,
  tools: DiscoveredTool[],
  config: WorkflowConfig,
): WorkflowDefinition[] {
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const classificationMap = new Map(graph.tools.map((c) => [c.toolName, c]));
  const workflows: WorkflowDefinition[] = [];

  // Determine which entities to test
  let entities = graph.entityGroups;

  // Split into module-scoped and standalone entity groups
  const moduleScopedEntities = entities.filter((e) => e.isModuleScoped);
  let standaloneEntities = entities.filter((e) => !e.isModuleScoped);

  // Module filter applies ONLY to module-scoped groups
  let filteredModuleScoped: EntityGroup[];
  if (config.modules && config.modules.length > 0 && moduleScopedEntities.length > 0) {
    filteredModuleScoped = moduleScopedEntities.filter((e) =>
      config.modules!.some((m) => m.toLowerCase() === e.entityName.toLowerCase()),
    );
  } else {
    // No filter or no module-scoped tools — limit module-scoped groups
    filteredModuleScoped = moduleScopedEntities.slice(0, config.maxEntities);
  }

  // Standalone entities get a separate, generous limit
  const maxStandalone = Math.max(config.maxEntities * 2, 20);
  standaloneEntities = standaloneEntities.slice(0, maxStandalone);

  // Combine and deduplicate
  entities = [...filteredModuleScoped, ...standaloneEntities];

  // Deduplicate entities with identical tool sets
  const { deduped, representedMap } = deduplicateEntities(entities);
  entities = deduped;

  for (const entityGroup of entities) {
    const workflow = buildWorkflowForEntity(entityGroup, toolMap, classificationMap, config);
    if (workflow) {
      const represented = representedMap.get(entityGroup.entityName);
      if (represented) {
        workflow.representedEntities = represented;
        const otherCount = represented.length - 1;
        workflow.name = `All tools: ${entityGroup.entityName} (+${otherCount} similar)`;
      }
      workflows.push(workflow);
    }
  }

  return workflows;
}

/**
 * Build a workflow that tests ALL available tools for a single entity group.
 *
 * Supports three modes based on available tools:
 *   Full:      Create → Read[ALL] → Update[ALL] → Other[ALL] → Search[ALL] → Delete
 *   No-delete: Create → Read[ALL] → Update[ALL] → Other[ALL] → Search[ALL] (no cleanup)
 *   Read-only: Read[ALL] → Search[ALL] → Other[ALL] (no record creation)
 *
 * Returns null only if the entity has zero tools.
 */
function buildWorkflowForEntity(
  entity: EntityGroup,
  toolMap: Map<string, DiscoveredTool>,
  classificationMap: Map<string, ToolClassification>,
  config: WorkflowConfig,
): WorkflowDefinition | null {
  const hasCreate = entity.create.length > 0;
  const hasDelete = entity.delete.length > 0;
  const totalTools = entity.create.length + entity.read.length + entity.update.length
    + entity.delete.length + entity.search.length + entity.other.length;

  // Skip if entity has no tools at all
  if (totalTools === 0) {
    return null;
  }

  const steps: WorkflowStepDef[] = [];
  const cleanupSteps: WorkflowStepDef[] = [];
  let stepIndex = 0;

  // Determine the primary entity hint from the CREATE step (for resource-aware ID routing).
  // Tools whose entityHint matches the primary family use createdRecordId.
  // Other tools (fields, layouts, etc.) get their IDs from producer steps.
  const primaryEntityHint = hasCreate && entity.create.length > 0
    ? classificationMap.get(entity.create[0])?.entityHint ?? null
    : null;

  // Pre-scan: identify which secondary resource families have producers.
  // A producer is a non-consuming tool whose entityHint doesn't match the primary family.
  // Only use secondary routing when a producer exists — otherwise fall back to createdRecordId.
  // This prevents tools like getTimelines(recordId) from being mapped to non-existent IDs.
  const availableSecondaryFamilies = new Set<string>();
  const allToolNames = [
    ...entity.read, ...entity.update, ...entity.other, ...entity.search,
  ];
  for (const tn of allToolNames) {
    const cls = classificationMap.get(tn);
    if (!cls) continue;
    const hint = cls.entityHint ?? null;
    if (!hint || isPrimaryEntity(hint, primaryEntityHint)) continue;
    // Non-consuming tools are producers (e.g., Get_Tags captures tag IDs)
    if (!cls.consumesId) {
      availableSecondaryFamilies.add(extractResourceFamily(hint));
    }
    // Secondary creators (tag/assign) also produce secondary entity IDs
    const op = cls.operation;
    if (op === 'tag' || op === 'assign') {
      availableSecondaryFamilies.add(extractResourceFamily(hint));
    }
  }

  // Step: Create (if available — need exactly one record for subsequent tests)
  if (hasCreate) {
    const createTool = entity.create[0];
    steps.push(buildCreateStep(stepIndex++, createTool, entity.entityName, toolMap.get(createTool), config));
  }

  // Split update tools into secondary creators and remaining updates.
  // Secondary creators (tag/assign operations) create/associate secondary entities
  // with the primary record. They must run BETWEEN read producers and read consumers
  // so downstream tools can access the secondary entity IDs they produce.
  const secondaryCreators: string[] = [];
  const remainingUpdates: string[] = [];
  for (const toolName of entity.update) {
    const cls = classificationMap.get(toolName);
    const op = cls?.operation;
    if (op === 'tag' || op === 'assign') {
      secondaryCreators.push(toolName);
    } else {
      remainingUpdates.push(toolName);
    }
  }

  // Steps: ALL Read tools + Secondary Creators interleaved
  // Ordering: Read[0] → Read-Producers → Secondary-Creators → Read-Consumers
  //
  // First read tool uses buildReadStep (hardcoded to fetch by createdRecordId).
  // Remaining reads are split: producers (non-consuming) run first to capture IDs,
  // then secondary creators associate entities, then consumers use those IDs.
  if (hasCreate && entity.read.length > 0) {
    steps.push(buildReadStep(stepIndex++, entity.read[0], entity.entityName, toolMap.get(entity.read[0])));
  }
  const readStart = hasCreate ? 1 : 0;
  const remainingReads = entity.read.slice(readStart);

  // Split remaining reads into producers and consumers
  const readProducers: string[] = [];
  const readConsumers: string[] = [];
  for (const tn of remainingReads) {
    const consumes = classificationMap.get(tn)?.consumesId ?? false;
    if (consumes) {
      readConsumers.push(tn);
    } else {
      readProducers.push(tn);
    }
  }

  // Add read producers first (they capture secondary entity IDs)
  for (const toolName of readProducers) {
    steps.push(buildGenericStep(stepIndex++, toolName, entity.entityName, 'read',
      toolMap.get(toolName), classificationMap.get(toolName), primaryEntityHint, availableSecondaryFamilies));
  }

  // Add secondary creators (e.g., Add_Tags) — they consume createdRecordId
  // and associate secondary entities with the primary record.
  // NOTE: No outputMappings here. The read producer (e.g., Get_Tags) already
  // captured the correct fetched_{family}_id. Secondary creator responses
  // typically contain the PRIMARY record ID in standard paths (data[0].details.id),
  // NOT the secondary entity ID — adding outputMappings would overwrite the
  // correct tag/field/layout ID with a record ID.
  if (hasCreate) {
    for (const toolName of secondaryCreators) {
      const cls = classificationMap.get(toolName);
      const op = cls?.operation ?? 'other';
      const step = buildGenericStep(stepIndex++, toolName, entity.entityName, op,
        toolMap.get(toolName), cls, primaryEntityHint, availableSecondaryFamilies);
      steps.push(step);
    }
  }

  // Add read consumers — they can now access IDs from both producers AND secondary creators
  for (const toolName of readConsumers) {
    steps.push(buildGenericStep(stepIndex++, toolName, entity.entityName, 'read',
      toolMap.get(toolName), classificationMap.get(toolName), primaryEntityHint, availableSecondaryFamilies));
  }

  // Steps: ALL remaining Update tools (excludes secondary creators already added above)
  // Only include if we have a create step (updates need a record to modify)
  if (hasCreate) {
    for (let i = 0; i < remainingUpdates.length; i++) {
      const toolName = remainingUpdates[i];
      if (i === 0) {
        steps.push(buildUpdateStep(stepIndex++, toolName, entity.entityName, toolMap.get(toolName), config));
      } else {
        // Upsert on primary entity needs create-compatible body data (upsert = create-or-update)
        const cls = classificationMap.get(toolName);
        if (cls?.operation === 'upsert' && isPrimaryEntity(cls?.entityHint ?? null, primaryEntityHint)) {
          const testData = getTestDataFromSchema(entity.entityName, toolMap.get(toolName)?.inputSchema, config.testDataOverrides);
          steps.push(buildUpsertStep(stepIndex++, toolName, entity.entityName, toolMap.get(toolName), testData, cls));
        } else {
          steps.push(buildGenericStep(stepIndex++, toolName, entity.entityName, cls?.operation ?? 'other', toolMap.get(toolName), cls, primaryEntityHint, availableSecondaryFamilies));
        }
      }
    }
  }

  // Steps: ALL Other tools
  for (const toolName of entity.other) {
    const classification = classificationMap.get(toolName);
    // If no create step, only include "other" tools that don't need a record ID
    if (!hasCreate && (classification?.idParamPaths ?? []).length > 0) {
      continue;
    }
    steps.push(buildGenericStep(stepIndex++, toolName, entity.entityName, classification?.operation ?? 'other', toolMap.get(toolName), classification, primaryEntityHint, availableSecondaryFamilies));
  }

  // Steps: ALL Search tools
  for (let i = 0; i < entity.search.length; i++) {
    const toolName = entity.search[i];
    if (i === 0) {
      steps.push(buildSearchStep(stepIndex++, toolName, entity.entityName, toolMap.get(toolName)));
    } else {
      steps.push(buildGenericStep(stepIndex++, toolName, entity.entityName, 'search', toolMap.get(toolName), classificationMap.get(toolName), primaryEntityHint, availableSecondaryFamilies));
    }
  }

  // Step: Delete (if available — cleanup)
  if (hasDelete && hasCreate) {
    const deleteTool = entity.delete[0];
    steps.push(buildDeleteStep(stepIndex, deleteTool, entity.entityName, toolMap.get(deleteTool)));
    cleanupSteps.push(buildDeleteStep(0, deleteTool, entity.entityName, toolMap.get(deleteTool)));
  }

  // Skip if no steps were generated (all tools were filtered out)
  if (steps.length === 0) {
    return null;
  }

  const mode = hasCreate && hasDelete ? 'full' : hasCreate ? 'create-only' : 'read-only';
  return {
    id: `workflow.crud.${entity.entityName}`,
    name: `All tools: ${entity.entityName}`,
    description: `Test ${steps.length} tools for ${entity.entityName} (${mode})`,
    entity: entity.entityName,
    steps,
    cleanupSteps,
  };
}

// === Step Builders ===

function buildCreateStep(
  stepIndex: number,
  toolName: string,
  entity: string,
  tool: DiscoveredTool | undefined,
  config: WorkflowConfig,
): WorkflowStepDef {
  const testData = getTestDataFromSchema(entity, tool?.inputSchema, config.testDataOverrides);
  const argsTemplate = buildArgsFromSchema(tool, {
    moduleValue: entity,
    bodyData: [testData],
  });

  return {
    stepIndex,
    toolName,
    operation: 'create',
    description: `Create a ${entity} record`,
    argsTemplate,
    outputMappings: RESPONSE_ID_PATHS.map((path) => ({
      name: 'createdRecordId',
      path,
    })),
    inputMappings: [],
  };
}

function buildReadStep(
  stepIndex: number,
  toolName: string,
  entity: string,
  tool: DiscoveredTool | undefined,
): WorkflowStepDef {
  const argsTemplate = buildArgsFromSchema(tool, {
    moduleValue: entity,
  });

  return {
    stepIndex,
    toolName,
    operation: 'read',
    description: `Read the created ${entity} record`,
    argsTemplate,
    outputMappings: [
      { name: 'readData', path: 'data[0]' },
    ],
    inputMappings: [
      { paramPath: 'query_params.ids', fromOutput: 'createdRecordId' },
    ],
  };
}

function buildUpdateStep(
  stepIndex: number,
  toolName: string,
  entity: string,
  tool: DiscoveredTool | undefined,
  config: WorkflowConfig,
): WorkflowStepDef {
  const updateData = getUpdateTestData(entity, config.testDataOverrides);
  const argsTemplate = buildArgsFromSchema(tool, {
    moduleValue: entity,
    bodyData: [updateData],
  });

  return {
    stepIndex,
    toolName,
    operation: 'update',
    description: `Update the created ${entity} record`,
    argsTemplate,
    outputMappings: [],
    inputMappings: [
      { paramPath: 'body.data[0].id', fromOutput: 'createdRecordId' },
    ],
  };
}

function buildSearchStep(
  stepIndex: number,
  toolName: string,
  entity: string,
  tool: DiscoveredTool | undefined,
): WorkflowStepDef {
  const argsTemplate = buildArgsFromSchema(tool, {
    moduleValue: entity,
    searchWord: 'MCPProbeTest',
  });

  return {
    stepIndex,
    toolName,
    operation: 'search',
    description: `Search for the created ${entity} record`,
    argsTemplate,
    outputMappings: [
      { name: 'searchFoundId', path: 'data[0].id' },
    ],
    inputMappings: [],
  };
}

function buildDeleteStep(
  stepIndex: number,
  toolName: string,
  entity: string,
  tool: DiscoveredTool | undefined,
): WorkflowStepDef {
  const argsTemplate = buildArgsFromSchema(tool, {
    moduleValue: entity,
  });

  return {
    stepIndex,
    toolName,
    operation: 'delete',
    description: `Delete the created ${entity} record (cleanup)`,
    argsTemplate,
    outputMappings: [],
    inputMappings: [
      { paramPath: 'query_params.ids', fromOutput: 'createdRecordId' },
    ],
  };
}

/**
 * Build an upsert step with create-compatible body data.
 *
 * Upsert = create-or-update, so it needs the same body data as a create step
 * (e.g., Last_Name for Leads). Without this, the body.data item would be empty
 * and the API would reject it with MANDATORY_NOT_FOUND.
 */
function buildUpsertStep(
  stepIndex: number,
  toolName: string,
  entity: string,
  tool: DiscoveredTool | undefined,
  testData: Record<string, unknown>,
  classification: ToolClassification | undefined,
): WorkflowStepDef {
  const argsTemplate = buildArgsFromSchema(tool, {
    moduleValue: entity,
    bodyData: [testData],
  });
  // Route createdRecordId to all detected ID param paths (normalized)
  const inputMappings = (classification?.idParamPaths ?? []).map((path) => ({
    paramPath: path.replace(/\[\]/g, '[0]'),
    fromOutput: 'createdRecordId',
  }));
  return {
    stepIndex,
    toolName,
    operation: 'upsert',
    description: `Upsert ${entity} record`,
    argsTemplate,
    outputMappings: [],
    inputMappings,
  };
}

/**
 * Determine if an ID param path is a "primary-level" path that should always
 * receive a routed value regardless of entity context:
 *   - path_variables.* (URL route segments)
 *   - query_params.* (URL query parameters)
 *   - body.id (direct record ID)
 *   - body.ids or body.ids[N] (record ID arrays)
 *   - body.data[N].id (main record data array)
 *
 * These paths are safe for BOTH createdRecordId and fetched_*_id routing.
 */
function isPrimaryLevelPath(path: string): boolean {
  // path_variables and query_params are always routable
  if (path.startsWith('path_variables.') || path.startsWith('query_params.')) {
    return true;
  }

  // body.id — direct record ID at body root
  if (path === 'body.id') return true;

  // body.ids or body.ids[N] — record ID arrays
  if (path === 'body.ids' || /^body\.ids\[\d+\]$/.test(path)) return true;

  // body.data[N].id — main record data array (the primary entity array)
  if (/^body\.data\[\d+\]\.id$/.test(path)) return true;

  return false;
}

/**
 * Check if a nested body path belongs to the tool's own entity family.
 *
 * For secondary entity consumers (e.g., Update_Tag with family "tag"),
 * the path `body.tags[0].id` should receive `fetched_tag_id` because
 * "tags" matches the "tag" family. But `body.tags[0].profiles[0].id`
 * should NOT receive the tag ID — that's a profile ID nested inside.
 *
 * We only match the FIRST array segment after `body.` to ensure we're
 * routing into the entity's own top-level array, not a nested sub-entity.
 *
 * Examples for family="tag":
 *   body.tags[0].id → matches (tags ~ tag) → route fetched_tag_id ✓
 *   body.tags[0].name → not an ID field, won't be in idParamPaths
 *   body.data[0].tags[0].id → does NOT match (first array is "data", not entity)
 *
 * Examples for family="layout":
 *   body.layouts[0].id → matches (layouts ~ layout) ✓
 *   body.layouts[0].profiles[0].id → does NOT match (id is under profiles, not layouts)
 *
 * Examples for family="field":
 *   body.fields[0].id → matches (fields ~ field) ✓
 *   body.fields[0].profiles[0].id → does NOT match (nested under profiles)
 */
function isEntityOwnedPath(path: string, entityFamily: string): boolean {
  // Only look at body paths that aren't primary-level
  if (!path.startsWith('body.') || isPrimaryLevelPath(path)) return false;

  // Extract: body.<arrayName>[N].id — the first array segment's name
  // Pattern: body.{arrayName}[{digit}].id
  const match = path.match(/^body\.(\w+)\[\d+\]\.id$/);
  if (!match) return false;

  const arrayName = match[1].toLowerCase();
  const familyLower = entityFamily.toLowerCase();

  // Check if the array name matches the entity family:
  // "tags" matches "tag", "layouts" matches "layout", "fields" matches "field"
  // Use singularize to normalize: tags→tag, layouts→layout
  const singularArray = singularize(arrayName);
  return singularArray === familyLower || arrayName === familyLower;
}

/**
 * Build a generic step with resource-aware ID routing.
 *
 * When a CREATE step establishes a primary resource family (e.g., "Records"),
 * tools that operate on the same family use `createdRecordId`. Tools that
 * operate on a different resource family (e.g., "Fields", "Layouts") are
 * treated as secondary resources:
 *   - Non-consuming secondary tools (producers) capture resource IDs via outputMappings
 *   - Consuming secondary tools use the captured resource-specific IDs
 *
 * FALLBACK: If a consuming secondary tool's resource family has NO producer,
 * it falls back to `createdRecordId`. This handles tools like getTimelines(recordId)
 * that have a non-"Records" entityHint but actually operate on records.
 *
 * This is fully generic — works for any MCP product, not just CRM.
 */
function buildGenericStep(
  stepIndex: number,
  toolName: string,
  entity: string,
  operation: CRUDOperation,
  tool: DiscoveredTool | undefined,
  classification: ToolClassification | undefined,
  primaryEntityHint?: string | null,
  availableSecondaryFamilies?: Set<string>,
): WorkflowStepDef {
  const argsTemplate = buildArgsFromSchema(tool, { moduleValue: entity });

  const hint = classification?.entityHint ?? null;
  const primary = isPrimaryEntity(hint, primaryEntityHint ?? null);

  let inputMappings: { paramPath: string; fromOutput: string }[];
  let outputMappings: { name: string; path: string }[];

  // Normalize [] to [0] in idParamPaths — walkSchemaProperties uses [] for array items
  // but setNestedField/parsePath requires [digit] format. Without this, body array IDs
  // like body.fields[].id silently fail to resolve.
  const normalizedIdPaths = (classification?.idParamPaths ?? []).map(
    (p) => p.replace(/\[\]/g, '[0]'),
  );

  // Primary-level paths: path_variables, query_params, body.data[N].id, body.ids, body.id.
  // These are safe for ANY ID source (createdRecordId or fetched_*_id).
  const primaryPaths = normalizedIdPaths.filter(isPrimaryLevelPath);

  if (primary) {
    // Primary entity tool — route createdRecordId ONLY to primary-level paths.
    // Nested body array IDs (body.tags[0].id, etc.) are different entities and
    // must NOT receive the primary record ID.
    //
    // SMART ROUTING: For path_variables that contain a secondary entity family name
    // (e.g., path_variables.tag_id → "tag" family), route the fetched secondary ID
    // instead of createdRecordId. This handles mixed-entity tools like
    // Get_Record_Count_For_Tag which has both record_id AND tag_id in path_variables.
    inputMappings = primaryPaths.map((path) => {
      if (path.startsWith('path_variables.') && availableSecondaryFamilies) {
        const paramName = path.split('.').pop()!.toLowerCase();
        for (const family of availableSecondaryFamilies) {
          if (paramName.includes(family)) {
            return { paramPath: path, fromOutput: `fetched_${family}_id` };
          }
        }
      }
      return { paramPath: path, fromOutput: 'createdRecordId' };
    });
    outputMappings = [];
  } else {
    // Secondary resource tool — needs resource-specific IDs
    const family = extractResourceFamily(hint!);

    // Find matching producer family — try exact match first, then suffix match.
    // Suffix matching handles cases like "custom_layout" matching producer "layout".
    let matchedFamily = family;
    if (availableSecondaryFamilies && !availableSecondaryFamilies.has(family)) {
      const suffixMatch = [...availableSecondaryFamilies].find(
        (f) => family.endsWith('_' + f),
      );
      if (suffixMatch) matchedFamily = suffixMatch;
    }
    const hasProducer = availableSecondaryFamilies?.has(matchedFamily) ?? false;

    if (!classification?.consumesId) {
      // PRODUCER: returns a list of resources → capture first ID for downstream consumers
      const outputKey = `fetched_${family}_id`;
      const plural = family.endsWith('y')
        ? family.slice(0, -1) + 'ies'
        : family + 's';
      outputMappings = [
        { name: outputKey, path: `${plural}[0].id` },
        ...RESPONSE_ID_PATHS.map((p) => ({ name: outputKey, path: p })),
      ];
      inputMappings = [];  // Don't inject record IDs into list/producer tools
    } else if (hasProducer) {
      // CONSUMER with available producer: split routing between entities.
      // - Entity-owned nested body paths (e.g., body.tags[0].id) → fetched_{family}_id
      // - Primary-level paths (path_variables, body.ids, etc.) → createdRecordId
      //   EXCEPT path_variables containing the family name (e.g., tag_id → fetched_tag_id)
      // This ensures Add_Tags gets createdRecordId in path_variables.record_id,
      // but Update_Tag gets fetched_tag_id in body.tags[0].id.
      const outputKey = `fetched_${matchedFamily}_id`;
      const entityOwnedPaths = normalizedIdPaths.filter(
        (p) => isEntityOwnedPath(p, matchedFamily),
      );
      inputMappings = [
        // Entity-owned paths → fetched_{family}_id
        ...entityOwnedPaths.map((path) => ({
          paramPath: path,
          fromOutput: outputKey,
        })),
        // Primary-level paths: smart routing for path_variables
        // - Generic "id" or param containing the family name → fetched_{family}_id (tool's own entity)
        // - Other params (e.g., record_id, module_api_name) → createdRecordId
        // Non-path_variables primary paths (body.ids, body.data[0].id) → createdRecordId
        ...primaryPaths.map((path) => {
          if (path.startsWith('path_variables.')) {
            const paramName = path.split('.').pop()!.toLowerCase();
            if (paramName === 'id' || paramName.includes(matchedFamily)) {
              return { paramPath: path, fromOutput: outputKey };
            }
          }
          return { paramPath: path, fromOutput: 'createdRecordId' };
        }),
      ];
      outputMappings = [];
    } else {
      // CONSUMER with NO producer: fall back to createdRecordId.
      // This handles tools like getTimelines(recordId) that have a non-primary
      // entityHint but actually operate on records.
      // Only route to primary-level paths — no nested body arrays.
      //
      // SMART ROUTING: Even without a direct producer match, check path_variables
      // for secondary family names. Tools like Get_Record_Count_For_Tag have
      // entityHint "Count" (no producer), but their path_variables.tag_id should
      // still route to fetched_tag_id if a tag producer exists.
      inputMappings = primaryPaths.map((path) => {
        if (path.startsWith('path_variables.') && availableSecondaryFamilies) {
          const paramName = path.split('.').pop()!.toLowerCase();
          for (const family of availableSecondaryFamilies) {
            if (paramName.includes(family)) {
              return { paramPath: path, fromOutput: `fetched_${family}_id` };
            }
          }
        }
        return { paramPath: path, fromOutput: 'createdRecordId' };
      });
      outputMappings = [];
    }
  }

  return {
    stepIndex,
    toolName,
    operation,
    description: `Test ${toolName} on ${entity}`,
    argsTemplate,
    outputMappings,
    inputMappings,
  };
}

// === Schema-Aware Argument Builder ===

interface ArgBuildHints {
  moduleValue?: string;
  bodyData?: Record<string, unknown>[];
  searchWord?: string;
}

/**
 * Build arguments from a tool's input schema, using hints for specific fields.
 *
 * This walks the schema and:
 * - Fills module/entity params with the provided entity name
 * - Fills data arrays with test data
 * - Fills search params with the search word
 * - Fills other required fields with generated values from the fuzzer
 */
function buildArgsFromSchema(
  tool: DiscoveredTool | undefined,
  hints: ArgBuildHints,
): Record<string, unknown> {
  if (!tool?.inputSchema) {
    // Fallback: build minimal args from hints
    const args: Record<string, unknown> = {};
    if (hints.moduleValue) {
      args.path_variables = { module: hints.moduleValue };
    }
    if (hints.bodyData) {
      args.body = { data: hints.bodyData };
    }
    if (hints.searchWord) {
      args.query_params = { word: hints.searchWord };
    }
    return args;
  }

  const args: Record<string, unknown> = {};
  const schema = tool.inputSchema;
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = (schema.required ?? []) as string[];

  for (const key of Object.keys(properties)) {
    const propSchema = properties[key];
    const isRequired = required.includes(key);

    if (key === 'path_variables' || key === 'path_params') {
      args[key] = buildPathVariables(propSchema, hints);
    } else if (key === 'body') {
      args[key] = buildBody(propSchema, hints);
    } else if (key === 'query_params') {
      args[key] = buildQueryParams(propSchema, hints);
    } else if (key === 'headers') {
      // Skip headers — handled by transport/auth
    } else if (isRequired) {
      args[key] = generateValidValue(propSchema);
    }
  }

  return args;
}

function buildPathVariables(
  schema: Record<string, unknown>,
  hints: ArgBuildHints,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;

  for (const key of Object.keys(properties)) {
    if (/^module/i.test(key) && hints.moduleValue) {
      result[key] = hints.moduleValue;
    }
    // Don't fill other required fields here — they'll be resolved by
    // inputMappings (IDs) or enhanceWithSchemaArgs in the PIV loop
  }

  return result;
}

function buildBody(
  schema: Record<string, unknown>,
  hints: ArgBuildHints,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = (schema.required ?? []) as string[];

  for (const key of Object.keys(properties)) {
    const propSchema = properties[key];

    if (key === 'data' && hints.bodyData) {
      result.data = hints.bodyData;
    } else if (required.includes(key)) {
      // Use fillRequiredFields for arrays so items get proper sub-fields
      // (generateValidValue returns [] for arrays, causing INVALID_DATA)
      // Pass skipIdFields: true so synthetic "MCPProbeTest" IDs aren't injected
      // into array items — real IDs come from producers/inputMappings at runtime.
      if (propSchema.type === 'array') {
        result[key] = fillRequiredFields(propSchema, { skipIdFields: true }, `body.${key}`);
      } else {
        result[key] = generateValidValue(propSchema);
      }
    }
  }

  return result;
}

function buildQueryParams(
  schema: Record<string, unknown>,
  hints: ArgBuildHints,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = (schema.required ?? []) as string[];

  for (const key of Object.keys(properties)) {
    // Only fill module if it's REQUIRED — optional module params change API behavior
    if (/^module/i.test(key) && hints.moduleValue && required.includes(key)) {
      result[key] = hints.moduleValue;
    } else if (key === 'word' && hints.searchWord) {
      result.word = hints.searchWord;
    } else if (key === 'criteria' && hints.searchWord) {
      result.criteria = `(Last_Name:equals:${hints.searchWord})`;
    }
  }

  return result;
}
