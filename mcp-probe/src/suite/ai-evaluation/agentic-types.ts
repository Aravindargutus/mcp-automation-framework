/**
 * Shared types for agentic AI evaluation tests.
 *
 * Used by tool-selection, workflow-chaining, scenario-execution,
 * and agentic-loop test generators.
 */

// ─── Agent action/observation types ─────────────────────────────────

export interface AgentAction {
  step: number;
  action: 'call_tool' | 'read_resource' | 'finish';
  toolName?: string;
  args?: unknown;
  uri?: string;
  reasoning: string;
}

export interface AgentObservation {
  step: number;
  response: unknown;
  isError: boolean;
  durationMs: number;
}

export interface AgentStep {
  action: AgentAction;
  observation?: AgentObservation;
}

// ─── Workflow chaining types ────────────────────────────────────────

export interface WorkflowStep {
  toolName: string;
  args: Record<string, unknown>;
  outputMapping?: Record<string, string>; // paramName → "$.steps[N].response.field"
}

export interface WorkflowTraceEntry {
  planned: WorkflowStep;
  resolvedArgs: Record<string, unknown>;
  response: unknown;
  isError: boolean;
  durationMs: number;
  skipped: boolean;
  skipReason?: string;
}

export interface WorkflowTrace {
  description: string;
  steps: WorkflowTraceEntry[];
}

// ─── Scenario execution types ───────────────────────────────────────

export interface ScenarioSpec {
  scenario: string;
  successCriteria: string[];
  expectedToolSequence: string[];
  difficulty: string;
}

export interface CriterionResult {
  criterion: string;
  met: boolean;
  evidence: string;
}
