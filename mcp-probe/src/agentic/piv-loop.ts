/**
 * PIV Loop — Plan-Implement-Validate cycle for each workflow step.
 *
 * Plan:      Analyze schema, resolve args, define validation criteria
 * Implement: Execute the tool call
 * Validate:  Classify errors, extract outputs, decide on retry
 *
 * Retriable errors (rate_limit, timeout, server_error) are retried
 * with exponential backoff. Non-retriable errors fail immediately.
 */
import type { MCPProbeClient } from '../client/mcp-client.js';
import type { DiscoveredTool } from '../client/mcp-client.js';
import type { WorkflowStepDef } from '../suite/workflow/types.js';
import {
  resolveStepArgs,
  unwrapMCPResponse,
  getNestedField,
  setNestedField,
} from '../suite/workflow/output-resolver.js';
import { fillRequiredFields, type SchemaContext } from './schema-aware-builder.js';
import { extractResourceFamily, singularize } from '../suite/workflow/crud-patterns.js';
import type { StepSummary } from './types.js';

// === Types ===

export type ErrorCategory =
  | 'auth_error'
  | 'rate_limit'
  | 'validation_error'
  | 'not_found'
  | 'not_supported'
  | 'server_error'
  | 'timeout'
  | 'schema_mismatch'
  | 'unknown';

export interface PIVPhase {
  phase: 'plan' | 'implement' | 'validate';
  durationMs: number;
}

export interface StepPlan {
  resolvedArgs: Record<string, unknown>;
  isReady: boolean;
  unresolvedInputs: string[];
  planningNotes: string[];
}

export interface ValidationResult {
  passed: boolean;
  errorCategory?: ErrorCategory;
  errorMessage?: string;
  isRetriable: boolean;
  extractedOutputs: Record<string, unknown>;
}

export interface PIVStepResult {
  summary: StepSummary;
  pivPhases: PIVPhase[];
  attempts: number;
  errorCategory?: ErrorCategory;
  planningNotes: string[];
}

export interface PIVConfig {
  maxRetries?: number;
  baseDelayMs?: number;
}

/** Interface for LLM-powered intent analysis in the PIV loop. */
export interface LLMIntentAnalyzer {
  suggestArgs(
    toolName: string,
    description: string,
    schema: Record<string, unknown>,
    operation: string,
    entity: string,
  ): Promise<{ suggestedArgs: Record<string, unknown>; confidence: number; reasoning: string }>;
  diagnoseError(
    toolName: string,
    args: Record<string, unknown>,
    errorResponse: unknown,
    schema: Record<string, unknown>,
    availableOutputs?: Record<string, unknown>,
  ): Promise<{ diagnosis: string; suggestedFix?: Record<string, unknown>; shouldRetry: boolean }>;
}

// === PIV Loop ===

/**
 * Execute a workflow step through the Plan→Implement→Validate cycle.
 */
export async function executeStepWithPIV(
  step: WorkflowStepDef,
  client: MCPProbeClient,
  outputStore: Map<string, unknown>,
  tool: DiscoveredTool | undefined,
  config: PIVConfig = {},
  llm?: LLMIntentAnalyzer,
): Promise<PIVStepResult> {
  // When LLM is available, grant an extra retry so both deterministic AND LLM recovery get a chance
  const maxRetries = llm ? Math.max(config.maxRetries ?? 1, 2) : (config.maxRetries ?? 1);
  const baseDelay = config.baseDelayMs ?? 1000;
  const pivPhases: PIVPhase[] = [];
  const planningNotes: string[] = [];
  let attempts = 0;
  let lastResult: ValidationResult | undefined;
  let deterministicFixAttempted = false;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    attempts = attempt + 1;

    // === PLAN ===
    const planStart = Date.now();
    const plan = await planStep(step, outputStore, tool, planningNotes, llm);
    pivPhases.push({ phase: 'plan', durationMs: Date.now() - planStart });

    if (!plan.isReady) {
      return buildSkippedResult(step, plan, pivPhases, attempts);
    }

    // === IMPLEMENT ===
    const implStart = Date.now();
    let trace;
    let implError: string | undefined;
    try {
      trace = await client.callTool(step.toolName, plan.resolvedArgs);
    } catch (err) {
      implError = err instanceof Error ? err.message : String(err);
    }
    pivPhases.push({ phase: 'implement', durationMs: Date.now() - implStart });

    // === VALIDATE ===
    const valStart = Date.now();
    if (implError) {
      lastResult = {
        passed: false,
        errorCategory: classifyError(implError),
        errorMessage: implError,
        isRetriable: isRetriableCategory(classifyError(implError)),
        extractedOutputs: {},
      };
    } else {
      lastResult = validateStep(step, trace!, outputStore);
    }
    pivPhases.push({ phase: 'validate', durationMs: Date.now() - valStart });

    // If passed or not retriable, stop (unless error recovery can help)
    if (lastResult.passed || attempt >= maxRetries) {
      break;
    }

    // --- ERROR RECOVERY: deterministic first (once), then LLM ---

    // Deterministic error recovery — try ONCE, then let LLM take over on subsequent failures.
    // Fixes are persisted into step.argsTemplate so they survive planStep() re-resolution on retry.
    if (!deterministicFixAttempted && !lastResult.isRetriable && lastResult.errorCategory === 'validation_error' && tool?.inputSchema) {
      deterministicFixAttempted = true;
      const fix = tryDeterministicFix(
        lastResult.errorMessage ?? '',
        plan.resolvedArgs,
        tool.inputSchema,
        step,
        outputStore,
      );
      if (fix) {
        // Persist the fix into argsTemplate so it survives planStep re-resolution on retry.
        // resolveStepArgs() deep-clones argsTemplate, then inputMappings overwrite any ID fields,
        // so stale values from this merge won't interfere with fresh output store lookups.
        deepMerge(step.argsTemplate as Record<string, unknown>, plan.resolvedArgs);
        lastResult.isRetriable = true;
        planningNotes.push(`Deterministic fix: ${fix.fixApplied}`);
      }
    }

    // LLM error diagnosis — fires when:
    // 1. Deterministic fix wasn't applicable (returned null)
    // 2. OR deterministic fix was already tried on a previous attempt but the error persists
    // This ensures LLM gets a chance to apply smarter, context-aware fixes.
    if (llm && !lastResult.isRetriable && lastResult.errorCategory === 'validation_error' && tool?.inputSchema) {
      try {
        const availableOutputs = Object.fromEntries(outputStore.entries());
        const diagnosis = await llm.diagnoseError(
          step.toolName,
          plan.resolvedArgs,
          lastResult.errorMessage,
          tool.inputSchema,
          availableOutputs,
        );
        planningNotes.push(`LLM diagnosis: ${diagnosis.diagnosis}`);
        if (diagnosis.shouldRetry && diagnosis.suggestedFix) {
          // Apply LLM fix to both current args AND argsTemplate (persist across retries)
          deepMerge(plan.resolvedArgs, diagnosis.suggestedFix);
          deepMerge(step.argsTemplate as Record<string, unknown>, diagnosis.suggestedFix);
          lastResult.isRetriable = true;
          planningNotes.push('LLM suggested fix applied, retrying');
        }
      } catch {
        planningNotes.push('LLM error diagnosis failed');
      }
    }

    if (!lastResult.isRetriable) {
      break;
    }

    // Retry with exponential backoff
    planningNotes.push(`Retry ${attempt + 1}: ${lastResult.errorCategory} — ${lastResult.errorMessage?.substring(0, 80)}`);
    await sleep(baseDelay * Math.pow(2, attempt));
  }

  return buildFinalResult(step, lastResult!, pivPhases, attempts, planningNotes);
}

// === Plan Phase ===

async function planStep(
  step: WorkflowStepDef,
  outputStore: Map<string, unknown>,
  tool: DiscoveredTool | undefined,
  planningNotes: string[],
  llm?: LLMIntentAnalyzer,
): Promise<StepPlan> {
  // Resolve args from template + output store
  const { resolved, unresolved } = resolveStepArgs(
    step.argsTemplate,
    step.inputMappings,
    outputStore,
  );

  if (unresolved.length > 0) {
    return {
      resolvedArgs: resolved,
      isReady: false,
      unresolvedInputs: unresolved,
      planningNotes: [`Skipped: unresolved inputs: ${unresolved.join(', ')}`],
    };
  }

  // Enhance args with schema-aware filling for required fields
  if (tool?.inputSchema) {
    enhanceWithSchemaArgs(resolved, tool.inputSchema, step, planningNotes);
    deepEnhanceContainers(resolved, tool.inputSchema, step, planningNotes);
    preValidateArgs(resolved, tool.inputSchema, step, planningNotes);
  }

  // LLM arg suggestion: fill gaps that schema-aware filling couldn't handle
  if (llm && tool?.inputSchema) {
    await llmEnhanceArgs(resolved, tool.inputSchema, step, planningNotes, llm);
  }

  return {
    resolvedArgs: resolved,
    isReady: true,
    unresolvedInputs: [],
    planningNotes,
  };
}

/**
 * Enhance resolved args by filling missing required fields from the schema.
 * Only adds fields that are required AND not already present at the top level.
 *
 * Does NOT fill sub-fields of existing objects (path_variables, query_params, body).
 * Those are populated by buildArgsFromSchema() hints and inputMappings at runtime.
 * Filling sub-fields aggressively causes regressions (bogus IDs, wrong module values).
 */
function enhanceWithSchemaArgs(
  resolved: Record<string, unknown>,
  inputSchema: Record<string, unknown>,
  step: WorkflowStepDef,
  planningNotes: string[],
): void {
  const properties = (inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = (inputSchema.required ?? []) as string[];

  // Build runtime field set from inputMappings
  const runtimeFields = new Set(step.inputMappings.map((m) => m.paramPath));

  for (const key of required) {
    if (key === 'headers') continue; // Handled by transport/auth
    if (resolved[key] !== undefined) continue; // Already provided by argsTemplate — don't modify

    // Missing required top-level field — generate from schema
    const propSchema = properties[key];
    if (!propSchema) continue;

    const context: SchemaContext = {
      runtimeFields,
    };

    const value = fillRequiredFields(propSchema, context, key);
    if (value !== undefined) {
      resolved[key] = value;
      planningNotes.push(`Schema-filled required field: ${key}`);
    }
  }
}

// === Validate Phase ===

interface ToolCallTrace {
  response: unknown;
  isError: boolean;
  durationMs: number;
}

function validateStep(
  step: WorkflowStepDef,
  trace: ToolCallTrace,
  outputStore: Map<string, unknown>,
): ValidationResult {
  const unwrapped = unwrapMCPResponse(trace.response);

  // Extract outputs
  const extractedOutputs: Record<string, unknown> = {};
  for (const mapping of step.outputMappings) {
    if (outputStore.has(mapping.name)) continue;
    const value = getNestedField(unwrapped, mapping.path);
    if (value !== undefined && value !== null) {
      outputStore.set(mapping.name, value);
      extractedOutputs[mapping.name] = value;
    }
  }

  if (trace.isError) {
    const errorStr = typeof unwrapped === 'string'
      ? unwrapped
      : JSON.stringify(unwrapped);
    const category = classifyError(errorStr);

    return {
      passed: false,
      errorCategory: category,
      errorMessage: errorStr.length > 200 ? errorStr.substring(0, 200) + '...' : errorStr,
      isRetriable: isRetriableCategory(category),
      extractedOutputs,
    };
  }

  // For create steps, validate that we extracted a record ID
  if (step.operation === 'create' && step.outputMappings.length > 0) {
    const hasId = step.outputMappings.some((m) => outputStore.has(m.name));
    if (!hasId) {
      // Dynamic scan: try any top-level array `[0].details.id` or `[0].id`
      const dynamicId = scanResponseForId(unwrapped);
      if (dynamicId !== undefined && dynamicId !== null) {
        const idName = step.outputMappings[0]?.name ?? 'createdRecordId';
        outputStore.set(idName, dynamicId);
        extractedOutputs[idName] = dynamicId;
      } else {
        return {
          passed: false,
          errorCategory: 'schema_mismatch',
          errorMessage: 'Create succeeded but no record ID found in response',
          isRetriable: false,
          extractedOutputs,
        };
      }
    }
  }

  // For successful non-create steps, scan the response for entity IDs.
  // This captures IDs from "other" steps like Add_Tags, so downstream tools
  // (Get_Record_Count_For_Tag, Update_Tag) get the fresh ID instead of a stale one.
  if (step.operation !== 'create') {
    const dynamicId = scanResponseForId(unwrapped);
    if (dynamicId !== undefined && dynamicId !== null) {
      // Extract entity family from tool name (e.g., "Add_Tags" → "tag")
      const toolParts = step.toolName.replace(/^[A-Za-z]+_/, ''); // strip prefix like "ZohoCRM_"
      const family = extractResourceFamily(toolParts);
      if (family) {
        const idKey = `fetched_${family}_id`;
        // Only update if this is a secondary entity key (not createdRecordId)
        if (idKey !== 'fetched_record_id') {
          outputStore.set(idKey, dynamicId);
          extractedOutputs[idKey] = dynamicId;
        }
      }
    }
  }

  return {
    passed: true,
    extractedOutputs,
    isRetriable: false,
  };
}

/**
 * Dynamically scan a response for an ID when static RESPONSE_ID_PATHS fail.
 * Handles non-standard responses like `{ profiles: [{ id: "..." }] }`,
 * `{ roles: [{ id: "..." }] }`, or nested wrappers like
 * `{ data: { profiles: [{ id: "..." }] } }` where the wrapper key varies by entity.
 *
 * Recurses into non-array objects up to `maxDepth` levels to find IDs.
 */
function scanResponseForId(response: unknown, depth = 0): unknown {
  if (depth > 3) return undefined; // Prevent infinite recursion
  if (!response || typeof response !== 'object') return undefined;
  const obj = response as Record<string, unknown>;

  // Try direct `id` on the response itself
  if (obj.id !== undefined && obj.id !== null) return obj.id;

  // Scan all keys for arrays containing objects with IDs, or nested objects
  for (const value of Object.values(obj)) {
    if (Array.isArray(value) && value.length > 0) {
      const first = value[0];
      if (!first || typeof first !== 'object') continue;
      const item = first as Record<string, unknown>;

      // Try details.id first (Zoho CRM pattern), then direct id
      if (item.details && typeof item.details === 'object') {
        const detailsId = (item.details as Record<string, unknown>).id;
        if (detailsId !== undefined && detailsId !== null) return detailsId;
      }
      if (item.id !== undefined && item.id !== null) return item.id;
    }

    // Recurse into non-array objects (handles nested wrappers like { data: { profiles: [...] } })
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = scanResponseForId(value, depth + 1);
      if (nested !== undefined) return nested;
    }
  }

  return undefined;
}

// === Error Classification ===

const ERROR_PATTERNS: Array<{ pattern: RegExp; category: ErrorCategory }> = [
  // Auth errors
  { pattern: /\b(401|unauthorized|authentication|invalid.?token|expired.?token|forbidden)\b/i, category: 'auth_error' },
  // Rate limiting
  { pattern: /\b(429|rate.?limit|too.?many.?requests|throttl)/i, category: 'rate_limit' },
  // Feature not supported / no permission / already done / not configured (unfixable — depends on API edition/permissions/state/config)
  { pattern: /\b(NOT_SUPPORTED_FEATURE|FEATURE_NOT_SUPPORTED|FEATURE_NOT_ENABLED|not.?supported.?for.?current|NO_PERMISSION|not.?allowed|ALREADY_ACTIVATED)\b/i, category: 'not_supported' },
  { pattern: /no.*rule.*configured|feature.*not.*available|not.*configured.*for/i, category: 'not_supported' },
  // Validation errors — MUST be before not_found because structured API errors like
  // MANDATORY_NOT_FOUND contain "not found" which would otherwise match not_found.
  { pattern: /\b(400|bad.?request|invalid|validation|required.?field|missing.?param|INVALID_DATA|MANDATORY_NOT_FOUND|REQUIRED_PARAM_MISSING|DUPLICATE_DATA)\b/i, category: 'validation_error' },
  // Not found (generic — checked AFTER validation to avoid false positives on structured errors)
  { pattern: /\b(404|not.?found|no.?such|does.?not.?exist)\b/i, category: 'not_found' },
  // Server errors
  { pattern: /\b(500|502|503|504|internal.?server|service.?unavailable|bad.?gateway)\b/i, category: 'server_error' },
  // Timeout
  { pattern: /\b(timeout|timed?.?out|ETIMEDOUT|ECONNRESET)\b/i, category: 'timeout' },
];

function classifyError(errorStr: string): ErrorCategory {
  for (const { pattern, category } of ERROR_PATTERNS) {
    if (pattern.test(errorStr)) {
      return category;
    }
  }
  return 'unknown';
}

function isRetriableCategory(category: ErrorCategory): boolean {
  return category === 'rate_limit' || category === 'timeout' || category === 'server_error';
}

// === Result Builders ===

function buildSkippedResult(
  step: WorkflowStepDef,
  plan: StepPlan,
  pivPhases: PIVPhase[],
  attempts: number,
): PIVStepResult {
  return {
    summary: {
      operation: step.operation,
      toolName: step.toolName,
      status: 'skipped',
      durationMs: 0,
      isError: false,
      errorMessage: `Unresolved inputs: ${plan.unresolvedInputs.join(', ')}`,
      inputArgs: truncateForTransport(plan.resolvedArgs),
    },
    pivPhases,
    attempts,
    planningNotes: plan.planningNotes,
  };
}

function buildFinalResult(
  step: WorkflowStepDef,
  validation: ValidationResult,
  pivPhases: PIVPhase[],
  attempts: number,
  planningNotes: string[],
): PIVStepResult {
  // Get total duration from implement phases
  const implDuration = pivPhases
    .filter((p) => p.phase === 'implement')
    .reduce((sum, p) => sum + p.durationMs, 0);

  const extractedId = validation.extractedOutputs.createdRecordId
    ? String(validation.extractedOutputs.createdRecordId)
    : undefined;

  // Reclassify unfixable MANDATORY_NOT_FOUND as not_supported.
  // If after all retries (including LLM), a MANDATORY_NOT_FOUND on an ID field persists,
  // it means the environment lacks the required entity (e.g., no valid profile, role, or territory).
  // This is an environment limitation, not a framework bug — classify as skipped.
  let finalCategory = validation.errorCategory;
  if (finalCategory === 'validation_error' && validation.errorMessage) {
    const parsed = parseStructuredError(validation.errorMessage);
    if (parsed?.code === 'MANDATORY_NOT_FOUND' && parsed.apiName) {
      const fieldName = parsed.apiName.toLowerCase();
      if (fieldName === 'id' || fieldName.endsWith('_id')) {
        finalCategory = 'not_supported';
      }
    }
  }

  // Map not_supported errors to 'skipped' — these are unfixable (API edition/permission limits)
  const status = validation.passed
    ? 'passed'
    : finalCategory === 'not_supported'
      ? 'skipped'
      : 'failed';

  return {
    summary: {
      operation: step.operation,
      toolName: step.toolName,
      status,
      durationMs: implDuration,
      isError: !validation.passed && status !== 'skipped',
      extractedId: step.operation === 'create' ? extractedId : undefined,
      errorMessage: validation.errorMessage,
      inputArgs: undefined, // Will be set by caller from plan args
      actualResponse: undefined, // Will be set by caller
      extractedOutputs: Object.keys(validation.extractedOutputs).length > 0
        ? validation.extractedOutputs
        : undefined,
    },
    pivPhases,
    attempts,
    errorCategory: finalCategory ?? validation.errorCategory,
    planningNotes,
  };
}

const MAX_TRANSPORT_SIZE = 2000;

function truncateForTransport(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  const str = JSON.stringify(value);
  if (!str) return undefined;
  if (str.length <= MAX_TRANSPORT_SIZE) return value as Record<string, unknown>;
  return { _truncated: true, _preview: str.substring(0, MAX_TRANSPORT_SIZE) + '...' } as Record<string, unknown>;
}

/**
 * LLM-enhanced arg filling — called when schema-aware filling has gaps.
 * Only fills required fields that are still missing after deterministic filling.
 */
async function llmEnhanceArgs(
  resolved: Record<string, unknown>,
  inputSchema: Record<string, unknown>,
  step: WorkflowStepDef,
  planningNotes: string[],
  llm: LLMIntentAnalyzer,
): Promise<void> {
  const properties = (inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = (inputSchema.required ?? []) as string[];

  // Check if any required fields are still missing
  const missing = required.filter((k) => k !== 'headers' && resolved[k] === undefined && properties[k]);
  if (missing.length === 0) return; // All required fields filled — no LLM needed

  try {
    const suggestion = await llm.suggestArgs(
      step.toolName,
      step.description,
      inputSchema,
      step.operation,
      step.description.match(/(\w+)\s*record/i)?.[1] ?? 'unknown',
    );

    // Only merge fields that are still missing (don't overwrite existing)
    for (const key of missing) {
      if (suggestion.suggestedArgs[key] !== undefined) {
        resolved[key] = suggestion.suggestedArgs[key];
        planningNotes.push(`LLM-suggested field: ${key} (confidence: ${suggestion.confidence})`);
      }
    }
  } catch {
    planningNotes.push('LLM arg suggestion failed, using schema-only args');
  }
}

/**
 * Deep merge source into target. Source values override target values.
 * For nested objects, merges recursively. For arrays, replaces.
 */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = target[key];

    if (
      srcVal !== null && typeof srcVal === 'object' && !Array.isArray(srcVal) &&
      tgtVal !== null && typeof tgtVal === 'object' && !Array.isArray(tgtVal)
    ) {
      deepMerge(tgtVal as Record<string, unknown>, srcVal as Record<string, unknown>);
    } else {
      target[key] = srcVal;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// === Phase 1: Deep Container Enhancement ===

/** Regex for ID-like fields that need real IDs — never fill with generated values.
 * Matches: id, ids, record_id, recordID, territory_id, cvid, layout_id, fieldId, etc.
 */
const ID_LIKE_FIELD = /^(id|ids|cvid)$|[_]id$|Id$|ID$|_ids$/i;

/** Matches response-only audit fields that should not be sent in create/update requests */
const AUDIT_FIELD = /^(created_by|modified_by|created_time|modified_time|Created_By|Modified_By|Created_Time|Modified_Time)$/i;

/**
 * Query param fields safe to deep-fill when missing. WHITELIST approach:
 * Only fill params whose purpose is clear and safe to auto-generate.
 * Other required params are too risky (they change API behavior unexpectedly).
 */
const SAFE_QUERY_PARAMS = /^(fields|word|criteria|per_page|page|sort_by|sort_order|type|converted|include_child|approval_state)$/i;

/**
 * Deep-fill required sub-fields inside existing container objects (query_params, path_variables, body).
 * The top-level enhanceWithSchemaArgs() skips containers that already exist (e.g., query_params: {}).
 * This function recurses INTO those containers to fill any required sub-fields that are still missing.
 *
 * Safety: only fills schema-required sub-fields, skips ID-like fields and inputMappings-covered paths.
 */
function deepEnhanceContainers(
  resolved: Record<string, unknown>,
  inputSchema: Record<string, unknown>,
  step: WorkflowStepDef,
  planningNotes: string[],
): void {
  const properties = (inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const runtimeFields = new Set(step.inputMappings.map((m) => m.paramPath));

  // Enhance query_params sub-fields ONLY.
  // path_variables are URL route segments — they must ONLY come from
  // workflow hints (module) or inputMappings (IDs). Filling them with
  // generated values causes INVALID_URL_PATTERN errors.
  for (const containerKey of ['query_params'] as const) {
    const container = resolved[containerKey];
    if (!container || typeof container !== 'object' || Array.isArray(container)) continue;

    const containerSchema = properties[containerKey];
    if (!containerSchema) continue;

    fillMissingSubFields(
      container as Record<string, unknown>,
      containerSchema,
      containerKey,
      runtimeFields,
      planningNotes,
    );
  }

  // Enhance ALL required body arrays: fill missing items and sub-fields
  // Handles body.data, body.tags, body.layouts, body.fields, etc.
  const body = resolved.body as Record<string, unknown> | undefined;
  const bodySchema = properties.body;
  if (body && typeof body === 'object' && bodySchema) {
    enhanceBodyArrays(body, bodySchema, runtimeFields, planningNotes);
  }
}

/**
 * Fill missing required sub-fields in a container object.
 */
function fillMissingSubFields(
  container: Record<string, unknown>,
  containerSchema: Record<string, unknown>,
  containerKey: string,
  runtimeFields: Set<string>,
  planningNotes: string[],
): void {
  const subProperties = (containerSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const subRequired = (containerSchema.required ?? []) as string[];

  for (const subKey of subRequired) {
    if (container[subKey] !== undefined) continue; // Already present
    if (ID_LIKE_FIELD.test(subKey) || AUDIT_FIELD.test(subKey)) continue; // ID/audit fields need real values
    if (containerKey === 'query_params' && !SAFE_QUERY_PARAMS.test(subKey)) continue; // Whitelist for query_params
    if (runtimeFields.has(`${containerKey}.${subKey}`)) continue; // Covered by inputMappings

    const subSchema = subProperties[subKey];
    if (!subSchema) continue;

    const value = fillRequiredFields(subSchema, { skipIdFields: true }, `${containerKey}.${subKey}`);
    if (value !== undefined) {
      container[subKey] = value;
      planningNotes.push(`Deep-filled: ${containerKey}.${subKey}`);
    }
  }
}

/**
 * Enhance ALL required array fields in the body object.
 * For each required array (data, tags, layouts, fields, etc.):
 *   - If empty: create one item from the array's items schema
 *   - If non-empty: fill missing required sub-fields in each item
 */
function enhanceBodyArrays(
  body: Record<string, unknown>,
  bodySchema: Record<string, unknown>,
  runtimeFields: Set<string>,
  planningNotes: string[],
): void {
  const bodyProps = (bodySchema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const bodyRequired = (bodySchema.required ?? []) as string[];

  for (const arrayKey of bodyRequired) {
    const arraySchema = bodyProps[arrayKey];
    if (!arraySchema || arraySchema.type !== 'array') continue;

    const itemsSchema = arraySchema.items as Record<string, unknown> | undefined;
    if (!itemsSchema) continue;

    let arr = body[arrayKey];

    // If the array is empty [], create one item from schema
    // Pass skipIdFields: true so synthetic IDs aren't injected into array items —
    // real IDs come from producers/inputMappings or deterministic error recovery.
    if (Array.isArray(arr) && arr.length === 0) {
      const newItem = fillRequiredFields(itemsSchema, { skipIdFields: true }, `body.${arrayKey}[]`);
      if (newItem !== undefined && typeof newItem === 'object') {
        arr = [newItem];
        body[arrayKey] = arr;
        planningNotes.push(`Created item for empty body.${arrayKey} array`);
      }
    }

    // Now enhance existing items — fill missing required sub-fields
    if (!Array.isArray(arr) || arr.length === 0) continue;

    const itemProps = (itemsSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
    const itemRequired = (itemsSchema.required ?? []) as string[];

    for (const item of arr as Record<string, unknown>[]) {
      if (typeof item !== 'object' || item === null) continue;

      for (const reqKey of itemRequired) {
        if (item[reqKey] !== undefined) continue; // Already present
        if (ID_LIKE_FIELD.test(reqKey) || AUDIT_FIELD.test(reqKey)) continue; // ID/audit fields
        if (runtimeFields.has(`body.${arrayKey}[0].${reqKey}`)) continue;

        const propSchema = itemProps[reqKey];
        if (!propSchema) continue;

        const value = fillRequiredFields(propSchema, { skipIdFields: true }, `body.${arrayKey}[].${reqKey}`);
        if (value !== undefined) {
          item[reqKey] = value;
          planningNotes.push(`Deep-filled body.${arrayKey} item: ${reqKey}`);
        }
      }
    }
  }
}

// === Phase 3: Deterministic Error Recovery ===

interface StructuredError {
  code?: string;
  paramName?: string;
  apiName?: string;
  jsonPath?: string;
  message?: string;
}

/**
 * Parse a structured API error response.
 * Handles multiple formats:
 *   - Top-level: { code, details, message }
 *   - Wrapped in data: { data: [{ code, details, message }] }
 *   - Wrapped in any array: { fields: [{ code, details }], layouts: [{ code, details }] }
 * The last format is common for APIs that return per-item errors in bulk operations.
 */
function parseStructuredError(errorMessage: string): StructuredError | null {
  try {
    const parsed = JSON.parse(errorMessage);
    // Try data[] wrapper first, then top-level
    let error = parsed.data?.[0] ?? (parsed.code ? parsed : null);

    // If no match, look for the first array-valued key containing objects with a 'code' field
    if (!error) {
      for (const key of Object.keys(parsed)) {
        const val = parsed[key];
        if (Array.isArray(val) && val.length > 0 && val[0]?.code) {
          error = val[0];
          break;
        }
      }
    }

    if (!error) return null;
    return {
      code: error.code,
      paramName: error.details?.param_name,
      apiName: error.details?.api_name,
      jsonPath: error.details?.json_path,
      message: error.message,
    };
  } catch {
    return null;
  }
}

/**
 * Search the schema to find which container (query_params, path_variables, body) holds a named param.
 */
function locateParamInSchema(
  paramName: string,
  inputSchema: Record<string, unknown>,
): { containerPath: string; fieldName: string } | null {
  const topProps = (inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;

  for (const containerKey of ['query_params', 'path_variables', 'body']) {
    const containerSchema = topProps[containerKey];
    if (!containerSchema) continue;

    const subProps = (containerSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
    if (subProps[paramName]) {
      return { containerPath: containerKey, fieldName: paramName };
    }
  }
  return null;
}

/**
 * Try to fix a validation error deterministically by parsing the structured error response
 * and applying a targeted fix. Runs BEFORE LLM diagnosis — fast, free, no API cost.
 *
 * Returns the fix description if applied (args are mutated in place), or null if no fix found.
 */
function tryDeterministicFix(
  errorMessage: string,
  resolvedArgs: Record<string, unknown>,
  inputSchema: Record<string, unknown>,
  _step: WorkflowStepDef,
  outputStore?: Map<string, unknown>,
): { fixApplied: string } | null {
  const error = parseStructuredError(errorMessage);
  if (!error?.code) return null;

  // Fix 1: REQUIRED_PARAM_MISSING — fill the named param from schema
  if (error.code === 'REQUIRED_PARAM_MISSING' && error.paramName) {
    const location = locateParamInSchema(error.paramName, inputSchema);
    if (location) {
      const topProps = (inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
      const containerSchema = topProps[location.containerPath];
      const subProps = (containerSchema?.properties ?? {}) as Record<string, Record<string, unknown>>;
      const fieldSchema = subProps[error.paramName];

      if (fieldSchema) {
        const value = fillRequiredFields(fieldSchema, {}, `${location.containerPath}.${error.paramName}`);
        if (value !== undefined) {
          setNestedField(resolvedArgs, `${location.containerPath}.${error.paramName}`, value);
          return { fixApplied: `Filled missing required param: ${location.containerPath}.${error.paramName}` };
        }
      }
    }
  }

  // Fix 2: MANDATORY_NOT_FOUND — add missing field to the body array item identified by json_path.
  // Handles any body array (data, fields, layouts, tags, etc.), not just body.data.
  // When the missing field is 'id', tries to inject a resource-specific ID from the output store.
  if (error.code === 'MANDATORY_NOT_FOUND' && error.apiName) {
    // Determine the target body array from json_path (e.g., "$.fields[0].id" → "fields")
    // or fall back to "data" for backward compatibility.
    let arrayKey = 'data';
    let itemIndex = 0;
    if (error.jsonPath) {
      const jpMatch = error.jsonPath.match(/^\$\.(\w+)\[(\d+)\]/);
      if (jpMatch) {
        arrayKey = jpMatch[1];
        itemIndex = parseInt(jpMatch[2], 10);
      }
    }

    const body = resolvedArgs.body as Record<string, unknown> | undefined;
    const arr = body?.[arrayKey];
    if (body && Array.isArray(arr) && arr.length > itemIndex) {
      const item = arr[itemIndex] as Record<string, unknown>;
      if (item[error.apiName] === undefined) {
        const fieldName = error.apiName;
        const lower = fieldName.toLowerCase();

        // For 'id' fields, try to inject a resource-specific ID from the output store.
        // The array key hints at the resource family (e.g., "profiles" → fetched_profile_id).
        // Uses proper singularization and scans outputStore for best-match keys.
        if (lower === 'id' && outputStore) {
          const family = singularize(arrayKey.toLowerCase());
          const idKey = `fetched_${family}_id`;
          // Try exact family match first, then scan for suffix matches
          let fetchedId = outputStore.get(idKey);
          let usedKey = idKey;
          if (fetchedId === undefined) {
            // Scan for any outputStore key ending with _{family}_id
            for (const [k, v] of outputStore.entries()) {
              if (k.endsWith(`_${family}_id`) && v !== undefined) {
                fetchedId = v;
                usedKey = k;
                break;
              }
            }
          }
          if (fetchedId === undefined) {
            fetchedId = outputStore.get('createdRecordId');
            usedKey = 'createdRecordId';
          }
          if (fetchedId !== undefined) {
            item[fieldName] = fetchedId;
            return { fixApplied: `Injected ${usedKey} into body.${arrayKey}[${itemIndex}].${fieldName} = ${JSON.stringify(fetchedId)}` };
          }
        }

        // Heuristic value based on field name
        let value: unknown = 'MCPProbeTest';
        if (lower.includes('date') || lower.includes('time')) {
          value = new Date().toISOString();
        } else if (lower.includes('email')) {
          value = 'test@mcpprobe.dev';
        } else if (lower.includes('phone')) {
          value = '+1-555-0100';
        } else if (lower.includes('type') || lower.includes('status') || lower.includes('stage')) {
          // Try to find enum from schema
          const topProps = (inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
          const bodySchema = topProps.body;
          const bodyProps = (bodySchema?.properties ?? {}) as Record<string, Record<string, unknown>>;
          const arraySchema = bodyProps[arrayKey];
          const itemsSchema = ((arraySchema as Record<string, unknown>)?.items ?? {}) as Record<string, Record<string, unknown>>;
          const itemProps = (itemsSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
          const fieldDef = itemProps[fieldName];
          if (fieldDef?.enum && Array.isArray(fieldDef.enum)) {
            value = (fieldDef.enum as unknown[])[0];
          }
        }
        item[error.apiName] = value;
        return { fixApplied: `Filled mandatory field: body.${arrayKey}[${itemIndex}].${fieldName} = ${JSON.stringify(value)}` };
      }
    }
  }

  // Fix 3: INVALID_DATA on $.XXX — rebuild body array items from schema
  // Handles $.data, $.tags, $.layouts, $.fields, etc.
  if (error.code === 'INVALID_DATA' && error.jsonPath) {
    const match = error.jsonPath.match(/^\$\.(\w+)$/);
    if (match) {
      const arrayField = match[1];
      const topProps = (inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
      const bodySchema = topProps.body;
      if (bodySchema) {
        const bodyProps = (bodySchema.properties ?? {}) as Record<string, Record<string, unknown>>;
        const arraySchema = bodyProps[arrayField];
        if (arraySchema?.type === 'array' && arraySchema.items) {
          const itemsSchema = arraySchema.items as Record<string, unknown>;
          const newItem = fillRequiredFields(itemsSchema, { skipIdFields: true }, `body.${arrayField}[]`);
          const body = resolvedArgs.body as Record<string, unknown>;
          if (body) {
            const arr = body[arrayField];
            if (Array.isArray(arr) && arr.length > 0) {
              // Merge new fields into existing item (preserve existing values like IDs)
              const existing = arr[0] as Record<string, unknown>;
              const filled = (typeof newItem === 'object' && newItem !== null) ? newItem as Record<string, unknown> : {};
              for (const [k, v] of Object.entries(filled)) {
                if (existing[k] === undefined) {
                  existing[k] = v;
                }
              }
              return { fixApplied: `Rebuilt body.${arrayField}[0] with schema-required fields` };
            } else if (Array.isArray(arr) && arr.length === 0) {
              // Empty array — create one item from schema
              if (typeof newItem === 'object' && newItem !== null) {
                body[arrayField] = [newItem];
                return { fixApplied: `Created item for empty body.${arrayField} array` };
              }
            }
          }
        }
      }
    }
  }

  // Fix 4: DUPLICATE_DATA — append unique suffix to name-like fields
  if (error.code === 'DUPLICATE_DATA') {
    const body = resolvedArgs.body as Record<string, unknown> | undefined;
    if (body) {
      const suffix = `_${Date.now().toString(36).slice(-4)}`;
      let fixed = false;
      for (const [key, val] of Object.entries(body)) {
        if (typeof val === 'string' && /name/i.test(key)) {
          body[key] = val + suffix;
          fixed = true;
        }
        if (Array.isArray(val)) {
          for (const item of val) {
            if (item && typeof item === 'object') {
              for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
                if (typeof v === 'string' && /name/i.test(k)) {
                  (item as Record<string, unknown>)[k] = v + suffix;
                  fixed = true;
                }
              }
            }
          }
        }
      }
      if (fixed) return { fixApplied: `Appended unique suffix to name fields for DUPLICATE_DATA` };
    }
  }

  return null;
}

// === Phase 5: Pre-Execution Validation ===

/**
 * Pre-validate resolved args against the schema BEFORE calling the tool.
 * Proactively fills any missing required fields at ALL nesting levels.
 * This is defense-in-depth — catches gaps that enhanceWithSchemaArgs and deepEnhanceContainers missed.
 */
function preValidateArgs(
  resolved: Record<string, unknown>,
  inputSchema: Record<string, unknown>,
  step: WorkflowStepDef,
  planningNotes: string[],
): void {
  const runtimeFields = new Set(step.inputMappings.map((m) => m.paramPath));

  walkAndFillGaps(resolved, inputSchema, '', runtimeFields, planningNotes);
}

/**
 * Recursively walk the schema and resolved args, filling any gaps at any nesting level.
 */
function walkAndFillGaps(
  obj: Record<string, unknown>,
  schema: Record<string, unknown>,
  basePath: string,
  runtimeFields: Set<string>,
  planningNotes: string[],
): void {
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = (schema.required ?? []) as string[];

  // Skip path_variables entirely — URL route segments must only come from
  // workflow hints (module) or inputMappings (IDs)
  const SKIP_CONTAINERS = new Set(['path_variables', 'path_params']);

  for (const key of required) {
    if (key === 'headers') continue;
    if (SKIP_CONTAINERS.has(key) || SKIP_CONTAINERS.has(basePath)) continue;

    // Whitelist for query_params sub-fields — only fill known-safe params
    if (basePath === 'query_params' && !SAFE_QUERY_PARAMS.test(key)) continue;

    const fullPath = basePath ? `${basePath}.${key}` : key;

    // Skip runtime-filled fields
    if (runtimeFields.has(fullPath)) continue;

    // Skip ID-like and audit fields
    if (ID_LIKE_FIELD.test(key) || AUDIT_FIELD.test(key)) continue;

    const propSchema = properties[key];
    if (!propSchema) continue;

    const currentValue = obj[key];

    if (currentValue === undefined) {
      // Missing — fill it
      const value = fillRequiredFields(propSchema, { skipIdFields: true }, fullPath);
      if (value !== undefined) {
        obj[key] = value;
        planningNotes.push(`Pre-validated gap: ${fullPath}`);
      }
    } else if (
      currentValue !== null &&
      typeof currentValue === 'object' &&
      !Array.isArray(currentValue) &&
      propSchema.properties
    ) {
      // Existing object — recurse into it
      walkAndFillGaps(currentValue as Record<string, unknown>, propSchema, fullPath, runtimeFields, planningNotes);
    }
  }
}
