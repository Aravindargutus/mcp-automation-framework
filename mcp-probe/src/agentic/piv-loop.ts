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
  /** Primary arg generation: LLM reads tool description + schema + context to produce full args. */
  planArgs(
    toolName: string,
    toolDescription: string,
    schema: Record<string, unknown>,
    operation: string,
    entity: string,
    stepDescription: string,
    availableOutputs: Record<string, unknown>,
    existingArgs: Record<string, unknown>,
  ): Promise<{ plannedArgs: Record<string, unknown>; confidence: number; reasoning: string }>;
  /** Legacy: fill missing required fields only. Kept for interface compat. */
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
  // Grant enough retries for chained deterministic fixes (APIs return errors one field at a time).
  // 5 retries gives room for: nested ID injection, multiple missing fields, duplicate collisions.
  const maxRetries = config.maxRetries ?? 5;
  const baseDelay = config.baseDelayMs ?? 1000;
  const pivPhases: PIVPhase[] = [];
  const planningNotes: string[] = [];
  let attempts = 0;
  let lastResult: ValidationResult | undefined;
  let lastResolvedArgs: Record<string, unknown> | undefined;
  // Track which specific error+field combos were already fixed to avoid infinite loops,
  // but still allow deterministic fixes for DIFFERENT missing fields across retries.
  // APIs often return one error at a time (e.g., first "first_name missing", then "email missing").
  const deterministicFixesApplied = new Set<string>();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    attempts = attempt + 1;

    // === PLAN ===
    const planStart = Date.now();
    const plan = await planStep(step, outputStore, tool, planningNotes, llm);
    pivPhases.push({ phase: 'plan', durationMs: Date.now() - planStart });

    if (!plan.isReady) {
      return buildSkippedResult(step, plan, pivPhases, attempts);
    }

    // Capture the resolved args for debug output (before tool call mutates anything)
    lastResolvedArgs = plan.resolvedArgs;

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

    // --- ERROR RECOVERY: deterministic first, then LLM ---

    // Deterministic error recovery — applies targeted fixes for validation errors.
    // Uses a set to track which specific error+field combos were already fixed,
    // allowing fixes for DIFFERENT fields across retries (APIs return one error at a time).
    // Fixes are persisted into step.argsTemplate so they survive planStep() re-resolution on retry.
    // Deterministic error recovery applies to validation_error AND not_found categories.
    // validation_error: missing fields, duplicate data, invalid patterns — fixable by changing args.
    // not_found: wrong ID references — fixable by trying alternative IDs from the output store.
    const isRecoverableCategory = lastResult.errorCategory === 'validation_error' || lastResult.errorCategory === 'not_found';
    if (!lastResult.isRetriable && isRecoverableCategory && tool?.inputSchema) {
      // Build a dedup key from the error code + field to avoid re-fixing the same issue.
      // DUPLICATE_DATA is special: each retry uses a new unique value, so always allow re-attempts.
      const errorKey = buildErrorDeduplicationKey(lastResult.errorMessage ?? '');
      const isDuplicate = errorKey.startsWith('DUPLICATE_DATA:');
      if (isDuplicate || !deterministicFixesApplied.has(errorKey)) {
        deterministicFixesApplied.add(errorKey);
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
    }

    // LLM error diagnosis — fires when:
    // 1. Deterministic fix wasn't applicable (returned null)
    // 2. OR deterministic fix was already tried on a previous attempt but the error persists
    // This ensures LLM gets a chance to apply smarter, context-aware fixes.
    if (llm && !lastResult.isRetriable && isRecoverableCategory && tool?.inputSchema) {
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

  return buildFinalResult(step, lastResult!, pivPhases, attempts, planningNotes, lastResolvedArgs);
}

// === Plan Phase ===

/**
 * Additive-only merge of LLM-generated args into resolved args.
 * NEVER overwrites existing values — inputMappings take priority.
 * NEVER merges path_variables or query_params — those are URL routing
 * segments that need real data from inputMappings/workflow, not LLM guesses.
 * For nested objects, recursively merges without overwriting.
 * Arrays are NOT merged — update operations use minimal payloads (empty {} or {id})
 * and adding LLM fields to array items causes regressions (duplicate labels, fake IDs).
 * Allows override of known placeholder values (e.g., "test-value") that never succeed.
 */
const LLM_MERGE_BLOCKED_KEYS = new Set(['path_variables', 'query_params', 'headers']);
const PLACEHOLDER_VALUES = new Set(['test-value', 'test-id-placeholder', 'placeholder']);

function mergeLLMArgs(
  target: Record<string, unknown>,
  llmArgs: Record<string, unknown>,
): void {
  for (const [key, llmValue] of Object.entries(llmArgs)) {
    // Never let the LLM fill URL routing params — they need real IDs/values
    if (LLM_MERGE_BLOCKED_KEYS.has(key)) continue;

    const existing = target[key];

    if (existing === undefined || existing === null || isPlaceholder(existing)) {
      // No existing value or placeholder — use LLM's value (deep clone to avoid shared refs)
      target[key] = JSON.parse(JSON.stringify(llmValue));
    } else if (
      typeof existing === 'object' && !Array.isArray(existing) &&
      typeof llmValue === 'object' && !Array.isArray(llmValue) &&
      llmValue !== null
    ) {
      // Both are objects — recurse but NEVER overwrite existing leaves
      mergeLLMArgs(existing as Record<string, unknown>, llmValue as Record<string, unknown>);
    }
    // else: existing non-placeholder scalar or array — keep it (inputMapping wins).
    // Arrays are intentionally NOT merged: update operations rely on minimal payloads
    // (e.g., layouts: [{}], fields: [{id}]) and injecting LLM fields causes failures
    // (duplicate labels, invalid nested IDs). LLM arrays are only used when the key
    // is entirely missing from the target.
  }
}

function isPlaceholder(value: unknown): boolean {
  return typeof value === 'string' && PLACEHOLDER_VALUES.has(value);
}

/**
 * Deep-clone args with placeholder values removed.
 * Used to build the "existingArgs" view for the LLM so it generates
 * real values for fields that currently hold useless placeholders.
 */
function stripPlaceholders(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isPlaceholder(value)) continue; // Drop placeholder scalars
    if (Array.isArray(value)) {
      // Recurse into array items
      result[key] = value.map((item) =>
        typeof item === 'object' && item !== null && !Array.isArray(item)
          ? stripPlaceholders(item as Record<string, unknown>)
          : isPlaceholder(item) ? undefined : item,
      ).filter((v) => v !== undefined);
    } else if (typeof value === 'object' && value !== null) {
      result[key] = stripPlaceholders(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

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

  // --- LLM-first arg generation (when available) ---
  // LLM reads tool description + schema + outputStore to generate semantically correct args.
  // This runs BEFORE schema filling so the LLM is the primary arg generator.
  if (llm && tool?.inputSchema) {
    try {
      const entityMatch = step.description.match(/(\w+)\s*record/i);
      const entity = entityMatch?.[1] ?? step.description.split(/\s+/).pop() ?? 'unknown';
      const availableOutputs = Object.fromEntries(outputStore.entries());

      // Strip placeholder values from existingArgs so the LLM sees them as "missing"
      // and generates proper replacements. mergeLLMArgs will then override the placeholders.
      const cleanedForLLM = stripPlaceholders(resolved);

      const llmResult = await llm.planArgs(
        step.toolName,
        tool.description ?? '',
        tool.inputSchema,
        step.operation,
        entity,
        step.description,
        availableOutputs,
        cleanedForLLM,
      );

      if (llmResult.confidence >= 0.3) {
        mergeLLMArgs(resolved, llmResult.plannedArgs);
        planningNotes.push(`LLM-planned args (confidence: ${llmResult.confidence.toFixed(2)}): ${llmResult.reasoning}`);
      } else {
        planningNotes.push(`LLM args skipped (low confidence: ${llmResult.confidence.toFixed(2)})`);
      }
    } catch (err) {
      planningNotes.push(`LLM planning failed, falling back to schema-only: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // --- Schema-aware gap-filling (runs after LLM to catch anything missed) ---
  if (tool?.inputSchema) {
    enhanceWithSchemaArgs(resolved, tool.inputSchema, step, planningNotes);
    deepEnhanceContainers(resolved, tool.inputSchema, step, planningNotes);
    // Inject real IDs into nested reference arrays (profiles[0].id, roles[0].id, etc.)
    injectIdsIntoNestedRefArrays(resolved, tool.inputSchema, outputStore, planningNotes);
    preValidateArgs(resolved, tool.inputSchema, step, planningNotes);
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
      }
      // If no ID found: the create succeeded but the response doesn't contain an
      // extractable ID. This happens with some APIs (e.g., Create_Profile, createTerritories).
      // Mark as passed — downstream steps that need the ID will be naturally skipped
      // due to unresolved inputMappings, which is better than failing the create step.
    }
  }

  // For successful non-create steps, scan the response for entity IDs.
  // This captures IDs from "other" steps like Add_Tags, so downstream tools
  // (Get_Record_Count_For_Tag, Update_Tag) get the fresh ID instead of a stale one.
  if (step.operation !== 'create') {
    const dynamicId = scanResponseForId(unwrapped);
    if (dynamicId !== undefined && dynamicId !== null) {
      // Extract entity family from entityHint (preferred) or tool name (fallback)
      const hint = step.entityHint ?? step.toolName.replace(/^[A-Za-z]+_/, ''); // strip prefix like "ZohoCRM_"
      const family = extractResourceFamily(hint);
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

  // Try direct `id` or `id_string` on the response itself
  if (obj.id !== undefined && obj.id !== null) return obj.id;
  if (obj.id_string !== undefined && obj.id_string !== null) return obj.id_string;

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
      if (item.id_string !== undefined && item.id_string !== null) return item.id_string;
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
  { pattern: /\b(400|bad.?request|invalid|validation|required.?field|missing.?param|INVALID_DATA|MANDATORY_NOT_FOUND|REQUIRED_PARAM_MISSING|DUPLICATE_DATA|PATTERN_NOT_MATCHED)\b/i, category: 'validation_error' },
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

/**
 * Build a deduplication key from a structured error message.
 * Uses error code + field name so the same fix isn't applied twice,
 * but different fields (e.g., first_name then email) get separate fixes.
 */
function buildErrorDeduplicationKey(errorMessage: string): string {
  const parsed = parseStructuredError(errorMessage);
  if (parsed?.code && (parsed.apiName || parsed.paramName)) {
    return `${parsed.code}:${parsed.apiName ?? parsed.paramName}`;
  }
  // Fallback: use first 100 chars of the error message
  return errorMessage.substring(0, 100);
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
  resolvedArgs?: Record<string, unknown>,
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

  // Map unfixable errors to 'skipped' — permission/edition limits are not framework bugs
  const status = validation.passed
    ? 'passed'
    : (finalCategory === 'not_supported' || finalCategory === 'auth_error')
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
      inputArgs: truncateForTransport(resolvedArgs),
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
 * Deep merge source into target. Source values override target values.
 * For nested objects, merges recursively. For arrays and primitives, replaces.
 * When source has a nested object but target doesn't, deep-clones to avoid shared references.
 */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = target[key];

    if (
      srcVal !== null && typeof srcVal === 'object' && !Array.isArray(srcVal) &&
      tgtVal !== null && typeof tgtVal === 'object' && !Array.isArray(tgtVal)
    ) {
      // Both are objects — recurse
      deepMerge(tgtVal as Record<string, unknown>, srcVal as Record<string, unknown>);
    } else if (
      srcVal !== null && typeof srcVal === 'object' && !Array.isArray(srcVal) &&
      (tgtVal === undefined || tgtVal === null)
    ) {
      // Source is an object but target has nothing — deep-clone to avoid shared reference.
      // Without this, mutations to the merged object would affect both source and target.
      target[key] = JSON.parse(JSON.stringify(srcVal));
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
const SAFE_QUERY_PARAMS = /^(fields|word|criteria|per_page|page|sort_by|sort_order|type|converted|include_child|approval_state|query|select_query)$/i;

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

    // If the array is missing (undefined) or empty [], create one item from schema.
    // This handles cases like body.modules, body.territories, body.users where the
    // workflow generator didn't populate the array but the API requires it.
    // Pass skipIdFields: true so synthetic IDs aren't injected into array items —
    // real IDs come from producers/inputMappings or deterministic error recovery.
    if (arr === undefined || (Array.isArray(arr) && arr.length === 0)) {
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

// === Phase 2: Smart Nested ID Injection ===

/**
 * Walk ALL body arrays recursively and inject real IDs from the output store
 * into nested reference arrays (profiles, roles, territories, layouts, etc.).
 *
 * These nested arrays are "reference objects" — they contain just an `id` that
 * points to an existing entity. The schema-aware builder skips ID fields (skipIdFields),
 * so they end up as empty objects `{}`. This function fixes that by:
 *
 * 1. Walking every array in the body (data, modules, tags, etc.)
 * 2. For each item, checking for nested arrays whose items need `id`
 * 3. Using the array key as the resource family hint (e.g., "profiles" → fetched_profile_id)
 * 4. Injecting real IDs from the output store
 *
 * This runs BEFORE the tool call, making the implementation agent smarter.
 */
function injectIdsIntoNestedRefArrays(
  resolved: Record<string, unknown>,
  inputSchema: Record<string, unknown>,
  outputStore: Map<string, unknown>,
  planningNotes: string[],
): void {
  const body = resolved.body as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object') return;

  const topProps = (inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const bodySchema = topProps.body;
  if (!bodySchema) return;

  const bodyProps = (bodySchema.properties ?? {}) as Record<string, Record<string, unknown>>;

  // Walk each top-level body array (data, modules, tags, etc.)
  for (const [arrayKey, arrayVal] of Object.entries(body)) {
    if (!Array.isArray(arrayVal)) continue;

    const arraySchema = bodyProps[arrayKey];
    if (!arraySchema || arraySchema.type !== 'array') continue;

    const itemsSchema = arraySchema.items as Record<string, unknown> | undefined;
    if (!itemsSchema?.properties) continue;

    const itemProps = (itemsSchema.properties ?? {}) as Record<string, Record<string, unknown>>;

    // Walk each item in the array
    for (const item of arrayVal) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const record = item as Record<string, unknown>;

      // Check each property of the item for nested arrays
      for (const [propKey, propVal] of Object.entries(record)) {
        const propSchema = itemProps[propKey];
        if (!propSchema || propSchema.type !== 'array') continue;

        const nestedItemsSchema = propSchema.items as Record<string, unknown> | undefined;
        if (!nestedItemsSchema) continue;

        // Check if this nested array's items need an `id` field
        const nestedRequired = (nestedItemsSchema.required ?? []) as string[];
        const needsId = nestedRequired.includes('id');
        if (!needsId) continue;

        // This is a reference array (like profiles, roles, territories)
        // Walk items and inject IDs
        if (Array.isArray(propVal)) {
          for (const nestedItem of propVal) {
            if (!nestedItem || typeof nestedItem !== 'object' || Array.isArray(nestedItem)) continue;
            const nestedRecord = nestedItem as Record<string, unknown>;
            if (nestedRecord.id !== undefined && nestedRecord.id !== null) continue; // Already has ID

            // Use the array key as resource family hint (e.g., "profiles" → "profile")
            const family = singularize(propKey.toLowerCase());
            const realId = findBestIdFromStore(outputStore, family);
            if (realId !== undefined && realId !== null) {
              nestedRecord.id = realId;
              planningNotes.push(`Injected ${family} ID into body.${arrayKey}[].${propKey}[].id = ${JSON.stringify(realId)}`);
            }
          }
        } else if (propVal === undefined || (Array.isArray(propVal) && propVal.length === 0)) {
          // Array is empty or missing — create an item with the ID
          const family = singularize(propKey.toLowerCase());
          const realId = findBestIdFromStore(outputStore, family);
          if (realId !== undefined && realId !== null) {
            record[propKey] = [{ id: realId }];
            planningNotes.push(`Created body.${arrayKey}[].${propKey} with ${family} ID = ${JSON.stringify(realId)}`);
          }
        }
      }
    }
  }

  // Also handle top-level body arrays that are themselves reference arrays
  // (e.g., body.profiles = [{}], body.layouts = [{}])
  for (const [key, val] of Object.entries(body)) {
    if (!Array.isArray(val)) continue;

    const arraySchema = bodyProps[key];
    if (!arraySchema || arraySchema.type !== 'array') continue;

    const itemsSchema = arraySchema.items as Record<string, unknown> | undefined;
    if (!itemsSchema) continue;

    const nestedRequired = (itemsSchema.required ?? []) as string[];
    const needsId = nestedRequired.includes('id');
    if (!needsId) continue;

    for (const item of val) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const record = item as Record<string, unknown>;
      if (record.id !== undefined && record.id !== null) continue;

      const family = singularize(key.toLowerCase());
      const realId = findBestIdFromStore(outputStore, family);
      if (realId !== undefined && realId !== null) {
        record.id = realId;
        planningNotes.push(`Injected ${family} ID into body.${key}[].id = ${JSON.stringify(realId)}`);
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
 * Navigate a json_path (e.g., "$.modules[0].profiles[0].id") into a body object.
 * Returns the target object (the one that should receive the missing field) and
 * the nearest array key (used as resource family hint for ID injection).
 *
 * Handles arbitrary nesting depth: $.a[0].b[0].c[0].fieldName
 */
function navigateJsonPath(
  body: Record<string, unknown>,
  jsonPath: string,
): { obj: Record<string, unknown>; nearestArrayKey: string } | null {
  // Parse json_path: $.segments... → strip "$." prefix, then parse segments
  const path = jsonPath.startsWith('$.') ? jsonPath.slice(2) : jsonPath;
  // Split into tokens: "modules[0].profiles[0].id" → ["modules", "[0]", "profiles", "[0]", "id"]
  const tokens: string[] = [];
  for (const segment of path.split('.')) {
    const arrMatch = segment.match(/^(\w+)\[(\d+)\]$/);
    if (arrMatch) {
      tokens.push(arrMatch[1]); // array key
      tokens.push(`[${arrMatch[2]}]`); // array index
    } else {
      tokens.push(segment);
    }
  }

  // The last token is the field name (the missing field) — we want the parent object.
  // Navigate to the second-to-last level.
  if (tokens.length < 2) return null;

  let current: unknown = body;
  let nearestArrayKey = tokens[0]; // Start with the top-level array key

  // Navigate all tokens EXCEPT the last one (which is the field name to inject)
  for (let i = 0; i < tokens.length - 1; i++) {
    if (current === null || current === undefined) return null;
    const token = tokens[i];

    if (token.startsWith('[')) {
      // Array index
      if (!Array.isArray(current)) return null;
      const index = parseInt(token.slice(1, -1), 10);
      if (index >= current.length) return null;
      current = current[index];
    } else {
      // Object key
      if (typeof current !== 'object' || Array.isArray(current)) return null;
      current = (current as Record<string, unknown>)[token];
      // Track nearest array key for resource family hint
      if (Array.isArray(current)) {
        nearestArrayKey = token;
      } else if (i + 1 < tokens.length - 1 && tokens[i + 1].startsWith('[')) {
        nearestArrayKey = token; // Next token is an index, so this is an array key
      }
    }
  }

  if (!current || typeof current !== 'object' || Array.isArray(current)) return null;
  return { obj: current as Record<string, unknown>, nearestArrayKey };
}

/**
 * Try to fix an error deterministically by parsing the structured error response
 * and applying a targeted fix. Runs BEFORE LLM diagnosis — fast, free, no API cost.
 *
 * Handles: REQUIRED_PARAM_MISSING, MANDATORY_NOT_FOUND, INVALID_DATA,
 *          DUPLICATE_DATA, PATTERN_NOT_MATCHED, ALREADY_ACTIVATED,
 *          and generic not_found (wrong ID references).
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

  // Structured error fixes (require a parsed error code)
  if (error?.code) {

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

  // Fix 2: MANDATORY_NOT_FOUND — add missing field identified by json_path.
  // Handles both shallow paths ($.fields[0].id) and deeply nested paths
  // ($.modules[0].profiles[0].id) by traversing the full json_path into the body.
  // When the missing field is 'id', injects a resource-specific ID from the output store.
  if (error.code === 'MANDATORY_NOT_FOUND' && error.apiName) {
    const body = resolvedArgs.body as Record<string, unknown> | undefined;
    if (body && error.jsonPath) {
      // Navigate the full json_path to find the target object.
      // json_path format: $.arrayKey[idx].nestedArray[idx]...fieldName
      const targetObj = navigateJsonPath(body, error.jsonPath);
      if (targetObj) {
        const fieldName = error.apiName;
        const lower = fieldName.toLowerCase();

        if (targetObj.obj[fieldName] !== undefined) {
          // Field already exists — nothing to fix
        } else if (lower === 'id' && outputStore) {
          // For 'id' fields, determine the resource family from the nearest array key
          // in the json_path (e.g., "profiles[0].id" → family = "profile").
          const family = singularize(targetObj.nearestArrayKey.toLowerCase());
          const realId = findBestIdFromStore(outputStore, family);
          if (realId !== undefined) {
            targetObj.obj[fieldName] = realId;
            return { fixApplied: `Injected ${family} ID into body path ${error.jsonPath} = ${JSON.stringify(realId)}` };
          }
          return null; // No real ID — don't inject bogus values
        } else if (ID_LIKE_FIELD.test(fieldName)) {
          return null; // Other ID-like fields need real IDs
        } else {
          // Heuristic value based on field name (non-ID fields only)
          let value: unknown = 'MCPProbeTest';
          if (lower.includes('date') || lower.includes('time')) {
            value = new Date().toISOString();
          } else if (lower.includes('email')) {
            value = 'test@mcpprobe.dev';
          } else if (lower.includes('phone')) {
            value = '+1-555-0100';
          } else if (lower.includes('name') || lower.includes('label')) {
            value = `MCPProbeTest_${Date.now().toString(36).slice(-5)}`;
          }
          targetObj.obj[fieldName] = value;
          return { fixApplied: `Filled mandatory field at ${error.jsonPath} = ${JSON.stringify(value)}` };
        }
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

  // Fix 4: DUPLICATE_DATA — read the error to find the EXACT duplicate field and change it.
  // The API response includes details.api_name (field name) and details.json_path (exact location).
  // We use these to target ONLY the specific field, not blindly rename everything.
  if (error.code === 'DUPLICATE_DATA') {
    const body = resolvedArgs.body as Record<string, unknown> | undefined;
    if (body) {
      // Use a strong unique suffix: timestamp + random chars to avoid re-collision
      const suffix = `_${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(-3)}`;

      // Strategy 1: Use json_path to target the exact field (smart)
      if (error.jsonPath && error.apiName) {
        const jpMatch = error.jsonPath.match(/^\$\.(\w+)\[(\d+)\]\.(\w+)$/);
        if (jpMatch) {
          const arrayKey = jpMatch[1];
          const itemIndex = parseInt(jpMatch[2], 10);
          const fieldName = jpMatch[3];
          const arr = body[arrayKey];
          if (Array.isArray(arr) && arr.length > itemIndex) {
            const item = arr[itemIndex] as Record<string, unknown>;
            if (item && typeof item === 'object') {
              const currentVal = item[fieldName];
              if (typeof currentVal === 'string') {
                item[fieldName] = currentVal + suffix;
              } else {
                item[fieldName] = `MCPProbeTest${suffix}`;
              }
              return { fixApplied: `Changed duplicate field ${arrayKey}[${itemIndex}].${fieldName} with unique suffix (read from error json_path)` };
            }
          }
        }
      }

      // Strategy 2: Use api_name without json_path — find the field in any body array (partially smart)
      if (error.apiName) {
        const targetField = error.apiName;
        for (const [key, val] of Object.entries(body)) {
          // Check top-level body fields
          if (key === targetField && typeof val === 'string') {
            body[key] = val + suffix;
            return { fixApplied: `Changed duplicate field body.${key} with unique suffix (read from error api_name)` };
          }
          // Check inside body arrays
          if (Array.isArray(val)) {
            for (const item of val) {
              if (item && typeof item === 'object') {
                const obj = item as Record<string, unknown>;
                if (obj[targetField] !== undefined) {
                  if (typeof obj[targetField] === 'string') {
                    obj[targetField] = (obj[targetField] as string) + suffix;
                  } else {
                    obj[targetField] = `MCPProbeTest${suffix}`;
                  }
                  return { fixApplied: `Changed duplicate field ${key}[].${targetField} with unique suffix (read from error api_name)` };
                }
              }
            }
          }
        }
      }

      // Strategy 3: Fallback — no specific field info, change all name-like fields (blind, last resort)
      let fixed = false;
      for (const [key, val] of Object.entries(body)) {
        if (typeof val === 'string' && /name|label|title/i.test(key)) {
          body[key] = val + suffix;
          fixed = true;
        }
        if (Array.isArray(val)) {
          for (const item of val) {
            if (item && typeof item === 'object') {
              for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
                if (typeof v === 'string' && /name|label|title/i.test(k)) {
                  (item as Record<string, unknown>)[k] = v + suffix;
                  fixed = true;
                }
              }
            }
          }
        }
      }
      if (fixed) return { fixApplied: `Changed name/label/title fields with unique suffix for DUPLICATE_DATA (blind fallback)` };
    }
  }

  // Fix 5: ALREADY_ACTIVATED / ALREADY_USED — skip on retry, this is an environment state issue
  if (error.code === 'ALREADY_ACTIVATED' || /already.?activated|already.?used|already.?exists/i.test(error.code ?? '')) {
    return null; // Cannot fix by changing args — the entity is already in that state
  }

  // Fix 6: PATTERN_NOT_MATCHED — the value doesn't match the API's expected format.
  // Read the error details to identify which field failed and what pattern it expects.
  if (error.code === 'PATTERN_NOT_MATCHED' && error.apiName) {
    const body = resolvedArgs.body as Record<string, unknown> | undefined;
    if (body && error.jsonPath) {
      const jpMatch = error.jsonPath.match(/^\$\.(\w+)\[(\d+)\]\.(\w+)$/);
      if (jpMatch) {
        const arrayKey = jpMatch[1];
        const itemIndex = parseInt(jpMatch[2], 10);
        const fieldName = jpMatch[3];
        const arr = body[arrayKey];
        if (Array.isArray(arr) && arr.length > itemIndex) {
          const item = arr[itemIndex] as Record<string, unknown>;
          if (item && typeof item === 'object') {
            // Try to get the correct format from schema
            const topProps = (inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
            const bodySchema = topProps.body;
            const bodyProps = (bodySchema?.properties ?? {}) as Record<string, Record<string, unknown>>;
            const arraySchema = bodyProps[arrayKey];
            const itemsSchema = ((arraySchema as Record<string, unknown>)?.items ?? {}) as Record<string, Record<string, unknown>>;
            const itemProps = (itemsSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
            const fieldDef = itemProps[fieldName];
            if (fieldDef) {
              const correctedValue = fillRequiredFields(fieldDef, { skipIdFields: true }, `body.${arrayKey}[].${fieldName}`);
              if (correctedValue !== undefined) {
                item[fieldName] = correctedValue;
                return { fixApplied: `Regenerated body.${arrayKey}[${itemIndex}].${fieldName} from schema for PATTERN_NOT_MATCHED` };
              }
            }
          }
        }
      }
    }
  }

  } // end of if (error?.code) — structured error fixes

  // Fix 7: NOT_FOUND / generic error with record ID — the referenced record doesn't exist.
  // This works for both structured and unstructured errors.
  // Scans path_variables and query_params for synthetic IDs and replaces with real ones.
  if (/not.?found|does.?not.?exist|no.?data|INVALID_URL_PATTERN/i.test(errorMessage)) {
    if (outputStore && outputStore.size > 0) {
      // Check path_variables for synthetic IDs and replace with real ones
      const pathVars = resolvedArgs.path_variables as Record<string, unknown> | undefined;
      if (pathVars) {
        for (const [key, val] of Object.entries(pathVars)) {
          if (typeof val === 'string' && ID_LIKE_FIELD.test(key)) {
            // This ID field has a value — check if it's a synthetic/bogus value
            const isSynthetic = val === 'MCPProbeTest' || val === 'test-id-placeholder' || val.startsWith('MCPProbeTest');
            if (isSynthetic) {
              // Try to find a real ID from the output store
              const family = key.replace(/^(id|record_id)$/i, 'record').replace(/_id$/i, '');
              const realId = findBestIdFromStore(outputStore, family);
              if (realId !== undefined && realId !== val) {
                pathVars[key] = realId;
                return { fixApplied: `Replaced synthetic path_variables.${key}="${val}" with real ID "${realId}" from output store` };
              }
            }
          }
        }
      }

      // Check query_params for synthetic IDs
      const queryParams = resolvedArgs.query_params as Record<string, unknown> | undefined;
      if (queryParams) {
        for (const [key, val] of Object.entries(queryParams)) {
          if (typeof val === 'string' && ID_LIKE_FIELD.test(key)) {
            const isSynthetic = val === 'MCPProbeTest' || val === 'test-id-placeholder' || val.startsWith('MCPProbeTest');
            if (isSynthetic) {
              const family = key.replace(/^(id|record_id)$/i, 'record').replace(/_id$/i, '');
              const realId = findBestIdFromStore(outputStore, family);
              if (realId !== undefined && realId !== val) {
                queryParams[key] = realId;
                return { fixApplied: `Replaced synthetic query_params.${key}="${val}" with real ID "${realId}" from output store` };
              }
            }
          }
        }
      }
    }
  }

  return null;
}

/**
 * Find the best matching ID from the output store for a given resource family.
 * Tries exact match first (fetched_{family}_id), then scans for suffix matches,
 * then falls back to createdRecordId.
 */
function findBestIdFromStore(outputStore: Map<string, unknown>, family: string): unknown {
  // Exact match
  const exactKey = `fetched_${family}_id`;
  const exactVal = outputStore.get(exactKey);
  if (exactVal !== undefined && exactVal !== null) return exactVal;

  // Suffix scan
  for (const [k, v] of outputStore.entries()) {
    if (k.endsWith(`_${family}_id`) && v !== undefined && v !== null) {
      return v;
    }
  }

  // Fallback to the primary record ID
  const recordId = outputStore.get('createdRecordId');
  if (recordId !== undefined && recordId !== null) return recordId;

  return undefined;
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
