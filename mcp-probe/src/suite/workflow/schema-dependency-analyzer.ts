/**
 * Schema Dependency Analyzer — structural schema analysis for inter-tool ID routing.
 *
 * Replaces brittle name-substring matching (e.g., "portal_id".includes("portal"))
 * with schema-driven dependency resolution that works for ANY MCP server.
 *
 * For each tool, builds a dependency profile:
 *   - What ID params does this tool require? (RequiredIdParam[])
 *   - What IDs does this tool's response produce? (OutputIdShape[])
 *   - What entity family does each param refer to? (inferred from name + schema description)
 *
 * Then resolves inter-tool dependencies by matching consumers' required params
 * to producers' output shapes.
 */
import type { DiscoveredTool } from '../../client/mcp-client.js';
import type { CRUDOperation, EntityGroup, ToolClassification } from './types.js';
import { extractResourceFamily, singularize, RESPONSE_ID_PATHS } from './crud-patterns.js';

// === Types ===

export interface RequiredIdParam {
  paramPath: string;           // e.g., "path_variables.portal_id"
  paramName: string;           // e.g., "portal_id"
  isRequired: boolean;         // from JSON Schema required array
  inferredFamily: string;      // e.g., "portal" (from name, description, or schema)
  schemaType: string;          // "string" | "integer" | "number"
  description: string;         // raw description from schema
  sourceLocation: 'path_variables' | 'query_params' | 'body' | 'other';
}

export interface OutputIdShape {
  producerToolName: string;
  extractionPaths: string[];   // ordered: try first, fallback to later
  inferredFamily: string;      // what kind of entity this ID refers to
  confidence: number;          // 0–1
}

export interface ResolvedDependency {
  consumerToolName: string;
  paramPath: string;           // where to inject in consumer args
  requiredId: RequiredIdParam;
  producer: OutputIdShape | null;  // null = cannot be resolved
  storeKey: string;            // key in outputStore: "createdRecordId" or "fetched_portal_id"
  fallbackStoreKeys: string[]; // try these if primary storeKey is missing
}

export interface ToolDependencyProfile {
  toolName: string;
  requiredIdParams: RequiredIdParam[];
  optionalIdParams: RequiredIdParam[];
  producedIdShapes: OutputIdShape[];
  inferredOperation: CRUDOperation;
  inferredEntity: string | null;
}

// === Analysis ===

/**
 * Build dependency profiles for all tools.
 * Analyzes each tool's input schema to extract required/optional ID params
 * and infer what IDs the tool's response might produce.
 */
export function analyzeToolDependencies(
  tools: DiscoveredTool[],
  classifications: ToolClassification[],
): Map<string, ToolDependencyProfile> {
  const classMap = new Map(classifications.map((c) => [c.toolName, c]));
  const profiles = new Map<string, ToolDependencyProfile>();

  for (const tool of tools) {
    const cls = classMap.get(tool.name);
    if (!cls) continue;

    const profile = buildToolProfile(tool, cls);
    profiles.set(tool.name, profile);
  }

  return profiles;
}

/**
 * Build a dependency profile for a single tool.
 */
function buildToolProfile(
  tool: DiscoveredTool,
  classification: ToolClassification,
): ToolDependencyProfile {
  const requiredIdParams: RequiredIdParam[] = [];
  const optionalIdParams: RequiredIdParam[] = [];

  // Walk input schema to extract ID params with required/optional status
  if (tool.inputSchema) {
    walkForIdParams(tool.inputSchema, '', requiredIdParams, optionalIdParams);
  }

  // Infer output shapes based on operation type and entity hint
  const producedIdShapes = inferOutputShapes(tool.name, classification);

  return {
    toolName: tool.name,
    requiredIdParams,
    optionalIdParams,
    producedIdShapes,
    inferredOperation: classification.operation,
    inferredEntity: classification.entityHint,
  };
}

/**
 * Walk a tool's input schema to extract ID parameters with their required/optional status.
 */
function walkForIdParams(
  schema: Record<string, unknown>,
  prefix: string,
  required: RequiredIdParam[],
  optional: RequiredIdParam[],
  depth = 0,
): void {
  if (depth > 3) return;

  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties) return;

  const requiredFields = Array.isArray(schema.required) ? schema.required as string[] : [];

  for (const [key, propSchema] of Object.entries(properties)) {
    if (!propSchema || typeof propSchema !== 'object') continue;

    const fullPath = prefix ? `${prefix}.${key}` : key;
    const isRequired = requiredFields.includes(key);

    // Check if this looks like an ID field
    if (isIdField(key)) {
      const param: RequiredIdParam = {
        paramPath: fullPath,
        paramName: key,
        isRequired,
        inferredFamily: inferFamilyFromParam(key, propSchema.description as string | undefined),
        schemaType: (propSchema.type as string) ?? 'string',
        description: (propSchema.description as string) ?? '',
        sourceLocation: getSourceLocation(fullPath),
      };

      if (isRequired) {
        required.push(param);
      } else {
        optional.push(param);
      }
    }

    // Recurse into nested objects
    if (propSchema.type === 'object' && propSchema.properties) {
      walkForIdParams(propSchema as Record<string, unknown>, fullPath, required, optional, depth + 1);
    }

    // Recurse into array items
    if (propSchema.type === 'array' && propSchema.items) {
      const items = propSchema.items as Record<string, unknown>;
      if (items.type === 'object' && items.properties) {
        walkForIdParams(items, `${fullPath}[]`, required, optional, depth + 1);
      }
    }
  }
}

// === ID Field Detection ===

const ID_PATTERNS = [
  /^id$/i,
  /^ids$/i,
  /^record_id$/i,
  /[_.]id$/i,
  /Id$/,
  /^id_string$/i,
];

function isIdField(name: string): boolean {
  return ID_PATTERNS.some((p) => p.test(name));
}

// === Family Inference ===

/**
 * Infer the entity family from a parameter name and/or its schema description.
 *
 * Three-tier strategy:
 *   Tier 1 (name-based): "portal_id" → "portal", "project_id" → "project"
 *   Tier 2 (description-based): "The ID of the portal" → "portal"
 *   Tier 3 (fallback): "id" → "record" (generic)
 */
function inferFamilyFromParam(paramName: string, description?: string): string {
  // Tier 1: Extract family from param name
  const nameFamily = extractFamilyFromName(paramName);
  if (nameFamily && nameFamily !== 'record') return nameFamily;

  // Tier 2: Extract family from description
  if (description) {
    const descFamily = extractFamilyFromDescription(description);
    if (descFamily) return descFamily;
  }

  // Tier 3: Generic fallback
  return nameFamily ?? 'record';
}

/**
 * Extract entity family from a parameter name.
 * "portal_id" → "portal", "project_id" → "project", "ids" → "record"
 */
function extractFamilyFromName(paramName: string): string | null {
  const lower = paramName.toLowerCase();

  // Exact matches for generic ID fields
  if (lower === 'id' || lower === 'ids' || lower === 'id_string') return 'record';

  // Strip _id/_ids suffix and extract family
  // portal_id → portal, project_id → project, record_id → record
  const suffixMatch = lower.match(/^(.+?)_?ids?$/i);
  if (suffixMatch) {
    const family = suffixMatch[1].replace(/_$/, '');
    if (family.length > 0) return singularize(family);
  }

  // camelCase: portalId → portal, projectId → project
  const camelMatch = lower.match(/^(.+?)id$/i);
  if (camelMatch) {
    const family = camelMatch[1];
    if (family.length > 1) return singularize(family.toLowerCase());
  }

  return null;
}

/**
 * Extract entity family from a schema description.
 * "The ID of the portal" → "portal"
 * "Unique identifier of the project" → "project"
 */
function extractFamilyFromDescription(description: string): string | null {
  const lower = description.toLowerCase();

  // Pattern: "ID/identifier of the <entity>"
  const ofMatch = lower.match(/(?:id|identifier)\s+(?:of|for)\s+(?:the|a|an)?\s*(\w+)/);
  if (ofMatch) return singularize(ofMatch[1]);

  // Pattern: "the <entity> ID/identifier"
  const theMatch = lower.match(/(?:the|a|an)\s+(\w+)\s+(?:id|identifier)/);
  if (theMatch) return singularize(theMatch[1]);

  return null;
}

function getSourceLocation(path: string): RequiredIdParam['sourceLocation'] {
  if (path.startsWith('path_variables.')) return 'path_variables';
  if (path.startsWith('query_params.')) return 'query_params';
  if (path.startsWith('body.') || path === 'body') return 'body';
  return 'other';
}

// === Output Shape Inference ===

/**
 * Infer what IDs a tool's response might contain, based on its operation type
 * and entity hint. This is used to determine which tools are "producers" that
 * can supply IDs to downstream consumers.
 */
function inferOutputShapes(
  toolName: string,
  classification: ToolClassification,
): OutputIdShape[] {
  const shapes: OutputIdShape[] = [];
  const hint = classification.entityHint;
  if (!hint) return shapes;

  const family = extractResourceFamily(hint);

  // Create operations produce the primary entity's ID
  if (classification.producesId) {
    shapes.push({
      producerToolName: toolName,
      extractionPaths: [...RESPONSE_ID_PATHS],
      inferredFamily: family,
      confidence: 0.9,
    });
  }

  // Read/list operations without consuming IDs are producers (capture existing IDs)
  if (!classification.consumesId &&
      (classification.operation === 'read' || classification.operation === 'list')) {
    const plural = family.endsWith('y')
      ? family.slice(0, -1) + 'ies'
      : family + 's';
    shapes.push({
      producerToolName: toolName,
      extractionPaths: [
        `${plural}[0].id`,
        `${plural}[0].id_string`,
        ...RESPONSE_ID_PATHS,
      ],
      inferredFamily: family,
      confidence: 0.7,
    });
  }

  return shapes;
}

// === Inter-Tool Dependency Resolution ===

/**
 * Resolve dependencies between tools: for each consumer's required ID param,
 * find the best producer that can supply that ID.
 */
export function resolveInterToolDependencies(
  profiles: Map<string, ToolDependencyProfile>,
  _entityGroups: EntityGroup[],
): Map<string, ResolvedDependency[]> {
  const result = new Map<string, ResolvedDependency[]>();

  // Build a map of all known producer shapes indexed by family
  const producersByFamily = new Map<string, OutputIdShape[]>();
  for (const profile of profiles.values()) {
    for (const shape of profile.producedIdShapes) {
      const family = shape.inferredFamily;
      if (!producersByFamily.has(family)) producersByFamily.set(family, []);
      producersByFamily.get(family)!.push(shape);
    }
  }

  // For each tool, resolve its required ID params
  for (const profile of profiles.values()) {
    const deps: ResolvedDependency[] = [];

    for (const param of profile.requiredIdParams) {
      // Skip query_params — they're optional filters, not hard dependencies
      if (param.sourceLocation === 'query_params') continue;

      const dep = resolveParam(param, profile.toolName, producersByFamily);
      deps.push(dep);
    }

    if (deps.length > 0) {
      result.set(profile.toolName, deps);
    }
  }

  return result;
}

/**
 * Resolve a single required ID param to its best producer.
 */
function resolveParam(
  param: RequiredIdParam,
  consumerToolName: string,
  producersByFamily: Map<string, OutputIdShape[]>,
): ResolvedDependency {
  const family = param.inferredFamily;

  // Try exact family match
  let candidates = producersByFamily.get(family);

  // Try substring/fuzzy match if exact fails
  if (!candidates || candidates.length === 0) {
    for (const [prodFamily, shapes] of producersByFamily) {
      if (prodFamily.includes(family) || family.includes(prodFamily)) {
        candidates = shapes;
        break;
      }
    }
  }

  // Best candidate: prefer create ops (highest confidence), then read/list
  const producer = candidates
    ?.filter((c) => c.producerToolName !== consumerToolName)  // no self-dependency
    .sort((a, b) => b.confidence - a.confidence)[0] ?? null;

  // Build store key
  const storeKey = family === 'record' ? 'createdRecordId' : `fetched_${family}_id`;

  // Build fallback keys: try createdRecordId as a universal fallback,
  // plus any fuzzy family variants
  const fallbackKeys: string[] = [];
  if (storeKey !== 'createdRecordId') {
    fallbackKeys.push('createdRecordId');
  }
  // Also try the producer's family key if different from the param's family
  if (producer && producer.inferredFamily !== family) {
    fallbackKeys.push(`fetched_${producer.inferredFamily}_id`);
  }

  return {
    consumerToolName,
    paramPath: param.paramPath,
    requiredId: param,
    producer,
    storeKey,
    fallbackStoreKeys: fallbackKeys,
  };
}

// === Entity-Level Dependency Detection ===

/**
 * Detect which entities depend on which other entities.
 * Returns a map: entityName → Set of entity names it depends on.
 *
 * Used by the entity dependency graph for topological sorting.
 */
export function detectEntityDependencies(
  entityGroups: EntityGroup[],
  profiles: Map<string, ToolDependencyProfile>,
): Map<string, Set<string>> {
  const deps = new Map<string, Set<string>>();

  // Build a map from tool name to its entity group
  const toolToEntity = new Map<string, string>();
  for (const group of entityGroups) {
    const allTools = [
      ...group.create, ...group.read, ...group.update,
      ...group.delete, ...group.search, ...group.other,
    ];
    for (const toolName of allTools) {
      toolToEntity.set(toolName, group.entityName);
    }
  }

  // Build a map from family to which entity produces it
  const familyToProducerEntity = new Map<string, string>();
  for (const profile of profiles.values()) {
    const entityName = toolToEntity.get(profile.toolName);
    if (!entityName) continue;
    for (const shape of profile.producedIdShapes) {
      // First producer for a family wins (could refine with priority)
      if (!familyToProducerEntity.has(shape.inferredFamily)) {
        familyToProducerEntity.set(shape.inferredFamily, entityName);
      }
    }
  }

  // For each entity, find which other entities it depends on
  for (const group of entityGroups) {
    const entityDeps = new Set<string>();
    const allTools = [
      ...group.create, ...group.read, ...group.update,
      ...group.delete, ...group.search, ...group.other,
    ];

    for (const toolName of allTools) {
      const profile = profiles.get(toolName);
      if (!profile) continue;

      for (const param of profile.requiredIdParams) {
        if (param.sourceLocation === 'query_params') continue; // skip optional filters
        const producerEntity = familyToProducerEntity.get(param.inferredFamily);
        if (producerEntity && producerEntity !== group.entityName) {
          entityDeps.add(producerEntity);
        }
      }
    }

    deps.set(group.entityName, entityDeps);
  }

  return deps;
}
