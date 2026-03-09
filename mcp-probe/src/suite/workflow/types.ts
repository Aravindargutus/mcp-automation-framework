/**
 * Workflow Suite Types — domain model for dependency-aware CRUD lifecycle testing.
 */

// === CRUD Operation Classification ===

export type CRUDOperation =
  | 'create'
  | 'read'
  | 'update'
  | 'delete'
  | 'search'
  | 'upsert'
  | 'list'
  | 'tag'
  | 'untag'
  | 'assign'
  | 'remove'
  | 'other';

export interface ToolClassification {
  toolName: string;
  operation: CRUDOperation;
  entityHint: string | null;       // e.g., "Records", "Tags", "Territories"
  prefixGroup: string | null;      // e.g., "ZohoCRM" — shared prefix
  producesId: boolean;             // tool creates entities (returns IDs)
  consumesId: boolean;             // tool requires entity IDs as input
  idParamPaths: string[];          // e.g., ["path_variables.record_id", "body.data[].id"]
  moduleParam: string | null;      // e.g., "path_variables.module" — the entity-type param
  moduleValues: string[];          // enum values for module param, e.g., ["Leads", "Contacts"]
}

// === Dependency Graph ===

export interface DependencyEdge {
  from: string;        // tool that produces the value
  to: string;          // tool that consumes the value
  outputPath: string;  // path in from's response where ID lives
  inputPath: string;   // path in to's args where the ID is needed
  type: 'id' | 'data';
}

export interface EntityGroup {
  entityName: string;              // e.g., "Leads", "Contacts", "Records"
  prefix: string;                  // e.g., "ZohoCRM"
  isModuleScoped: boolean;         // true for module-enum groups (Leads, Contacts), false for standalone (Users, Roles)
  create: string[];                // tool names for create ops
  read: string[];                  // tool names for read/get ops
  update: string[];                // tool names for update ops
  delete: string[];                // tool names for delete ops
  search: string[];                // tool names for search ops
  other: string[];                 // tag, assign, upsert, etc.
}

export interface DependencyGraph {
  tools: ToolClassification[];
  edges: DependencyEdge[];
  entityGroups: EntityGroup[];
}

// === Workflow Definition ===

export interface OutputMapping {
  name: string;    // logical name: "createdRecordId"
  path: string;    // JSON path in response: "data[0].details.id"
}

export interface InputMapping {
  paramPath: string;   // where to inject in args: "body.data[0].id"
  fromOutput: string;  // which OutputMapping name: "createdRecordId"
}

export interface WorkflowStepDef {
  stepIndex: number;
  toolName: string;
  operation: CRUDOperation;
  description: string;
  argsTemplate: Record<string, unknown>;
  outputMappings: OutputMapping[];
  inputMappings: InputMapping[];
}

export interface WorkflowDefinition {
  id: string;                       // e.g., "workflow.crud.Leads"
  name: string;                     // e.g., "CRUD lifecycle: Leads"
  description: string;
  entity: string;                   // e.g., "Leads"
  steps: WorkflowStepDef[];
  cleanupSteps: WorkflowStepDef[];  // always run even if earlier steps fail
  representedEntities?: string[];   // other entities deduped into this workflow
}

// === Execution Trace ===

export interface WorkflowStepTrace {
  stepDef: WorkflowStepDef;
  resolvedArgs: Record<string, unknown>;
  response: unknown;
  unwrappedResponse: unknown;
  isError: boolean;
  durationMs: number;
  skipped: boolean;
  skipReason?: string;
  extractedOutputs: Record<string, unknown>;
}

export interface WorkflowExecutionTrace {
  workflow: WorkflowDefinition;
  steps: WorkflowStepTrace[];
  cleanupSteps: WorkflowStepTrace[];
  totalDurationMs: number;
  outputStore: Record<string, unknown>;
}

// === Config ===

export interface WorkflowConfig {
  enabled: boolean;
  maxEntities: number;
  modules?: string[];
  testDataOverrides?: Record<string, Record<string, unknown>>;
}
