/**
 * Dependency Detector — analyzes tool schemas to build a dependency graph.
 *
 * Phase 1: Classify each tool (CRUD operation, entity, ID params)
 * Phase 2: Build dependency edges (producer → consumer)
 * Phase 3: Group by entity (Leads, Contacts, etc.)
 */
import type { DiscoveredTool } from '../../client/mcp-client.js';
import type {
  ToolClassification,
  DependencyEdge,
  EntityGroup,
  DependencyGraph,
} from './types.js';
import {
  matchOperation,
  extractEntityHint,
  extractToolPrefix,
  detectCommonPrefix,
  extractResourceFamily,
  ID_FIELD_PATTERNS,
  MODULE_FIELD_PATTERNS,
  RESPONSE_ID_PATHS,
} from './crud-patterns.js';

// === Phase 1: Classify Tools ===

/**
 * Classify each discovered tool by its CRUD operation, entity, and parameter structure.
 */
export function classifyTools(tools: DiscoveredTool[]): ToolClassification[] {
  const globalPrefix = detectCommonPrefix(tools.map((t) => t.name));

  return tools.map((tool) => {
    const { operation, producesId } = matchOperation(tool.name);
    const entityHint = extractEntityHint(tool.name, globalPrefix);
    const { idPaths, requiredIdPaths, optionalIdPaths, moduleParam, moduleValues, consumesId } = analyzeSchema(tool.inputSchema);
    // Store the tool's own prefix (may differ from globalPrefix in multi-product servers)
    const toolPrefix = extractToolPrefix(tool.name) ?? globalPrefix;

    return {
      toolName: tool.name,
      operation,
      entityHint,
      prefixGroup: toolPrefix,
      producesId,
      consumesId,
      idParamPaths: idPaths,
      requiredIdParamPaths: requiredIdPaths,
      optionalIdParamPaths: optionalIdPaths,
      moduleParam,
      moduleValues,
    };
  });
}

/**
 * Analyze a tool's input schema to find ID params, module params, and enum values.
 * Distinguishes required vs optional ID params using JSON Schema `required` arrays.
 */
function analyzeSchema(schema: Record<string, unknown>): {
  idPaths: string[];
  requiredIdPaths: string[];
  optionalIdPaths: string[];
  moduleParam: string | null;
  moduleValues: string[];
  consumesId: boolean;
} {
  const idPaths: string[] = [];
  const requiredIdPaths: string[] = [];
  const optionalIdPaths: string[] = [];
  let moduleParam: string | null = null;
  let moduleValues: string[] = [];

  // Walk the schema properties recursively, tracking required status
  walkSchemaProperties(schema, '', (path, propSchema, isRequired) => {
    const propName = path.split('.').pop() ?? '';

    // Check if this is an ID field
    if (ID_FIELD_PATTERNS.some((p) => p.test(propName))) {
      idPaths.push(path);
      if (isRequired) {
        requiredIdPaths.push(path);
      } else {
        optionalIdPaths.push(path);
      }
    }

    // Check if this is a module/entity field
    if (MODULE_FIELD_PATTERNS.some((p) => p.test(propName))) {
      moduleParam = path;
      // Extract enum values if present
      if (propSchema.enum && Array.isArray(propSchema.enum)) {
        moduleValues = propSchema.enum.filter((v: unknown) => typeof v === 'string') as string[];
      }
    }
  });

  // consumesId is true only when there are REQUIRED ID paths outside query_params.
  // query_params ID paths are always optional filters (getAllProjects works without them).
  // Optional body/path_variables IDs also don't make a tool a "consumer" that blocks on IDs.
  const consumingPaths = requiredIdPaths.filter((p) => !p.startsWith('query_params.'));

  return {
    idPaths,
    requiredIdPaths,
    optionalIdPaths,
    moduleParam,
    moduleValues,
    consumesId: consumingPaths.length > 0,
  };
}

/**
 * Walk all properties in a JSON schema (up to 3 levels deep) and invoke
 * the callback with the dotted path, property schema, and whether the
 * property is in the parent's `required` array.
 */
function walkSchemaProperties(
  schema: Record<string, unknown>,
  prefix: string,
  callback: (path: string, propSchema: Record<string, unknown>, isRequired: boolean) => void,
  depth = 0,
): void {
  if (depth > 3) return; // Prevent infinite recursion

  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties || typeof properties !== 'object') return;

  // Get the `required` array from this schema level
  const requiredFields = Array.isArray(schema.required) ? schema.required as string[] : [];

  for (const [key, propSchema] of Object.entries(properties)) {
    if (!propSchema || typeof propSchema !== 'object') continue;

    const fullPath = prefix ? `${prefix}.${key}` : key;
    const isRequired = requiredFields.includes(key);
    callback(fullPath, propSchema, isRequired);

    // Recurse into nested objects
    if (propSchema.type === 'object' && propSchema.properties) {
      walkSchemaProperties(propSchema as Record<string, unknown>, fullPath, callback, depth + 1);
    }

    // Recurse into array items
    if (propSchema.type === 'array' && propSchema.items) {
      const items = propSchema.items as Record<string, unknown>;
      if (items.type === 'object' && items.properties) {
        walkSchemaProperties(items, `${fullPath}[]`, callback, depth + 1);
      }
    }
  }
}

// === Phase 2: Build Dependency Edges ===

/**
 * Build dependency edges between tools that produce and consume entity IDs.
 */
export function buildDependencyEdges(classifications: ToolClassification[]): DependencyEdge[] {
  const edges: DependencyEdge[] = [];

  const producers = classifications.filter((c) => c.producesId);
  const consumers = classifications.filter((c) => c.consumesId);

  for (const producer of producers) {
    for (const consumer of consumers) {
      // Skip self-dependencies
      if (producer.toolName === consumer.toolName) continue;

      // Check entity compatibility
      const sameEntity =
        producer.entityHint === consumer.entityHint ||
        producer.entityHint === null ||
        consumer.entityHint === null;

      if (!sameEntity) continue;

      // Try known response ID paths for the output
      const outputPath = RESPONSE_ID_PATHS[0]; // Best guess; refined during execution

      edges.push({
        from: producer.toolName,
        to: consumer.toolName,
        outputPath,
        inputPath: consumer.idParamPaths[0] ?? 'id',
        type: 'id',
      });
    }
  }

  return edges;
}

// === Phase 3: Group by Entity ===

/**
 * Group tools by entity/module. If tools have module params with enum values,
 * create one group per enum value. Otherwise group by entity hint.
 *
 * When grouping by module enum, only includes tools whose module param
 * actually accepts that entity name (e.g., only tools with "Leads" in their
 * enum go into the Leads group).
 *
 * @param productPrefix Optional product prefix (e.g., "ZohoWorkdrive") used
 *   to name the fallback group when tools have no entity hint.
 */
export function groupByEntity(
  classifications: ToolClassification[],
  productPrefix?: string,
): EntityGroup[] {
  // Check if tools use a shared module param with enum values
  const withModuleParams = classifications.filter(
    (c) => c.moduleParam !== null && c.moduleValues.length > 0,
  );

  if (withModuleParams.length > 0) {
    const groups: EntityGroup[] = [];

    // Path A: Module-enum groups — mark isModuleScoped: true
    const allModules = new Set<string>();
    for (const c of withModuleParams) {
      for (const m of c.moduleValues) {
        allModules.add(m);
      }
    }

    for (const moduleName of allModules) {
      // Include tools that:
      // 1. Have a module param with enum values that include this entity, OR
      // 2. Have a "primary" module param (top-level path like path_variables.module,
      //    query_params.module) but no enum — these accept any module as free string.
      //    Exclude tools with deeply nested module params (body.data[].module) as
      //    those are internal fields, not the entity-determining parameter.
      const relevantTools = classifications.filter((c) => {
        if (c.moduleParam === null) return false;  // No module param → not relevant
        if (c.moduleValues.includes(moduleName)) return true;  // Enum includes this entity
        if (c.moduleValues.length > 0) return false;  // Has enum but doesn't include this entity
        // No enum — only include if module param is at a primary path
        return isPrimaryModulePath(c.moduleParam);
      });
      const prefix = relevantTools[0]?.prefixGroup ?? classifications[0]?.prefixGroup ?? '';
      const group = buildEntityGroup(moduleName, prefix, relevantTools);
      group.isModuleScoped = true;
      groups.push(group);
    }

    // Path B: Standalone tools (moduleParam === null) — group by entityHint
    const standaloneTools = classifications.filter((c) => c.moduleParam === null);
    if (standaloneTools.length > 0) {
      const standaloneGroups = groupByEntityHint(standaloneTools, productPrefix);
      // standaloneGroups already have isModuleScoped: false from buildEntityGroup default
      groups.push(...standaloneGroups);
    }

    return groups;
  }

  // Fall back to grouping by entity hint (all tools are standalone)
  return groupByEntityHint(classifications, productPrefix);
}

/**
 * Group tools by entity hint. Used for standalone tools (no module param)
 * or as fallback when no module-enum tools exist.
 *
 * Uses extractResourceFamily() to merge singular/plural variants
 * (e.g., "Role" + "Roles" → one group, "Territory" + "Territories" → one group).
 */
function groupByEntityHint(
  classifications: ToolClassification[],
  productPrefix?: string,
): EntityGroup[] {
  // Group by normalized resource family to merge singular/plural variants
  const familyMap = new Map<string, { displayName: string; tools: ToolClassification[] }>();
  for (const c of classifications) {
    const hint = c.entityHint ?? '_unknown';
    const family = hint === '_unknown' ? '_unknown' : extractResourceFamily(hint);
    if (!familyMap.has(family)) {
      // Use the first encountered entityHint as the display name (capitalize)
      familyMap.set(family, { displayName: hint, tools: [] });
    }
    familyMap.get(family)!.tools.push(c);
  }

  const namedGroups = Array.from(familyMap.entries())
    .filter(([key]) => key !== '_unknown');

  // If there are named groups, use them and drop _unknown
  if (namedGroups.length > 0) {
    return namedGroups.map(([, { displayName, tools }]) => {
      const prefix = tools[0]?.prefixGroup ?? '';
      return buildEntityGroup(displayName, prefix, tools);
    });
  }

  // No named groups — promote _unknown to a named group using productPrefix
  const unknownEntry = familyMap.get('_unknown');
  if (unknownEntry && unknownEntry.tools.length > 0) {
    const groupName = productPrefix ? `${productPrefix}_General` : 'General';
    const prefix = unknownEntry.tools[0]?.prefixGroup ?? '';
    return [buildEntityGroup(groupName, prefix, unknownEntry.tools)];
  }

  return [];
}

/**
 * Build an EntityGroup by slotting classified tools into CRUD roles.
 *
 * Tools within each role are sorted by relevance: tools with generic entity
 * hints (like "Records") are preferred over specific ones (like "Tags", "Field").
 * This ensures that `entity.create[0]` is the best tool for creating records.
 */
function buildEntityGroup(
  entityName: string,
  prefix: string,
  tools: ToolClassification[],
): EntityGroup {
  const group: EntityGroup = {
    entityName,
    prefix,
    isModuleScoped: false,
    create: [],
    read: [],
    update: [],
    delete: [],
    search: [],
    other: [],
  };

  for (const tool of tools) {
    switch (tool.operation) {
      case 'create':
        group.create.push(tool.toolName);
        break;
      case 'read':
      case 'list':
        group.read.push(tool.toolName);
        break;
      case 'update':
      case 'upsert':
      case 'assign':
      case 'tag':
      case 'untag':
        group.update.push(tool.toolName);
        break;
      case 'delete':
      case 'remove':
        group.delete.push(tool.toolName);
        break;
      case 'search':
        group.search.push(tool.toolName);
        break;
      default:
        group.other.push(tool.toolName);
        break;
    }
  }

  // Sort each role so generic "Records" tools come first
  const toolMap = new Map(tools.map((t) => [t.toolName, t]));
  const sortByRelevance = (a: string, b: string) => {
    return toolRelevanceScore(toolMap.get(b)!) - toolRelevanceScore(toolMap.get(a)!);
  };
  group.create.sort(sortByRelevance);
  group.read.sort(sortByRelevance);
  group.update.sort(sortByRelevance);
  group.delete.sort(sortByRelevance);
  group.search.sort(sortByRelevance);

  return group;
}

/**
 * Score a tool's relevance for primary CRUD operations.
 * Higher score = more likely the primary tool for that entity group.
 *
 * Prioritizes:
 * 1. Plural "Records" tools (bulk endpoints with ids/data params)
 * 2. Generic entity hints ("Records"/"Record")
 * 3. Tools with path_variables.module (REST-style entity routing)
 * 4. Simpler tool names (fewer segments)
 */
function toolRelevanceScore(tool: ToolClassification): number {
  let score = 0;
  const hint = tool.entityHint?.toLowerCase() ?? '';

  // Strongly prefer plural "Records" tools — these are the bulk/list endpoints
  // that accept ids via query params and data arrays via body.
  // "Records" > "Record" because the plural form uses ids/data patterns
  // that align with how workflows pipe data between steps.
  if (hint === 'records') score += 15;
  else if (hint === 'record') score += 10;

  // Prefer tools with path_variables.module (REST-style entity routing)
  if (tool.moduleParam?.startsWith('path_variables.')) score += 5;

  // Tools with fewer name segments are more generic
  const segments = tool.toolName.split('_').length;
  score -= segments;

  return score;
}

/**
 * Check if a module param path is a "primary" entity-determining path.
 *
 * Primary paths are top-level parameters like `path_variables.module`,
 * `query_params.module`, or `path_variables.module_api_name`.
 *
 * Deeply nested paths like `body.email_notifications[].module` or
 * `body.data[].Parent_Id.module` are internal fields — not the main
 * entity-determining parameter.
 */
function isPrimaryModulePath(paramPath: string): boolean {
  // Primary: path_variables.module, path_variables.module_api_name, query_params.module
  const primaryPrefixes = ['path_variables.', 'query_params.'];
  return primaryPrefixes.some((p) => paramPath.startsWith(p));
}

// === Main Entry Point ===

/**
 * Detect dependencies across all discovered tools.
 * Returns a DependencyGraph with classified tools, edges, and entity groups.
 */
export function detectDependencies(tools: DiscoveredTool[]): DependencyGraph {
  const classifications = classifyTools(tools);
  const edges = buildDependencyEdges(classifications);
  const entityGroups = groupByEntity(classifications);

  return { tools: classifications, edges, entityGroups };
}
