/**
 * Agentic Testing Types — domain model for parallel product-agent CRUD lifecycle testing.
 */
import type { ServerConfig, LLMJudgeConfig } from '../config/schema.js';

// === Run Configuration ===

export interface AgenticRunConfig {
  serverConfig: ServerConfig;
  productFilter?: string[];
  maxEntitiesPerProduct?: number;
  modules?: string[];
  testDataOverrides?: Record<string, Record<string, unknown>>;
  requestTimeoutMs?: number;
  llm?: LLMJudgeConfig;
}

// === Callbacks for Real-Time Reporting ===

export interface StepInfo {
  operation: string;
  toolName: string;
}

export interface AgenticRunCallbacks {
  onRunStart?: (runId: string, products: string[]) => void;
  onAgentStart?: (productName: string, entities: string[]) => void;
  onAgentEnd?: (productName: string, result: ProductAgentResult) => void;
  onEntityStart?: (productName: string, entityName: string, steps: StepInfo[], representedEntities?: string[]) => void;
  onEntityEnd?: (productName: string, entityName: string, result: EntityResult) => void;
  onStepStart?: (productName: string, entityName: string, operation: string, toolName: string) => void;
  onStepEnd?: (productName: string, entityName: string, step: StepSummary) => void;
  onRunEnd?: (result: AgenticRunResult) => void;
}

// === Step-Level Results ===

export interface StepSummary {
  operation: string;
  toolName: string;
  status: 'passed' | 'failed' | 'skipped';
  durationMs: number;
  isError: boolean;
  extractedId?: string;
  errorMessage?: string;
  inputArgs?: Record<string, unknown>;
  actualResponse?: unknown;
  extractedOutputs?: Record<string, unknown>;
  // PIV loop fields (backward compatible — all optional)
  pivPhases?: Array<{ phase: 'plan' | 'implement' | 'validate'; durationMs: number }>;
  attempts?: number;
  errorCategory?: string;
  planningNotes?: string[];
}

// === Entity-Level Results ===

export interface EntityResult {
  entityName: string;
  status: 'passed' | 'failed' | 'partial' | 'skipped';
  steps: StepSummary[];
  durationMs: number;
  representedEntities?: string[];
}

// === Product Agent Results ===

export interface ProductAgentResult {
  productName: string;
  status: 'passed' | 'failed' | 'partial';
  entities: EntityResult[];
  totalEntities: number;
  passedEntities: number;
  failedEntities: number;
  durationMs: number;
}

// === Aggregate Run Result ===

export interface AgenticRunResult {
  runId: string;
  serverName: string;
  status: 'completed' | 'failed';
  agents: ProductAgentResult[];
  totalProducts: number;
  totalEntities: number;
  totalSteps: number;
  passedSteps: number;
  failedSteps: number;
  durationMs: number;
  discoveredToolCount: number;
}
