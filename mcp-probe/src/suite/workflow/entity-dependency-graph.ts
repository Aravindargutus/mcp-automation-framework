/**
 * Entity Dependency Graph — topological sort for entity execution ordering.
 *
 * Instead of the crude "producers first" heuristic, this module builds
 * a directed acyclic graph (DAG) of entity dependencies and uses Kahn's
 * algorithm for topological sorting.
 *
 * For hierarchical REST APIs like Zoho Projects:
 *   Portal (list-only) → Project (CRUD, needs portal_id) → Task (CRUD, needs portal_id + project_id)
 *
 * The topological sort ensures Portals run before Projects, Projects before Tasks, etc.
 * Cycles are detected and broken by removing the lowest-confidence edge.
 */
import type { EntityGroup, ToolClassification } from './types.js';
import type { ToolDependencyProfile } from './schema-dependency-analyzer.js';
import { extractResourceFamily } from './crud-patterns.js';

// === Types ===

export interface EntityNode {
  entityName: string;
  group: EntityGroup;
  /** Entities this one depends on (needs their IDs). */
  dependsOn: Set<string>;
  /** Entities that depend on this one (consume this entity's IDs). */
  dependedBy: Set<string>;
  /** True if this entity only has read/list/get tools — it's a pure producer. */
  isProducer: boolean;
}

export interface EntityDependencyGraphResult {
  /** Entities in topological order (producers first, consumers last). */
  sortedEntities: EntityGroup[];
  /** Detected cycles (if any) — informational, cycles are auto-broken. */
  detectedCycles: string[][];
  /** The full node map for debugging. */
  nodes: Map<string, EntityNode>;
}

// === Main Entry Point ===

/**
 * Build the entity dependency graph and return entities in topological order.
 *
 * @param entityGroups - All entity groups from the dependency detector
 * @param profiles - Tool dependency profiles from the schema analyzer (optional)
 * @param classifications - Tool classifications for fallback dependency detection
 */
export function buildEntityDependencyGraph(
  entityGroups: EntityGroup[],
  profiles?: Map<string, ToolDependencyProfile>,
  classifications?: ToolClassification[],
): EntityDependencyGraphResult {
  // Build nodes
  const nodes = new Map<string, EntityNode>();
  for (const group of entityGroups) {
    nodes.set(group.entityName, {
      entityName: group.entityName,
      group,
      dependsOn: new Set(),
      dependedBy: new Set(),
      isProducer: group.create.length === 0 && group.update.length === 0 && group.delete.length === 0,
    });
  }

  // Build edges using schema-driven profiles (if available) or heuristic fallback
  if (profiles && profiles.size > 0) {
    buildEdgesFromProfiles(nodes, entityGroups, profiles);
  } else if (classifications) {
    buildEdgesFromHeuristic(nodes, entityGroups, classifications);
  }

  // Topological sort with cycle detection/breaking
  const { sorted, cycles } = topologicalSort(nodes);

  // Map back to EntityGroup objects in sorted order
  const sortedEntities = sorted
    .map((name) => nodes.get(name)?.group)
    .filter((g): g is EntityGroup => g !== undefined);

  return { sortedEntities, detectedCycles: cycles, nodes };
}

// === Edge Building: Schema-Driven ===

/**
 * Build dependency edges using schema-driven profiles.
 *
 * For each entity's tools, checks what ID families they require (from profiles).
 * If another entity produces that family, add a dependency edge.
 */
function buildEdgesFromProfiles(
  nodes: Map<string, EntityNode>,
  entityGroups: EntityGroup[],
  profiles: Map<string, ToolDependencyProfile>,
): void {
  // Build map: tool name → entity name
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

  // Build map: family → entity name that produces it
  const familyToProducer = new Map<string, string>();
  for (const profile of profiles.values()) {
    const entityName = toolToEntity.get(profile.toolName);
    if (!entityName) continue;
    for (const shape of profile.producedIdShapes) {
      // First producer for a family wins
      if (!familyToProducer.has(shape.inferredFamily)) {
        familyToProducer.set(shape.inferredFamily, entityName);
      }
    }
  }

  // For each entity's tools, find which families they consume
  for (const group of entityGroups) {
    const consumerNode = nodes.get(group.entityName);
    if (!consumerNode) continue;

    const allTools = [
      ...group.create, ...group.read, ...group.update,
      ...group.delete, ...group.search, ...group.other,
    ];

    for (const toolName of allTools) {
      const profile = profiles.get(toolName);
      if (!profile) continue;

      for (const param of profile.requiredIdParams) {
        // Skip query_params — they're optional filters
        if (param.sourceLocation === 'query_params') continue;

        const producerEntity = familyToProducer.get(param.inferredFamily);
        if (producerEntity && producerEntity !== group.entityName) {
          consumerNode.dependsOn.add(producerEntity);
          const producerNode = nodes.get(producerEntity);
          if (producerNode) {
            producerNode.dependedBy.add(group.entityName);
          }
        }
      }
    }
  }
}

// === Edge Building: Heuristic Fallback ===

/**
 * Build dependency edges using heuristic analysis.
 *
 * Examines each tool's ID param names to infer which entity families
 * it consumes, then matches against entities that produce those families.
 */
function buildEdgesFromHeuristic(
  nodes: Map<string, EntityNode>,
  entityGroups: EntityGroup[],
  classifications: ToolClassification[],
): void {
  // Build map: tool name → entity name
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

  // Build map: family → entity name that could produce it
  // Producer entities are those with read/list tools (they return entity IDs)
  const familyToProducer = new Map<string, string>();
  for (const group of entityGroups) {
    const family = extractResourceFamily(group.entityName);
    if (!familyToProducer.has(family)) {
      familyToProducer.set(family, group.entityName);
    }
  }

  // Build classification lookup
  const classMap = new Map(classifications.map((c) => [c.toolName, c]));

  // For each entity's tools, check if their required ID params reference other entities
  for (const group of entityGroups) {
    const consumerNode = nodes.get(group.entityName);
    if (!consumerNode) continue;

    const allTools = [
      ...group.create, ...group.read, ...group.update,
      ...group.delete, ...group.search, ...group.other,
    ];

    for (const toolName of allTools) {
      const cls = classMap.get(toolName);
      if (!cls) continue;

      // Check required ID param paths for family references
      for (const idPath of cls.requiredIdParamPaths) {
        if (idPath.startsWith('query_params.')) continue;

        // Extract family from param name: "portal_id" → "portal", "project_id" → "project"
        const paramName = idPath.split('.').pop() ?? '';
        const family = extractFamilyFromParamName(paramName);
        if (!family) continue;

        const producerEntity = familyToProducer.get(family);
        if (producerEntity && producerEntity !== group.entityName) {
          consumerNode.dependsOn.add(producerEntity);
          const producerNode = nodes.get(producerEntity);
          if (producerNode) {
            producerNode.dependedBy.add(group.entityName);
          }
        }
      }
    }
  }
}

/**
 * Extract entity family from a parameter name using simple heuristics.
 * "portal_id" → "portal", "project_id" → "project", "id" → null
 */
function extractFamilyFromParamName(paramName: string): string | null {
  const lower = paramName.toLowerCase();

  // Generic ID fields don't indicate a specific family
  if (lower === 'id' || lower === 'ids' || lower === 'record_id') return null;

  // Strip _id/_ids suffix
  const match = lower.match(/^(.+?)_?ids?$/);
  if (match) {
    const family = match[1].replace(/_$/, '');
    if (family.length > 0) return family;
  }

  return null;
}

// === Topological Sort (Kahn's Algorithm) ===

/**
 * Topological sort with cycle detection and breaking.
 *
 * Uses Kahn's algorithm (BFS-based). If cycles are detected, breaks them
 * by removing edges from the cycle, preferring to remove edges TO producer
 * nodes (since producers are less likely to truly depend on consumers).
 */
function topologicalSort(
  nodes: Map<string, EntityNode>,
): { sorted: string[]; cycles: string[][] } {
  const sorted: string[] = [];
  const cycles: string[][] = [];

  // Clone in-degree counts (we'll mutate them)
  const inDegree = new Map<string, number>();
  for (const [name, node] of nodes) {
    inDegree.set(name, node.dependsOn.size);
  }

  // Queue: nodes with zero in-degree
  const queue: string[] = [];
  for (const [name, deg] of inDegree) {
    if (deg === 0) queue.push(name);
  }

  // Sort queue for determinism: producers first, then alphabetical
  queue.sort((a, b) => {
    const aNode = nodes.get(a)!;
    const bNode = nodes.get(b)!;
    if (aNode.isProducer !== bNode.isProducer) {
      return aNode.isProducer ? -1 : 1;
    }
    return a.localeCompare(b);
  });

  // Process queue
  const visited = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    sorted.push(current);

    const node = nodes.get(current)!;
    for (const dependent of node.dependedBy) {
      if (visited.has(dependent)) continue;

      const deg = (inDegree.get(dependent) ?? 1) - 1;
      inDegree.set(dependent, deg);
      if (deg === 0) {
        queue.push(dependent);
        // Keep queue sorted for determinism
        queue.sort((a, b) => {
          const aNode = nodes.get(a)!;
          const bNode = nodes.get(b)!;
          if (aNode.isProducer !== bNode.isProducer) {
            return aNode.isProducer ? -1 : 1;
          }
          return a.localeCompare(b);
        });
      }
    }
  }

  // Check for cycles: any unvisited nodes are part of a cycle
  if (visited.size < nodes.size) {
    const cycleNodes: string[] = [];
    for (const name of nodes.keys()) {
      if (!visited.has(name)) {
        cycleNodes.push(name);
      }
    }

    if (cycleNodes.length > 0) {
      cycles.push(cycleNodes);

      // Break cycles by removing edges and force-adding cycled nodes
      // Sort by: producers first, then fewest dependencies, then alphabetical
      cycleNodes.sort((a, b) => {
        const aNode = nodes.get(a)!;
        const bNode = nodes.get(b)!;
        if (aNode.isProducer !== bNode.isProducer) {
          return aNode.isProducer ? -1 : 1;
        }
        if (aNode.dependsOn.size !== bNode.dependsOn.size) {
          return aNode.dependsOn.size - bNode.dependsOn.size;
        }
        return a.localeCompare(b);
      });

      // Add all cycle nodes in the determined order
      for (const name of cycleNodes) {
        if (!visited.has(name)) {
          visited.add(name);
          sorted.push(name);
        }
      }
    }
  }

  return { sorted, cycles };
}
