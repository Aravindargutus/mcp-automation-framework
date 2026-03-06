/**
 * Schema Fuzzer — generates valid and invalid inputs from JSON Schema.
 *
 * Valid inputs: coverage-driven (required only, all fields, boundary values)
 * Invalid inputs: missing required, wrong types, out-of-range, injection strings
 */

export interface FuzzedInput {
  label: string;
  data: unknown;
  expectValid: boolean;
  category: 'valid' | 'missing_required' | 'wrong_type' | 'boundary' | 'injection';
}

/**
 * Generate a set of fuzzed inputs from a JSON Schema inputSchema.
 */
export function generateFuzzedInputs(schema: Record<string, unknown>): FuzzedInput[] {
  const inputs: FuzzedInput[] = [];
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = (schema.required ?? []) as string[];

  // --- Valid inputs ---

  // 1. Minimal valid: only required fields
  if (required.length > 0) {
    const minimalValid: Record<string, unknown> = {};
    for (const key of required) {
      minimalValid[key] = generateValidValue(properties[key] ?? { type: 'string' });
    }
    inputs.push({
      label: 'Minimal valid input (required fields only)',
      data: minimalValid,
      expectValid: true,
      category: 'valid',
    });
  }

  // 2. Full valid: all fields
  const allKeys = Object.keys(properties);
  if (allKeys.length > 0) {
    const fullValid: Record<string, unknown> = {};
    for (const key of allKeys) {
      fullValid[key] = generateValidValue(properties[key]);
    }
    inputs.push({
      label: 'Full valid input (all fields)',
      data: fullValid,
      expectValid: true,
      category: 'valid',
    });
  }

  // 3. Empty object (valid only if no required fields)
  inputs.push({
    label: 'Empty object',
    data: {},
    expectValid: required.length === 0,
    category: required.length === 0 ? 'valid' : 'missing_required',
  });

  // --- Invalid inputs: missing required fields ---
  for (const key of required) {
    const partial: Record<string, unknown> = {};
    for (const otherKey of required) {
      if (otherKey !== key) {
        partial[otherKey] = generateValidValue(properties[otherKey] ?? { type: 'string' });
      }
    }
    inputs.push({
      label: `Missing required field: "${key}"`,
      data: partial,
      expectValid: false,
      category: 'missing_required',
    });
  }

  // --- Invalid inputs: wrong types ---
  for (const [key, propSchema] of Object.entries(properties)) {
    const wrongValue = generateWrongTypeValue(propSchema);
    if (wrongValue !== undefined) {
      const wrongType: Record<string, unknown> = {};
      for (const otherKey of required) {
        wrongType[otherKey] = generateValidValue(properties[otherKey] ?? { type: 'string' });
      }
      wrongType[key] = wrongValue;
      inputs.push({
        label: `Wrong type for "${key}": expected ${propSchema.type}, got ${typeof wrongValue}`,
        data: wrongType,
        expectValid: false,
        category: 'wrong_type',
      });
    }
  }

  // --- Boundary inputs ---
  inputs.push({
    label: 'Null input',
    data: null,
    expectValid: false,
    category: 'boundary',
  });

  inputs.push({
    label: 'Array instead of object',
    data: [],
    expectValid: false,
    category: 'boundary',
  });

  inputs.push({
    label: 'String instead of object',
    data: 'not-an-object',
    expectValid: false,
    category: 'boundary',
  });

  // --- Injection strings (for string fields) ---
  const injectionStrings = [
    { label: 'SQL injection', value: "'; DROP TABLE users; --" },
    { label: 'XSS payload', value: '<script>alert(1)</script>' },
    { label: 'Path traversal', value: '../../../../etc/passwd' },
    { label: 'Null bytes', value: 'test\x00injection' },
    { label: 'Unicode overflow', value: '\u{10FFFF}'.repeat(100) },
    { label: 'Empty string', value: '' },
    { label: 'Very long string', value: 'x'.repeat(10000) },
  ];

  for (const [key, propSchema] of Object.entries(properties)) {
    if (propSchema.type === 'string') {
      for (const injection of injectionStrings) {
        const injectionInput: Record<string, unknown> = {};
        for (const otherKey of required) {
          injectionInput[otherKey] = generateValidValue(properties[otherKey] ?? { type: 'string' });
        }
        injectionInput[key] = injection.value;
        inputs.push({
          label: `${injection.label} in "${key}"`,
          data: injectionInput,
          // These may or may not be valid — we're testing for crashes, not validation
          expectValid: true,
          category: 'injection',
        });
      }
      break; // Only inject into the first string field to keep test count manageable
    }
  }

  return inputs;
}

// --- Value generators ---

export function generateValidValue(schema: Record<string, unknown>): unknown {
  const type = schema.type as string;

  switch (type) {
    case 'string': {
      if (schema.enum) return (schema.enum as unknown[])[0];
      if (schema.default !== undefined) return schema.default;
      return 'test-value';
    }
    case 'number':
    case 'integer': {
      if (schema.default !== undefined) return schema.default;
      const min = (schema.minimum ?? 0) as number;
      const max = (schema.maximum ?? min + 100) as number;
      return type === 'integer' ? Math.floor((min + max) / 2) : (min + max) / 2;
    }
    case 'boolean':
      return schema.default ?? true;
    case 'array':
      return schema.default ?? [];
    case 'object':
      return schema.default ?? {};
    default:
      return 'test-value';
  }
}

export function generateWrongTypeValue(schema: Record<string, unknown>): unknown {
  const type = schema.type as string;

  switch (type) {
    case 'string':
      return 12345;
    case 'number':
    case 'integer':
      return 'not-a-number';
    case 'boolean':
      return 'not-a-boolean';
    case 'array':
      return 'not-an-array';
    case 'object':
      return 'not-an-object';
    default:
      return undefined;
  }
}
