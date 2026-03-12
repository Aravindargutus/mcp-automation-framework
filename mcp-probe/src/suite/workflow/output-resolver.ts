/**
 * Output Resolver — utilities for extracting, setting, and resolving
 * values between workflow steps.
 *
 * Enhanced version of the helpers in ai-evaluation/workflow-chaining.ts
 * with support for array indexing (e.g., "data[0].details.id").
 */
import type { InputMapping } from './types.js';

/**
 * Unwrap MCP tool response to extract usable data.
 *
 * MCP tools/call returns `{ content: [{ type: "text", text: "..." }, ...] }`.
 * The text content is often JSON-encoded. This extracts and parses
 * the first text content block.
 */
export function unwrapMCPResponse(response: unknown): unknown {
  if (!response || typeof response !== 'object') return response;

  const resp = response as Record<string, unknown>;
  const content = resp.content;
  if (!Array.isArray(content)) return response;

  // Find first text content block
  const textBlock = content.find(
    (c: unknown) => c && typeof c === 'object' && (c as Record<string, unknown>).type === 'text',
  ) as Record<string, unknown> | undefined;

  if (!textBlock?.text || typeof textBlock.text !== 'string') return response;

  // Try to parse as JSON; fall back to raw string
  try {
    return JSON.parse(textBlock.text as string);
  } catch {
    return textBlock.text;
  }
}

/**
 * Safely traverse a nested object by dot-separated path with array index support.
 *
 * Supports paths like:
 *   "data[0].details.id"
 *   "results[0].id"
 *   "simple.nested.path"
 */
export function getNestedField(obj: unknown, path: string): unknown {
  const parts = parsePath(path);
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;

    if (part.type === 'key') {
      if (typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[part.value];
    } else {
      // Array index
      if (!Array.isArray(current)) return undefined;
      current = current[part.index];
    }
  }

  return current;
}

/**
 * Set a value at a nested path, creating intermediate objects/arrays as needed.
 *
 * Supports paths like:
 *   "body.data[0].id"
 *   "path_variables.module"
 *   "query_params.ids"
 */
export function setNestedField(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = parsePath(path);
  let current: unknown = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    const nextPart = parts[i + 1];

    if (part.type === 'key') {
      if (current === null || current === undefined || typeof current !== 'object' || Array.isArray(current)) {
        return; // Cannot traverse into a non-object — bail out safely
      }
      const container = current as Record<string, unknown>;
      if (container[part.value] === undefined || container[part.value] === null) {
        // Create the right container type based on what comes next
        container[part.value] = nextPart.type === 'index' ? [] : {};
      }
      current = container[part.value];
    } else {
      // Array index
      if (!Array.isArray(current)) {
        return; // Cannot index into a non-array — bail out safely
      }
      const arr = current as unknown[];
      while (arr.length <= part.index) {
        arr.push(nextPart.type === 'index' ? [] : {});
      }
      current = arr[part.index];
    }
  }

  // Set the final value
  // When the existing value is an array but the new value is a scalar, wrap it.
  // This handles cases like body.ids (an array of record IDs) receiving a single
  // createdRecordId string — the API expects ["id"] not "id".
  const lastPart = parts[parts.length - 1];
  if (lastPart.type === 'key') {
    const container = current as Record<string, unknown>;
    const existing = container[lastPart.value];
    if (Array.isArray(existing) && !Array.isArray(value)) {
      container[lastPart.value] = [value];
    } else {
      container[lastPart.value] = value;
    }
  } else {
    const arr = current as unknown[];
    while (arr.length <= lastPart.index) {
      arr.push(undefined);
    }
    arr[lastPart.index] = value;
  }
}

/**
 * Deep clone a value (JSON-safe).
 */
export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Resolve workflow step args by injecting values from the output store.
 *
 * Returns the resolved args and any unresolved mappings.
 */
export function resolveStepArgs(
  argsTemplate: Record<string, unknown>,
  inputMappings: InputMapping[],
  outputStore: Map<string, unknown>,
): { resolved: Record<string, unknown>; unresolved: string[] } {
  const resolved = deepClone(argsTemplate);
  const unresolved: string[] = [];

  for (const mapping of inputMappings) {
    // Try primary key first
    if (outputStore.has(mapping.fromOutput)) {
      const value = outputStore.get(mapping.fromOutput);
      if (value !== undefined && value !== null) {
        setNestedField(resolved, mapping.paramPath, value);
        continue;
      }
    }

    // Try fallback keys in order (cross-entity IDs, alternative names)
    let resolvedFromFallback = false;
    if (mapping.fallbackKeys) {
      for (const fallbackKey of mapping.fallbackKeys) {
        if (outputStore.has(fallbackKey)) {
          const value = outputStore.get(fallbackKey);
          if (value !== undefined && value !== null) {
            setNestedField(resolved, mapping.paramPath, value);
            resolvedFromFallback = true;
            break;
          }
        }
      }
    }

    if (!resolvedFromFallback) {
      // Genuinely unresolved — previous step didn't produce it
      unresolved.push(`${mapping.paramPath} ← ${mapping.fromOutput}`);
    }
  }

  return { resolved, unresolved };
}

/**
 * Try multiple paths to extract a value from a response.
 * Returns the first non-undefined match.
 */
export function tryExtractField(obj: unknown, paths: string[]): { value: unknown; path: string } | null {
  for (const path of paths) {
    const value = getNestedField(obj, path);
    if (value !== undefined && value !== null) {
      return { value, path };
    }
  }
  return null;
}

// === Path Parsing ===

type PathPart = { type: 'key'; value: string } | { type: 'index'; index: number };

/**
 * Parse a dot-separated path with optional array indices.
 * "data[0].details.id" → [key("data"), index(0), key("details"), key("id")]
 */
function parsePath(path: string): PathPart[] {
  const parts: PathPart[] = [];
  // Split by dots, but handle array indices within segments
  const segments = path.split('.');

  for (const segment of segments) {
    // Check for array index: "data[0]", "results[2]"
    const arrayMatch = segment.match(/^([^[]*)\[(\d+)\]$/);
    if (arrayMatch) {
      const key = arrayMatch[1];
      const index = parseInt(arrayMatch[2], 10);
      if (key.length > 0) {
        parts.push({ type: 'key', value: key });
      }
      parts.push({ type: 'index', index });
    } else {
      parts.push({ type: 'key', value: segment });
    }
  }

  return parts;
}

/**
 * Truncate a response for display purposes.
 */
export function truncateResponse(response: unknown, maxLength: number): unknown {
  const str = JSON.stringify(response);
  if (!str || str.length <= maxLength) return response;
  try {
    return JSON.parse(str.substring(0, maxLength) + '..."');
  } catch {
    return str.substring(0, maxLength) + '...';
  }
}
