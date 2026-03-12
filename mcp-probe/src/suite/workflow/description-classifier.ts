/**
 * Description Classifier — extracts entity and operation hints from tool descriptions.
 *
 * Tool descriptions often contain valuable context that tool names miss:
 *   - "Create a Record in a specific module" → entity: "Record", operation: "create"
 *   - "Get the list of available records" → entity: "Record", operation: "list"
 *   - "Permanently deletes one or more records" → entity: "Record", operation: "delete"
 *   - "Search records matching criteria" → entity: "Record", operation: "search"
 *
 * This classifier is purely deterministic (regex-based, no LLM required).
 * It supplements the tool-name-based classification with description-based hints.
 */
import type { CRUDOperation } from './types.js';
import { singularize } from './crud-patterns.js';

// === Types ===

export interface DescriptionClassification {
  /** The tool name that was classified. */
  toolName: string;
  /** Entity hint extracted from the description (e.g., "record", "contact"). */
  entityHint: string | null;
  /** Operation hint from the description. */
  operationHint: CRUDOperation | null;
  /** What entity families does this tool consume (need as input)? */
  consumedFamilies: string[];
  /** What entity family does this tool produce (return as output)? */
  producedFamily: string | null;
  /** Confidence in the classification (0-1). */
  confidence: number;
  /** The raw description that was analyzed. */
  rawDescription: string;
}

// === Operation Patterns for Descriptions ===

interface DescriptionOperationPattern {
  pattern: RegExp;
  operation: CRUDOperation;
  producesOutput: boolean;
}

const DESCRIPTION_OPERATION_PATTERNS: DescriptionOperationPattern[] = [
  // Create/Insert patterns
  { pattern: /\bcreate\s+(?:a\s+)?(?:new\s+)?(\w+)/i, operation: 'create', producesOutput: true },
  { pattern: /\binsert\s+(?:a\s+)?(?:new\s+)?(\w+)/i, operation: 'create', producesOutput: true },
  { pattern: /\badd\s+(?:a\s+)?(?:new\s+)?(\w+)/i, operation: 'create', producesOutput: true },
  // Update patterns
  { pattern: /\bupdate\s+(?:an?\s+)?(?:existing\s+)?(\w+)/i, operation: 'update', producesOutput: false },
  { pattern: /\bmodif(?:y|ies)\s+(?:an?\s+)?(\w+)/i, operation: 'update', producesOutput: false },
  { pattern: /\bedit\s+(?:an?\s+)?(\w+)/i, operation: 'update', producesOutput: false },
  // Delete patterns
  { pattern: /\bdelete[sd]?\s+(?:one\s+or\s+more\s+)?(\w+)/i, operation: 'delete', producesOutput: false },
  { pattern: /\bremove[sd]?\s+(?:one\s+or\s+more\s+)?(\w+)/i, operation: 'remove', producesOutput: false },
  { pattern: /\bpermanently\s+delete[sd]?\s+/i, operation: 'delete', producesOutput: false },
  // Read/Get patterns
  { pattern: /\bget\s+(?:the\s+)?(?:list\s+of\s+)?(?:available\s+)?(\w+)/i, operation: 'read', producesOutput: false },
  { pattern: /\bfetch(?:es)?\s+(?:the\s+)?(\w+)/i, operation: 'read', producesOutput: false },
  { pattern: /\bretrieves?\s+(?:the\s+)?(\w+)/i, operation: 'read', producesOutput: false },
  { pattern: /\blist\s+(?:all\s+)?(?:available\s+)?(\w+)/i, operation: 'list', producesOutput: false },
  // Search patterns
  { pattern: /\bsearch(?:es)?\s+(?:for\s+)?(\w+)/i, operation: 'search', producesOutput: false },
  { pattern: /\bfind[sd]?\s+(\w+)/i, operation: 'search', producesOutput: false },
  { pattern: /\bquery\s+(\w+)/i, operation: 'search', producesOutput: false },
  // Upsert patterns
  { pattern: /\bupsert\s+(\w+)/i, operation: 'upsert', producesOutput: true },
  { pattern: /\binsert.*or\s+update/i, operation: 'upsert', producesOutput: true },
  // Tag patterns
  { pattern: /\badd\s+tags?\s+to/i, operation: 'tag', producesOutput: false },
  { pattern: /\bremove\s+tags?\s+from/i, operation: 'untag', producesOutput: false },
  // Assign patterns
  { pattern: /\bassign\s+(\w+)/i, operation: 'assign', producesOutput: false },
];

// === Entity Extraction Patterns ===

/**
 * Patterns to extract entity nouns from descriptions.
 * These capture the primary noun that the tool operates on.
 */
const ENTITY_EXTRACTION_PATTERNS: RegExp[] = [
  // "Create a Record in a specific module"
  /\b(?:create|insert|add|update|modify|edit|delete|remove|get|fetch|retrieve|list|search|find|query|upsert)\s+(?:a\s+)?(?:new\s+)?(?:existing\s+)?(?:the\s+)?(?:list\s+of\s+)?(?:available\s+)?(?:one\s+or\s+more\s+)?(\w+)/i,
  // "To get the list of available records"
  /\blist\s+of\s+(?:available\s+)?(\w+)/i,
  // "...from a module" / "...in a module" / "...within a module"
  /\bfrom\s+(?:a\s+|the\s+)?(\w+)\s+(?:module|entity|table)/i,
  /\bin\s+(?:a\s+|the\s+)?(\w+)\s+(?:module|entity|table)/i,
  /\bwithin\s+(?:a\s+|the\s+)?(\w+)\s+(?:module|entity|table)/i,
];

// Words that are too generic to be entity hints
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'this', 'that', 'it', 'its', 'one', 'all', 'any',
  'new', 'existing', 'specific', 'particular', 'given', 'certain',
  'based', 'using', 'matching', 'specified', 'provided', 'respective',
  'multiple', 'bulk', 'batch', 'single', 'individual',
  'api', 'data', 'information', 'details', 'content', 'value', 'values',
  'request', 'response', 'result', 'results', 'output', 'input',
  'operation', 'action', 'criteria',
]);

// === Consumed Family Detection ===

/**
 * Patterns to detect which entity families a tool consumes (needs as input).
 * Extracts from phrases like "based on their unique ID", "the portal ID", etc.
 */
const CONSUMED_FAMILY_PATTERNS: RegExp[] = [
  // "using comma-separated record IDs"
  /(?:using|with|by)\s+(?:comma-separated\s+)?(\w+)\s+IDs?/i,
  // "based on their unique ID"
  /\bbased\s+on\s+(?:their\s+)?(?:unique\s+)?(\w+)\s+ID/i,
  // "the ID of the portal"
  /\bID\s+of\s+(?:the\s+)?(\w+)/i,
  // "the portal ID"
  /\bthe\s+(\w+)\s+ID\b/i,
  // "for a specific module" (module as entity selector)
  /\bfor\s+(?:a\s+)?(?:specific\s+)?(\w+)\s+(?:module|entity)/i,
];

// === Main Classifier ===

/**
 * Classify a tool based on its description.
 * Returns entity and operation hints extracted from the description text.
 */
export function classifyFromDescription(
  toolName: string,
  description: string | undefined | null,
): DescriptionClassification {
  if (!description || description.trim().length === 0) {
    return {
      toolName,
      entityHint: null,
      operationHint: null,
      consumedFamilies: [],
      producedFamily: null,
      confidence: 0,
      rawDescription: '',
    };
  }

  const desc = description.trim();

  // Extract operation hint
  let operationHint: CRUDOperation | null = null;
  let producesOutput = false;
  for (const { pattern, operation, producesOutput: produces } of DESCRIPTION_OPERATION_PATTERNS) {
    if (pattern.test(desc)) {
      operationHint = operation;
      producesOutput = produces;
      break;
    }
  }

  // Extract entity hint
  const entityHint = extractEntityFromDescription(desc);

  // Extract consumed families
  const consumedFamilies = extractConsumedFamilies(desc);

  // Determine produced family
  const producedFamily = producesOutput && entityHint
    ? singularize(entityHint.toLowerCase())
    : null;

  // Compute confidence
  let confidence = 0;
  if (operationHint) confidence += 0.4;
  if (entityHint) confidence += 0.4;
  if (consumedFamilies.length > 0) confidence += 0.2;

  return {
    toolName,
    entityHint,
    operationHint,
    consumedFamilies,
    producedFamily,
    confidence,
    rawDescription: desc,
  };
}

/**
 * Classify all tools from their descriptions.
 * Returns a map from tool name to classification.
 */
export function classifyAllFromDescriptions(
  tools: Array<{ name: string; description?: string }>,
): Map<string, DescriptionClassification> {
  const results = new Map<string, DescriptionClassification>();
  for (const tool of tools) {
    results.set(tool.name, classifyFromDescription(tool.name, tool.description));
  }
  return results;
}

// === Helpers ===

/**
 * Extract the primary entity noun from a description.
 */
function extractEntityFromDescription(description: string): string | null {
  for (const pattern of ENTITY_EXTRACTION_PATTERNS) {
    const match = description.match(pattern);
    if (match && match[1]) {
      const candidate = match[1].toLowerCase();
      if (!STOP_WORDS.has(candidate)) {
        return singularize(candidate);
      }
    }
  }
  return null;
}

/**
 * Extract entity families that the tool consumes (needs as input).
 */
function extractConsumedFamilies(description: string): string[] {
  const families: string[] = [];
  const seen = new Set<string>();

  for (const pattern of CONSUMED_FAMILY_PATTERNS) {
    const match = description.match(pattern);
    if (match && match[1]) {
      const family = singularize(match[1].toLowerCase());
      if (!STOP_WORDS.has(family) && !seen.has(family)) {
        seen.add(family);
        families.push(family);
      }
    }
  }

  return families;
}
