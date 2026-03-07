/**
 * MCP Probe configuration schema.
 * Defines the full config structure validated with Zod.
 * Exported as public API for downstream tooling (VS Code extensions, config generators).
 */
import { z } from 'zod';

// --- Env var resolution ---
const EnvRefSchema = z.object({ env: z.string() });
const SecretStringSchema = z.union([z.string(), EnvRefSchema]);

// --- Auth schemas ---
const BearerAuthSchema = z.object({
  type: z.literal('bearer'),
  token: SecretStringSchema,
});

const ApiKeyAuthSchema = z.object({
  type: z.literal('apikey'),
  header: z.string().default('X-API-Key'),
  key: SecretStringSchema,
});

const OAuthAuthSchema = z.object({
  type: z.literal('oauth'),
  clientId: SecretStringSchema,
  clientSecret: SecretStringSchema,
  tokenUrl: z.string().url(),
  scopes: z.array(z.string()).optional(),
});

const AuthSchema = z.discriminatedUnion('type', [
  BearerAuthSchema,
  ApiKeyAuthSchema,
  OAuthAuthSchema,
]);

// --- Transport schemas ---
const StdioTransportSchema = z.object({
  type: z.literal('stdio'),
  command: z.string(),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
});

const HttpTransportSchema = z.object({
  type: z.literal('http'),
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
});

const SseTransportSchema = z.object({
  type: z.literal('sse'),
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
});

const TransportSchema = z.discriminatedUnion('type', [
  StdioTransportSchema,
  HttpTransportSchema,
  SseTransportSchema,
]);

// --- Tool safety classification override ---
const ToolSafetyOverrideSchema = z.object({
  readOnly: z.array(z.string()).default([]),
  write: z.array(z.string()).default([]),
});

// --- Server config ---
const ServerConfigSchema = z.object({
  name: z.string().min(1),
  transport: TransportSchema,
  auth: AuthSchema.optional(),
  toolSafety: ToolSafetyOverrideSchema.optional(),
  timeout: z.object({
    request: z.number().positive().default(30_000),
    test: z.number().positive().default(300_000),
  }).optional(),
  tags: z.array(z.string()).optional(),
});

// --- Suite selection ---
const SuiteSelectionSchema = z.object({
  include: z.array(z.string()).default(['protocol', 'schema', 'execution', 'error-handling', 'edge-cases', 'security']),
  exclude: z.array(z.string()).default([]),
});

// --- Output config ---
const OutputConfigSchema = z.object({
  format: z.enum(['json', 'html', 'junit']).default('json'),
  dir: z.string().default('./mcp-probe-results'),
  verbose: z.boolean().default(false),
});

// --- Performance testing (optional, opt-in) ---
const PerformanceThresholdsSchema = z.object({
  p95LatencyMs: z.number().positive().default(500),
  minRps: z.number().positive().default(10),
});

const PerformanceConfigSchema = z.object({
  enabled: z.boolean().default(false),
  iterations: z.number().positive().default(10),
  maxConcurrent: z.number().positive().default(50),
  thresholds: PerformanceThresholdsSchema.optional().default({}),
});

// --- LLM judge (optional) ---
const LLMJudgeConfigSchema = z.object({
  enabled: z.boolean().default(false),
  baseUrl: z.string().url(),
  apiKey: SecretStringSchema,
  model: z.string().default('claude-sonnet-4-20250514'),
  maxTokens: z.number().positive().default(1024),
});

// --- Top-level defaults ---
const DefaultsSchema = z.object({
  timeout: z.object({
    request: z.number().positive().default(30_000),
    test: z.number().positive().default(300_000),
  }).optional(),
  maxConcurrent: z.number().positive().default(10),
  maxOutputBytes: z.number().positive().default(1_048_576),
  allowWriteFuzzing: z.boolean().default(false),
});

// --- Root config ---
export const MCPProbeConfigSchema = z.object({
  version: z.literal('1'),
  servers: z.array(ServerConfigSchema).min(1),
  suites: SuiteSelectionSchema.optional(),
  defaults: DefaultsSchema.optional(),
  output: OutputConfigSchema.optional(),
  performance: PerformanceConfigSchema.optional(),
  llmJudge: LLMJudgeConfigSchema.optional(),
});

// --- Exported types ---
export type MCPProbeConfig = z.infer<typeof MCPProbeConfigSchema>;
export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type TransportConfig = z.infer<typeof TransportSchema>;
export type AuthConfig = z.infer<typeof AuthSchema>;
export type ToolSafetyOverride = z.infer<typeof ToolSafetyOverrideSchema>;
export type OutputConfig = z.infer<typeof OutputConfigSchema>;
export type LLMJudgeConfig = z.infer<typeof LLMJudgeConfigSchema>;
export type PerformanceConfig = z.infer<typeof PerformanceConfigSchema>;
export type DefaultsConfig = z.infer<typeof DefaultsSchema>;

export {
  ServerConfigSchema,
  TransportSchema,
  AuthSchema,
  OutputConfigSchema,
  DefaultsSchema,
  PerformanceConfigSchema,
  LLMJudgeConfigSchema,
};
