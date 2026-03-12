/**
 * CRUD Pattern Knowledge Base — static patterns used by the dependency detector
 * to classify tools by operation type and entity.
 */
import type { CRUDOperation } from './types.js';
import { fillRequiredFields } from '../../agentic/schema-aware-builder.js';

// === Operation Patterns (ordered by specificity) ===

export interface OperationPattern {
  pattern: RegExp;
  operation: CRUDOperation;
  producesId: boolean;
}

export const OPERATION_PATTERNS: OperationPattern[] = [
  // Most specific first
  { pattern: /\bcreate\b/i, operation: 'create', producesId: true },
  { pattern: /\binsert\b/i, operation: 'create', producesId: true },
  { pattern: /\badd_new\b/i, operation: 'create', producesId: true },
  { pattern: /\bupsert\b/i, operation: 'upsert', producesId: true },
  { pattern: /\bupdate\b/i, operation: 'update', producesId: false },
  { pattern: /\bmodify\b/i, operation: 'update', producesId: false },
  { pattern: /\bedit\b/i, operation: 'update', producesId: false },
  { pattern: /\bpatch\b/i, operation: 'update', producesId: false },
  { pattern: /\bmass_update\b/i, operation: 'update', producesId: false },
  { pattern: /\bdelete\b/i, operation: 'delete', producesId: false },
  { pattern: /\bremove\b/i, operation: 'remove', producesId: false },
  { pattern: /\bdestroy\b/i, operation: 'delete', producesId: false },
  { pattern: /\bpurge\b/i, operation: 'delete', producesId: false },
  { pattern: /\bsearch\b/i, operation: 'search', producesId: false },
  { pattern: /\bfind\b/i, operation: 'search', producesId: false },
  { pattern: /\bquery\b/i, operation: 'search', producesId: false },
  { pattern: /\bget\b/i, operation: 'read', producesId: false },
  { pattern: /\bread\b/i, operation: 'read', producesId: false },
  { pattern: /\bfetch\b/i, operation: 'read', producesId: false },
  { pattern: /\blist\b/i, operation: 'list', producesId: false },
  { pattern: /\btags?\b/i, operation: 'tag', producesId: false },
  { pattern: /\buntags?\b/i, operation: 'untag', producesId: false },
  { pattern: /\bassign\b/i, operation: 'assign', producesId: false },
  { pattern: /\bactivate\b/i, operation: 'update', producesId: false },
  { pattern: /\bdeactivate\b/i, operation: 'update', producesId: false },
];

// === ID Field Name Patterns ===

export const ID_FIELD_PATTERNS: RegExp[] = [
  /^id$/i,
  /^record_id$/i,
  /^ids$/i,
  /[_.]id$/i,
  /Id$/,
];

// === Module/Entity Field Patterns ===

export const MODULE_FIELD_PATTERNS: RegExp[] = [
  /^module$/i,
  /^module_api_name$/i,
  /^entity$/i,
  /^object_type$/i,
  /^resource_type$/i,
];

// === Response ID Paths (tried in order for extracting created record IDs) ===

export const RESPONSE_ID_PATHS: string[] = [
  // Zoho CRM patterns
  'data[0].details.id',
  'data[0].id',
  // Generic patterns
  'id',
  'id_string',
  'data.id',
  'data.id_string',
  'result.id',
  'result[0].id',
  'record.id',
  'results[0].id',
  // Zoho Projects patterns (id_string is the string variant of numeric id)
  'data[0].id_string',
  '[0].id_string',
];

// === Default Test Data per Module ===

export const ENTITY_TEST_DATA: Record<string, Record<string, unknown>> = {
  Leads: {
    Last_Name: 'MCPProbeTest',
    Company: 'MCP Probe Testing',
    Email: 'lead-test@mcpprobe.dev',
  },
  Contacts: {
    Last_Name: 'MCPProbeTest',
    Email: 'contact-test@mcpprobe.dev',
  },
  Deals: {
    Deal_Name: 'MCP Probe Test Deal',
    Stage: 'Qualification',
  },
  Accounts: {
    Account_Name: 'MCP Probe Test Account',
  },
  Tasks: {
    Subject: 'MCP Probe Test Task',
  },
  Cases: {
    Subject: 'MCP Probe Test Case',
  },
  // Generic fallback for unknown entities
  _default: {
    name: 'MCP Probe Test',
  },
};

/**
 * Get test data for a given module/entity, with optional user overrides.
 */
export function getTestData(
  entity: string,
  overrides?: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  const base = ENTITY_TEST_DATA[entity] ?? ENTITY_TEST_DATA._default;
  const userOverride = overrides?.[entity];
  return { ...base, ...userOverride };
}

/**
 * Get test data using a priority chain:
 *   1. User-provided overrides (testDataOverrides in config)
 *   2. Built-in ENTITY_TEST_DATA for known entities (backward compat)
 *   3. Schema-aware generation from the create tool's body.data items schema (universal)
 *
 * This makes the framework generic — known CRM entities get optimized data,
 * unknown entities get schema-derived data that works for any MCP server.
 */
export function getTestDataFromSchema(
  entity: string,
  createToolSchema: Record<string, unknown> | undefined,
  overrides?: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  // Priority 1: User overrides
  if (overrides?.[entity]) {
    const base = ENTITY_TEST_DATA[entity] ?? ENTITY_TEST_DATA._default;
    return { ...base, ...overrides[entity] };
  }

  // Priority 2: Built-in test data for known entities
  if (ENTITY_TEST_DATA[entity]) {
    return { ...ENTITY_TEST_DATA[entity] };
  }

  // Priority 3: Schema-aware generation
  if (createToolSchema) {
    const schemaData = generateTestDataFromBodySchema(createToolSchema);
    if (Object.keys(schemaData).length > 0) {
      return schemaData;
    }
  }

  // Final fallback
  return { ...ENTITY_TEST_DATA._default };
}

/**
 * Extract required fields from the body.data items schema and generate test values.
 * Walks: schema → properties.body → properties.data → items → properties → required fields
 */
function generateTestDataFromBodySchema(toolSchema: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  // Navigate to body schema
  const topProps = (toolSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const bodySchema = topProps.body;
  if (!bodySchema) return result;

  const bodyProps = (bodySchema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const bodyRequired = (bodySchema.required ?? []) as string[];

  // Find the primary data array — may be 'data', 'users', 'territories', 'modules', etc.
  // Use the first required array property in the body schema.
  let arraySchema: Record<string, unknown> | undefined;
  for (const key of bodyRequired) {
    const prop = bodyProps[key];
    if (prop && prop.type === 'array') {
      arraySchema = prop;
      break;
    }
  }
  // Fallback: check body.data even if not required
  if (!arraySchema) {
    arraySchema = bodyProps.data;
  }
  if (!arraySchema || arraySchema.type !== 'array') return result;

  const itemsSchema = arraySchema.items as Record<string, unknown> | undefined;
  if (!itemsSchema) return result;

  const itemProps = (itemsSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const itemRequired = (itemsSchema.required ?? []) as string[];

  // Only fill required fields from the data item schema
  for (const key of itemRequired) {
    if (key === 'id') continue; // ID is set by inputMappings
    const propSchema = itemProps[key];
    if (!propSchema) continue;
    result[key] = fillRequiredFields(propSchema, { skipIdFields: true }, key);
  }

  return result;
}

// generateTestFieldValue() removed — replaced by fillRequiredFields() from schema-aware-builder
// which recursively fills nested objects and arrays instead of returning empty {} / []

/**
 * Get modified test data for update operations.
 * Appends "_Updated" to string values to verify the update took effect.
 */
export function getUpdateTestData(
  entity: string,
  overrides?: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  const data = getTestData(entity, overrides);
  const modified: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string' && !key.toLowerCase().includes('email')) {
      modified[key] = `${value}_Updated`;
    }
  }

  // Return at least one modified field; if empty, add a generic one
  if (Object.keys(modified).length === 0) {
    modified.Description = 'Updated by MCP Probe workflow test';
  }

  return modified;
}

/**
 * Detect the dominant prefix shared across tool names.
 *
 * Handles mixed-prefix tool sets (e.g., ZohoCRM_* + ZohoWorkdrive_*) by
 * finding the most common first segment rather than requiring universal agreement.
 *
 * e.g., 150× "ZohoCRM_*" + 40× "ZohoWorkdrive_*" → "ZohoCRM"
 */
export function detectCommonPrefix(toolNames: string[]): string | null {
  if (toolNames.length === 0) return null;
  if (toolNames.length === 1) {
    const parts = toolNames[0].split('_');
    return parts.length > 1 ? parts[0] : null;
  }

  // First, try the exact common prefix across ALL names (works for single-source servers)
  const segmented = toolNames.map((n) => n.split('_'));
  const minLength = Math.min(...segmented.map((s) => s.length));

  const commonSegments: string[] = [];
  for (let i = 0; i < minLength; i++) {
    const seg = segmented[0][i];
    if (segmented.every((s) => s[i] === seg)) {
      commonSegments.push(seg);
    } else {
      break;
    }
  }

  if (commonSegments.length > 0) {
    return commonSegments.join('_');
  }

  // Fallback: find the majority first segment (handles mixed tool sets)
  const prefixCounts = new Map<string, number>();
  for (const name of toolNames) {
    const parts = name.split('_');
    if (parts.length > 1) {
      const prefix = parts[0];
      prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
    }
  }

  if (prefixCounts.size === 0) return null;

  // Return the most common prefix (must cover >30% of tools to be meaningful)
  let bestPrefix = '';
  let bestCount = 0;
  for (const [prefix, count] of prefixCounts) {
    if (count > bestCount) {
      bestPrefix = prefix;
      bestCount = count;
    }
  }

  return bestCount > toolNames.length * 0.3 ? bestPrefix : null;
}

/**
 * Normalize a tool name for pattern matching.
 *
 * Handles both snake_case and camelCase/PascalCase:
 *   "ZohoCRM_Create_Records"          → "ZohoCRM Create Records"
 *   "ZohoWorkdrive_createTeamFolder"  → "Zoho Workdrive create Team Folder"
 *   "github_create_issue"             → "github create issue"
 *   "listRepositories"                → "list Repositories"
 */
function normalizeName(name: string): string {
  return name
    // Split camelCase/PascalCase: "createTeamFolder" → "create_Team_Folder"
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    // Split consecutive uppercase followed by lowercase: "CRMCreate" → "CRM_Create"
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    // Replace underscores and hyphens with spaces for word boundary matching
    .replace(/[_-]/g, ' ');
}

/**
 * Match a tool name against CRUD operation patterns.
 * Returns the first match, or 'other' if none found.
 *
 * Normalizes both snake_case and camelCase names so \b word boundaries work.
 * e.g., "ZohoCRM_Create_Records" → "ZohoCRM Create Records" → matches \bcreate\b
 *       "createTeamFolder"        → "create Team Folder"     → matches \bcreate\b
 */
export function matchOperation(toolName: string): { operation: CRUDOperation; producesId: boolean } {
  const normalized = normalizeName(toolName);

  for (const { pattern, operation, producesId } of OPERATION_PATTERNS) {
    if (pattern.test(normalized)) {
      return { operation, producesId };
    }
  }
  return { operation: 'other', producesId: false };
}

/**
 * Extract entity hint from a tool name by removing the prefix and operation verb.
 *
 * Handles both snake_case and camelCase names:
 *   "ZohoCRM_Create_Records" with prefix "ZohoCRM" → "Records"
 *   "ZohoWorkdrive_createTeamFolder" with prefix "ZohoWorkdrive" → "Team_Folder"
 *   "github_list_issues" with prefix "github" → "issues"
 */
export function extractEntityHint(toolName: string, prefix: string | null): string | null {
  let remaining = toolName;

  // Remove prefix — if the global prefix doesn't match this tool,
  // extract the tool's own prefix (handles multi-product servers)
  if (prefix && remaining.startsWith(prefix + '_')) {
    remaining = remaining.slice(prefix.length + 1);
  } else if (prefix) {
    // Global prefix doesn't match — strip this tool's own first segment as prefix
    const parts = remaining.split('_');
    if (parts.length > 1) {
      remaining = parts.slice(1).join('_');
    }
  }

  // Normalize camelCase to snake_case before splitting
  // "createTeamFolder" → "create_Team_Folder"
  remaining = remaining
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2');

  // Split into segments and filter out operation words
  // Words that describe the OPERATION (verb), not the ENTITY (noun).
  // "tag"/"untag" are intentionally excluded — they are both verbs AND nouns.
  // In "Update_Tag", "Tag" is the entity; in "Add_Tags", "Tags" is the entity.
  // Operation classification comes from matchOperation() patterns, not this list.
  const operationWords = new Set([
    'create', 'get', 'update', 'delete', 'search', 'find', 'list', 'fetch',
    'read', 'upsert', 'insert', 'remove', 'destroy', 'add', 'assign', 'mass',
    'activate', 'custom', 'rich', 'text', 'deleted', 'deactivate', 'modify',
    'edit', 'patch', 'purge', 'query',
  ]);

  const segments = remaining.split('_').filter((seg) => {
    return seg.length > 0 && !operationWords.has(seg.toLowerCase());
  });

  const entity = segments.join('_');
  return entity.length > 0 ? entity : null;
}

/**
 * Extract the product prefix from a tool name.
 * e.g., "ZohoCRM_Create_Records" → "ZohoCRM"
 *       "ZohoWorkdrive_Get_Files" → "ZohoWorkdrive"
 */
export function extractToolPrefix(toolName: string): string | null {
  const parts = toolName.split('_');
  return parts.length > 1 ? parts[0] : null;
}

// === Resource Family Detection (Generic ID Routing) ===

/**
 * Extract the core noun from an entityHint for resource family grouping.
 * Strips leading verbs missed by extractEntityHint, splits on underscore,
 * takes noun segments (before relational words), and singularizes.
 *
 * Generic — works for any MCP product, not CRM-specific.
 *
 * Examples:
 *   "Fields_With_ID" → "field"
 *   "put_Fields_With_ID" → "field"
 *   "Layouts" → "layout"
 *   "Layout_By_Id" → "layout"
 *   "Team_Folders" → "team_folder"
 *   "Records" → "record"
 */
export function extractResourceFamily(entityHint: string): string {
  // Strip operation-like prefixes that extractEntityHint might have missed
  const cleaned = entityHint.replace(/^(put|post|get|list|set|all|my|new)_/i, '');
  // Split by underscore, collect noun segments (stop before relational words)
  const relational = /^(with|by|using|for|of|from|to|in|ofa|and|or|on|at)$/i;
  const parts = cleaned.split('_');
  const nounParts: string[] = [];
  for (const p of parts) {
    if (relational.test(p)) break;
    nounParts.push(p);
  }
  const raw = (nounParts.length > 0 ? nounParts : [parts[0]]).join('_').toLowerCase();
  return singularize(raw);
}

/** Naive singularization — enough for consistent grouping across tool names. */
export function singularize(word: string): string {
  if (word.endsWith('ies') && word.length > 3) return word.slice(0, -3) + 'y';
  // "statuses" → "status", "classes" → "class", "addresses" → "address"
  if (word.endsWith('sses') || word.endsWith('shes') || word.endsWith('ches') || word.endsWith('tches'))
    return word.slice(0, -2);
  if (word.endsWith('uses') || word.endsWith('ases') || word.endsWith('ises') || word.endsWith('oses'))
    return word.slice(0, -1);
  // "boxes" → "box", "indexes" → "index", "buzzes" → "buzz"
  if (word.endsWith('xes') || word.endsWith('zes'))
    return word.slice(0, -2);
  // "ses" at the end after exhausting the above patterns (e.g., "responses" → "response")
  if (word.endsWith('ses') && word.length > 3)
    return word.slice(0, -1);
  if (word.endsWith('s') && !word.endsWith('ss') && word.length > 2)
    return word.slice(0, -1);
  return word;
}

/**
 * Check if a tool's entityHint belongs to the same resource family as the
 * primary entity (established by the CREATE step).
 *
 * Uses a "contains" check so that compound names like "Rich_Text_Records"
 * still match the primary "Records" family.
 *
 * Generic — works for any entity naming pattern.
 */
export function isPrimaryEntity(
  entityHint: string | null,
  primaryEntityHint: string | null,
): boolean {
  if (!entityHint) return true; // No hint — can't distinguish, default to primary
  if (!primaryEntityHint) return false; // No create tool → nothing is primary, treat all as secondary
  const primaryCore = primaryEntityHint.toLowerCase().replace(/s$/, '');
  return entityHint.toLowerCase().includes(primaryCore);
}

