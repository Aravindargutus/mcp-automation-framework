/**
 * Schema-Aware Arg Builder — recursively fills ONLY required fields from JSON Schema.
 *
 * CRITICAL RULE: Never fill optional fields. Zoho APIs change validation
 * behavior when optional params are present vs absent.
 *
 * Context hints allow callers to provide domain-specific values for known
 * field patterns (module, word, criteria, data arrays).
 */

export interface SchemaContext {
  /** Entity/module name (e.g., "Leads") for module-type fields */
  moduleValue?: string;
  /** Search word for word/criteria fields */
  searchWord?: string;
  /** Pre-built body data array (e.g., test data for create/update) */
  bodyData?: Record<string, unknown>[];
  /** Field paths covered by inputMappings (skip these — filled at runtime) */
  runtimeFields?: Set<string>;
  /** Skip ID-like fields in nested objects — they need real IDs from producers, not synthetic values */
  skipIdFields?: boolean;
}

/** Matches ID-like field names that should not be filled with synthetic values */
const ID_LIKE_FIELD = /^(id|ids|cvid)$|[_]id$|Id$|ID$|_ids$/i;

/** Matches response-only audit fields that should not be sent in create/update requests */
const AUDIT_FIELD = /^(created_by|modified_by|created_time|modified_time|Created_By|Modified_By|Created_Time|Modified_Time)$/i;

/**
 * Fill all required fields in a JSON Schema recursively.
 * Returns a value matching the schema with all required fields populated.
 *
 * Only fills fields listed in `required` arrays. Optional fields are never touched.
 */
export function fillRequiredFields(
  schema: Record<string, unknown>,
  context: SchemaContext = {},
  currentPath = '',
): unknown {
  const type = schema.type as string | undefined;

  // Handle oneOf/anyOf — pick first variant and fill it
  if (schema.oneOf || schema.anyOf) {
    const variants = (schema.oneOf ?? schema.anyOf) as Record<string, unknown>[];
    if (variants.length > 0) {
      return fillRequiredFields(variants[0], context, currentPath);
    }
  }

  if (type === 'object' || (!type && schema.properties)) {
    return fillObjectFields(schema, context, currentPath);
  }

  if (type === 'array') {
    return fillArrayField(schema, context, currentPath);
  }

  // Leaf/scalar types
  return generateScalarValue(schema, context, currentPath);
}

/**
 * Fill an object schema — only populates required sub-fields.
 */
function fillObjectFields(
  schema: Record<string, unknown>,
  context: SchemaContext,
  currentPath: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = (schema.required ?? []) as string[];

  for (const key of Object.keys(properties)) {
    const isRequired = required.includes(key);
    if (!isRequired) continue; // NEVER fill optional fields

    const fieldPath = currentPath ? `${currentPath}.${key}` : key;

    // Skip fields covered by runtime inputMappings
    if (context.runtimeFields?.has(fieldPath)) continue;

    // Skip ID-like fields when inside body arrays — these need real IDs from
    // producers/inputMappings, not synthetic values like "MCPProbeTest"
    if (context.skipIdFields && (ID_LIKE_FIELD.test(key) || AUDIT_FIELD.test(key))) continue;

    const propSchema = properties[key];

    // Special handling for known top-level keys
    if (key === 'data' && context.bodyData) {
      result.data = context.bodyData;
      continue;
    }

    result[key] = fillRequiredFields(propSchema, context, fieldPath);
  }

  return result;
}

/**
 * Fill an array field — generates one item from the items schema.
 */
function fillArrayField(
  schema: Record<string, unknown>,
  context: SchemaContext,
  currentPath: string,
): unknown[] {
  const itemsSchema = schema.items as Record<string, unknown> | undefined;
  if (!itemsSchema) return [];

  // For body.data arrays with pre-built data, use the context data
  if (currentPath.endsWith('.data') && context.bodyData) {
    return context.bodyData;
  }

  const item = fillRequiredFields(itemsSchema, context, `${currentPath}[]`);
  return [item];
}

/**
 * Generate a scalar value appropriate for the field type and schema constraints.
 */
function generateScalarValue(
  schema: Record<string, unknown>,
  context: SchemaContext,
  currentPath: string,
): unknown {
  const type = schema.type as string | undefined;
  const fieldName = currentPath.split('.').pop() ?? '';

  // Module-type field detection
  if (isModuleField(fieldName) && context.moduleValue) {
    // If schema has enum, match the entity name within enum values
    if (schema.enum && Array.isArray(schema.enum)) {
      const matched = matchEnumValue(schema.enum as string[], context.moduleValue);
      if (matched) return matched;
      // If no match, use first enum value as fallback
      return (schema.enum as unknown[])[0];
    }
    return context.moduleValue;
  }

  // Search-related fields
  if (fieldName === 'word' && context.searchWord) {
    return context.searchWord;
  }
  if (fieldName === 'criteria' && context.searchWord) {
    // Generic format — let the API interpret the search term
    // CRM-specific format like (Last_Name:equals:X) would break non-CRM APIs
    return context.searchWord;
  }

  switch (type) {
    case 'string':
      return generateStringValue(schema, fieldName);
    case 'number':
    case 'integer':
      return generateNumberValue(schema, type);
    case 'boolean':
      return schema.default ?? true;
    default:
      return 'MCPProbeTest';
  }
}

/**
 * Generate a string value respecting enum, format, and length constraints.
 */
function generateStringValue(schema: Record<string, unknown>, fieldName: string): string {
  // Enum — use first value
  if (schema.enum && Array.isArray(schema.enum)) {
    return String((schema.enum as unknown[])[0]);
  }

  // Default value
  if (schema.default !== undefined) {
    return String(schema.default);
  }

  // Format-specific values
  const format = schema.format as string | undefined;
  if (format === 'date-time') return new Date().toISOString();
  if (format === 'date') return new Date().toISOString().split('T')[0];
  if (format === 'email') return 'test@mcpprobe.dev';
  if (format === 'uri' || format === 'url') return 'https://mcpprobe.dev/test';

  // Field name heuristics
  const lower = fieldName.toLowerCase();
  if (lower.includes('email')) return 'test@mcpprobe.dev';
  if (lower.includes('phone')) return '+1-555-0100';
  if (lower.includes('url') || lower.includes('website')) return 'https://mcpprobe.dev';
  if (lower.includes('name')) return `MCPProbeTest_${Date.now().toString(36).slice(-4)}`;
  if (lower.includes('description')) return 'Created by MCP Probe test';

  // Respect maxLength
  const maxLength = schema.maxLength as number | undefined;
  const value = 'MCPProbeTest';
  if (maxLength && value.length > maxLength) {
    return value.substring(0, maxLength);
  }

  return value;
}

/**
 * Generate a numeric value respecting min/max constraints.
 */
function generateNumberValue(
  schema: Record<string, unknown>,
  type: string,
): number {
  if (schema.default !== undefined) return Number(schema.default);

  const min = (schema.minimum ?? 0) as number;
  const max = (schema.maximum ?? min + 100) as number;
  const mid = (min + max) / 2;
  return type === 'integer' ? Math.floor(mid) : mid;
}

/**
 * Check if a field name matches module/entity patterns.
 */
function isModuleField(fieldName: string): boolean {
  const lower = fieldName.toLowerCase();
  return /^module/.test(lower) ||
    lower === 'module_api_name' ||
    lower === 'entity' ||
    lower === 'object_type' ||
    lower === 'resource_type';
}

/**
 * Match an entity name against enum values (case-insensitive).
 */
function matchEnumValue(enumValues: string[], target: string): string | undefined {
  // Exact match first
  const exact = enumValues.find((v) => v === target);
  if (exact) return exact;

  // Case-insensitive match
  const lower = target.toLowerCase();
  return enumValues.find((v) => v.toLowerCase() === lower);
}
