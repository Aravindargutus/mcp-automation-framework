/**
 * Workflow Executor — runs workflow steps sequentially with output piping.
 *
 * For each step:
 *   1. Resolve args from output store via input mappings
 *   2. Call tool
 *   3. Unwrap MCP response
 *   4. Extract outputs to store
 *   5. Assert success
 *
 * Always runs cleanup steps in a finally block, even if earlier steps fail.
 */
import type { AssertHelper, TestRunContext } from '../types.js';
import type {
  WorkflowDefinition,
  WorkflowStepDef,
  WorkflowStepTrace,
  WorkflowExecutionTrace,
} from './types.js';
import {
  unwrapMCPResponse,
  getNestedField,
  resolveStepArgs,
  deepClone,
} from './output-resolver.js';

/** Delay between steps to avoid rate limiting (ms) */
const STEP_DELAY_MS = 500;

/**
 * Execute a complete workflow with output piping and guaranteed cleanup.
 */
export async function executeWorkflow(
  workflow: WorkflowDefinition,
  ctx: TestRunContext,
  assert: AssertHelper,
): Promise<WorkflowExecutionTrace> {
  const outputStore = new Map<string, unknown>();
  const stepTraces: WorkflowStepTrace[] = [];
  const cleanupTraces: WorkflowStepTrace[] = [];
  const startTime = Date.now();

  // Report workflow structure
  assert.info(
    `Workflow: ${workflow.name}`,
    `${workflow.steps.length} steps: ${workflow.steps.map((s) => s.operation).join(' → ')}`,
  );

  try {
    // Execute main workflow steps
    for (let i = 0; i < workflow.steps.length; i++) {
      const step = workflow.steps[i];
      const trace = await executeStep(step, ctx, assert, outputStore, i);
      stepTraces.push(trace);

      // If a critical step fails (create), stop the workflow
      if (trace.isError && step.operation === 'create') {
        assert.ok(false, `Workflow aborted: ${step.toolName} failed`, 'Cannot continue without created record');
        // Skip remaining steps
        for (let j = i + 1; j < workflow.steps.length; j++) {
          stepTraces.push(buildSkippedTrace(workflow.steps[j], 'Previous create step failed'));
        }
        break;
      }

      // Small delay between steps to avoid rate limiting
      if (i < workflow.steps.length - 1) {
        await sleep(STEP_DELAY_MS);
      }
    }
  } finally {
    // Always run cleanup steps
    for (const cleanupStep of workflow.cleanupSteps) {
      const trace = await executeCleanupStep(cleanupStep, ctx, outputStore);
      cleanupTraces.push(trace);
    }
  }

  return {
    workflow,
    steps: stepTraces,
    cleanupSteps: cleanupTraces,
    totalDurationMs: Date.now() - startTime,
    outputStore: Object.fromEntries(outputStore),
  };
}

/**
 * Execute a single workflow step.
 */
async function executeStep(
  step: WorkflowStepDef,
  ctx: TestRunContext,
  assert: AssertHelper,
  outputStore: Map<string, unknown>,
  displayIndex: number,
): Promise<WorkflowStepTrace> {
  const stepLabel = `Step ${displayIndex + 1}/${step.operation}: ${step.toolName}`;

  // Resolve args from output store
  const { resolved, unresolved } = resolveStepArgs(
    step.argsTemplate,
    step.inputMappings,
    outputStore,
  );

  // If critical inputs are unresolved, skip this step
  if (unresolved.length > 0) {
    const reason = `Unresolved inputs: ${unresolved.join(', ')}`;
    assert.warn(false, `${stepLabel} — skipped`, reason);
    return buildSkippedTrace(step, reason, resolved);
  }

  // Call the tool
  let trace;
  try {
    trace = await ctx.client.callTool(step.toolName, resolved);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    assert.ok(false, `${stepLabel} — call failed`, message);
    return {
      stepDef: step,
      resolvedArgs: resolved,
      response: { error: message },
      unwrappedResponse: null,
      isError: true,
      durationMs: 0,
      skipped: false,
      extractedOutputs: {},
    };
  }

  // Unwrap MCP response
  const unwrapped = unwrapMCPResponse(trace.response);

  // Extract outputs
  const extractedOutputs: Record<string, unknown> = {};
  for (const mapping of step.outputMappings) {
    // Skip if we already have this output (from a previous path that worked)
    if (outputStore.has(mapping.name)) continue;

    const value = getNestedField(unwrapped, mapping.path);
    if (value !== undefined && value !== null) {
      outputStore.set(mapping.name, value);
      extractedOutputs[mapping.name] = value;
    }
  }

  // Assertions
  if (trace.isError) {
    assert.ok(false, `${stepLabel} — failed`, summarizeResponse(unwrapped));
  } else {
    assert.ok(true, `${stepLabel} — succeeded`, `${trace.durationMs}ms`);

    // For create steps, verify we extracted an ID
    if (step.operation === 'create') {
      const hasId = outputStore.has('createdRecordId');
      assert.ok(hasId, `${stepLabel} — extracted record ID`, hasId
        ? `ID: ${String(outputStore.get('createdRecordId'))}`
        : 'Could not extract ID from response — subsequent steps may fail');
    }

    // For read steps, verify we got data
    if (step.operation === 'read') {
      const hasData = outputStore.has('readData');
      assert.ok(hasData, `${stepLabel} — retrieved record data`);
    }
  }

  return {
    stepDef: step,
    resolvedArgs: resolved,
    response: trace.response,
    unwrappedResponse: unwrapped,
    isError: trace.isError,
    durationMs: trace.durationMs,
    skipped: false,
    extractedOutputs,
  };
}

/**
 * Execute a cleanup step — never fails the test, only logs warnings.
 */
async function executeCleanupStep(
  step: WorkflowStepDef,
  ctx: TestRunContext,
  outputStore: Map<string, unknown>,
): Promise<WorkflowStepTrace> {
  // Resolve args from output store
  const { resolved, unresolved } = resolveStepArgs(
    step.argsTemplate,
    step.inputMappings,
    outputStore,
  );

  // If we don't have the ID to delete, skip cleanup
  if (unresolved.length > 0) {
    return buildSkippedTrace(step, `Cleanup skipped: no record ID to delete`, resolved);
  }

  try {
    const trace = await ctx.client.callTool(step.toolName, resolved);
    const unwrapped = unwrapMCPResponse(trace.response);

    return {
      stepDef: step,
      resolvedArgs: resolved,
      response: trace.response,
      unwrappedResponse: unwrapped,
      isError: trace.isError,
      durationMs: trace.durationMs,
      skipped: false,
      extractedOutputs: {},
    };
  } catch {
    // Cleanup failures are non-fatal — log and continue
    return {
      stepDef: step,
      resolvedArgs: resolved,
      response: { error: 'Cleanup call failed' },
      unwrappedResponse: null,
      isError: true,
      durationMs: 0,
      skipped: false,
      extractedOutputs: {},
    };
  }
}

// === Helpers ===

function buildSkippedTrace(
  step: WorkflowStepDef,
  reason: string,
  resolvedArgs?: Record<string, unknown>,
): WorkflowStepTrace {
  return {
    stepDef: step,
    resolvedArgs: resolvedArgs ?? deepClone(step.argsTemplate),
    response: null,
    unwrappedResponse: null,
    isError: false,
    durationMs: 0,
    skipped: true,
    skipReason: reason,
    extractedOutputs: {},
  };
}

function summarizeResponse(response: unknown): string {
  if (!response) return 'No response';
  const str = JSON.stringify(response);
  return str.length > 200 ? str.substring(0, 200) + '...' : str;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
