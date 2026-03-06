/**
 * Config loader — parses YAML/JSON config files, resolves env var references,
 * validates against Zod schema, and returns a typed MCPProbeConfig.
 */
import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { MCPProbeConfigSchema, type MCPProbeConfig } from './schema.js';

export class ConfigLoadError extends Error {
  constructor(
    message: string,
    public readonly filePath: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ConfigLoadError';
  }
}

/**
 * Recursively resolve `{ env: "VAR_NAME" }` references in the config
 * to their actual environment variable values.
 */
function resolveEnvRefs(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    return value.map(resolveEnvRefs);
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;

    // Check for { env: "VAR_NAME" } pattern
    if ('env' in obj && typeof obj.env === 'string' && Object.keys(obj).length === 1) {
      const envVar = obj.env;
      const envValue = process.env[envVar];
      if (envValue === undefined) {
        throw new Error(`Environment variable "${envVar}" is not set`);
      }
      return envValue;
    }

    const resolved: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      resolved[key] = resolveEnvRefs(val);
    }
    return resolved;
  }

  return value;
}

/**
 * Load and validate an MCP Probe config file.
 */
export function loadConfig(filePath: string): MCPProbeConfig {
  const absolutePath = resolve(filePath);
  let raw: string;

  try {
    raw = readFileSync(absolutePath, 'utf-8');
  } catch (err) {
    throw new ConfigLoadError(`Cannot read config file: ${absolutePath}`, absolutePath, err);
  }

  let parsed: unknown;
  const ext = extname(absolutePath).toLowerCase();

  try {
    if (ext === '.yaml' || ext === '.yml') {
      parsed = parseYaml(raw);
    } else if (ext === '.json') {
      parsed = JSON.parse(raw);
    } else {
      // Try YAML first (superset of JSON), fall back to JSON
      try {
        parsed = parseYaml(raw);
      } catch {
        parsed = JSON.parse(raw);
      }
    }
  } catch (err) {
    throw new ConfigLoadError(`Failed to parse config file: ${absolutePath}`, absolutePath, err);
  }

  // Resolve environment variable references
  let resolved: unknown;
  try {
    resolved = resolveEnvRefs(parsed);
  } catch (err) {
    throw new ConfigLoadError(
      `Failed to resolve environment variables in config: ${(err as Error).message}`,
      absolutePath,
      err,
    );
  }

  // Validate against Zod schema
  const result = MCPProbeConfigSchema.safeParse(resolved);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new ConfigLoadError(
      `Invalid config:\n${issues}`,
      absolutePath,
      result.error,
    );
  }

  return result.data;
}

/**
 * Validate a config object without loading from file.
 * Useful for programmatic usage.
 */
export function validateConfig(config: unknown): MCPProbeConfig {
  const resolved = resolveEnvRefs(config);
  const result = MCPProbeConfigSchema.safeParse(resolved);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid config:\n${issues}`);
  }
  return result.data;
}
