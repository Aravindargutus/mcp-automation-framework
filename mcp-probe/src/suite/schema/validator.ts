/**
 * Schema Validator — AJV-based JSON Schema validation.
 *
 * Uses AJV (not Zod) because:
 * - Zod cannot consume arbitrary JSON Schema at runtime
 * - MCP inputSchema/outputSchema are JSON Schema 2020-12 (or draft-07)
 * - AJV supports both dialects
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

export interface ValidationResult {
  valid: boolean;
  errors: SchemaError[];
}

export interface SchemaError {
  path: string;
  message: string;
  keyword: string;
  params: Record<string, unknown>;
}

// Create a singleton AJV instance
let ajvInstance: any = null;

function getAjv(): any {
  if (!ajvInstance) {
    // Handle CJS/ESM interop
    const AjvCtor = (Ajv as any).default ?? Ajv;
    ajvInstance = new AjvCtor({
      allErrors: true,
      strict: false,
      validateFormats: true,
    });
    const addFmts = (addFormats as any).default ?? addFormats;
    addFmts(ajvInstance);
  }
  return ajvInstance;
}

/**
 * Validate data against a JSON Schema.
 */
export function validateAgainstSchema(
  data: unknown,
  schema: Record<string, unknown>,
): ValidationResult {
  const ajv = getAjv();

  try {
    const validate = ajv.compile(schema);
    const valid = validate(data);

    if (valid) {
      return { valid: true, errors: [] };
    }

    const errors: SchemaError[] = (validate.errors ?? []).map((err: { instancePath: string; message?: string; keyword: string; params: unknown }) => ({
      path: err.instancePath || '/',
      message: err.message ?? 'Validation failed',
      keyword: err.keyword,
      params: err.params as Record<string, unknown>,
    }));

    return { valid: false, errors };
  } catch (err) {
    return {
      valid: false,
      errors: [
        {
          path: '/',
          message: `Schema compilation error: ${(err as Error).message}`,
          keyword: 'schema_error',
          params: {},
        },
      ],
    };
  }
}

/**
 * Check if a schema itself is valid JSON Schema.
 */
export function isValidJsonSchema(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object') return false;
  const ajv = getAjv();
  try {
    ajv.compile(schema as Record<string, unknown>);
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract required and optional properties from a JSON Schema.
 */
export function extractSchemaProperties(schema: Record<string, unknown>): {
  required: string[];
  optional: string[];
  allProperties: Record<string, Record<string, unknown>>;
} {
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = (schema.required ?? []) as string[];
  const allKeys = Object.keys(properties);
  const optional = allKeys.filter((k) => !required.includes(k));

  return {
    required,
    optional,
    allProperties: properties,
  };
}
