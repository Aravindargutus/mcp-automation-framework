'use client';

import { useState } from 'react';

interface StepSummary {
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
  pivPhases?: Array<{ phase: 'plan' | 'implement' | 'validate'; durationMs: number }>;
  attempts?: number;
  errorCategory?: string;
  planningNotes?: string[];
}

interface EntityResult {
  entityName: string;
  status: 'passed' | 'failed' | 'partial' | 'skipped';
  steps: StepSummary[];
  durationMs: number;
  representedEntities?: string[];
}

interface ProductAgentResult {
  productName: string;
  status: 'passed' | 'failed' | 'partial';
  entities: EntityResult[];
  totalEntities: number;
  passedEntities: number;
  failedEntities: number;
  durationMs: number;
}

interface AgenticRunResult {
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

interface Props {
  result: AgenticRunResult;
}

export default function AgenticResultTree({ result }: Props) {
  const passRate = result.totalSteps > 0
    ? Math.round((result.passedSteps / result.totalSteps) * 100)
    : 0;

  return (
    <div className="space-y-6">
      {/* Summary header */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-zinc-100">Agentic Test Results</h3>
          <StatusBadge status={result.status === 'completed' && result.failedSteps === 0 ? 'passed' : 'failed'} />
        </div>
        <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <Stat label="Products" value={result.totalProducts} />
          <Stat label="Entities" value={result.totalEntities} />
          <Stat label="Steps" value={`${result.passedSteps}/${result.totalSteps}`} />
          <Stat label="Pass Rate" value={`${passRate}%`} />
        </div>
        <div className="mt-3 text-xs text-zinc-500">
          {result.discoveredToolCount} tools discovered | {(result.durationMs / 1000).toFixed(1)}s total
        </div>
      </div>

      {/* Agent results */}
      {result.agents.map((agent) => (
        <AgentNode key={agent.productName} agent={agent} />
      ))}
    </div>
  );
}

function AgentNode({ agent }: { agent: ProductAgentResult }) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-4 text-left hover:bg-zinc-800/30"
      >
        <div className="flex items-center gap-3">
          <span className="text-zinc-500">{expanded ? '\u25BC' : '\u25B6'}</span>
          <span className="font-medium text-zinc-100">{agent.productName}</span>
          <StatusBadge status={agent.status} />
        </div>
        <div className="flex items-center gap-4 text-xs text-zinc-400">
          <span className="text-emerald-400">{agent.passedEntities} passed</span>
          <span className="text-red-400">{agent.failedEntities} failed</span>
          <span>{(agent.durationMs / 1000).toFixed(1)}s</span>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-zinc-800 px-4 pb-4">
          {agent.entities.map((entity) => (
            <EntityNode key={entity.entityName} entity={entity} />
          ))}
        </div>
      )}
    </div>
  );
}

function EntityNode({ entity }: { entity: EntityResult }) {
  const [expanded, setExpanded] = useState(entity.status !== 'passed');
  const represented = entity.representedEntities;
  const otherCount = represented && represented.length > 1 ? represented.length - 1 : 0;

  return (
    <div className="mt-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between rounded px-3 py-2 text-left hover:bg-zinc-800/30"
      >
        <div className="flex items-center gap-3">
          <span className="text-xs text-zinc-500">{expanded ? '\u25BC' : '\u25B6'}</span>
          <span className="text-sm text-zinc-200">{entity.entityName}</span>
          {otherCount > 0 && (
            <span
              className="text-[10px] text-zinc-500 bg-zinc-800 rounded px-1.5 py-0.5"
              title={`Identical tool sets: ${represented!.join(', ')}`}
            >
              +{otherCount} similar
            </span>
          )}
          <StatusBadge status={entity.status} small />
        </div>
        <div className="flex items-center gap-3">
          {/* Step pass/total counter */}
          <span className="text-xs font-mono">
            <span className="text-emerald-400">{entity.steps.filter((s) => s.status === 'passed').length}</span>
            <span className="text-zinc-500">/{entity.steps.length} steps</span>
          </span>
          <span className="text-xs text-zinc-500">{(entity.durationMs / 1000).toFixed(1)}s</span>
        </div>
      </button>

      {expanded && (
        <div className="ml-8 mt-1 space-y-1">
          {otherCount > 0 && (
            <div className="text-[10px] text-zinc-500 mb-2 px-3">
              Represents: {represented!.join(', ')}
            </div>
          )}
          {entity.steps.map((step, i) => (
            <StepNode key={i} step={step} />
          ))}
        </div>
      )}
    </div>
  );
}

function StepNode({ step }: { step: StepSummary }) {
  const [expanded, setExpanded] = useState(false);

  const statusIcon =
    step.status === 'passed' ? '\u2713' :
    step.status === 'failed' ? '\u2717' :
    '-';

  const statusColor =
    step.status === 'passed' ? 'text-emerald-400' :
    step.status === 'failed' ? 'text-red-400' :
    'text-zinc-500';

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between rounded px-3 py-1.5 text-left hover:bg-zinc-800/20"
      >
        <div className="flex items-center gap-2">
          <span className={`font-mono text-xs ${statusColor}`}>{statusIcon}</span>
          <span className="text-xs font-medium text-zinc-300 capitalize">{step.operation}</span>
          <span className="text-xs text-zinc-500 font-mono">{step.toolName}</span>
          {step.errorCategory && (
            <ErrorCategoryBadge category={step.errorCategory} />
          )}
          {(step.attempts ?? 0) > 1 && (
            <span className="text-[10px] bg-yellow-500/20 text-yellow-400 rounded px-1.5 py-0.5">
              {step.attempts} attempts
            </span>
          )}
        </div>
        <span className="text-xs text-zinc-500">{step.durationMs}ms</span>
      </button>

      {expanded && (
        <div className="ml-6 rounded bg-zinc-800/30 p-3 text-xs space-y-3">
          <div className="space-y-1">
            <div><span className="text-zinc-500">Tool:</span> <span className="text-zinc-300 font-mono">{step.toolName}</span></div>
            <div><span className="text-zinc-500">Duration:</span> <span className="text-zinc-300">{step.durationMs}ms</span></div>
            {step.extractedId && (
              <div><span className="text-zinc-500">Extracted ID:</span> <span className="text-emerald-400 font-mono">{step.extractedId}</span></div>
            )}
            {step.errorCategory && (
              <div><span className="text-zinc-500">Error Category:</span> <ErrorCategoryBadge category={step.errorCategory} /></div>
            )}
            {(step.attempts ?? 0) > 1 && (
              <div><span className="text-zinc-500">Attempts:</span> <span className="text-yellow-400">{step.attempts}</span></div>
            )}
          </div>

          {/* PIV Phase Breakdown */}
          {step.pivPhases && step.pivPhases.length > 0 && (
            <div className="border border-zinc-700/50 rounded p-2">
              <div className="text-[10px] font-medium uppercase tracking-wide text-zinc-400 mb-1.5">PIV Phases</div>
              <div className="flex gap-2">
                {step.pivPhases.map((p, i) => (
                  <div key={i} className="flex items-center gap-1">
                    <span className={`text-[10px] font-medium ${
                      p.phase === 'plan' ? 'text-blue-400' :
                      p.phase === 'implement' ? 'text-purple-400' :
                      'text-amber-400'
                    }`}>
                      {p.phase}
                    </span>
                    <span className="text-[10px] text-zinc-500">{p.durationMs}ms</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Planning Notes */}
          {step.planningNotes && step.planningNotes.length > 0 && (
            <div className="border border-blue-800/30 rounded p-2">
              <div className="text-[10px] font-medium uppercase tracking-wide text-blue-400 mb-1">Planning Notes</div>
              {step.planningNotes.map((note, i) => (
                <div key={i} className="text-[10px] text-zinc-400">{note}</div>
              ))}
            </div>
          )}

          {/* Input Args */}
          {!!step.inputArgs && (
            <JsonSection label="Input" data={step.inputArgs} variant="default" />
          )}

          {/* Actual Response */}
          {!!step.actualResponse && (
            <JsonSection
              label="Actual Response"
              data={step.actualResponse}
              variant={step.isError ? 'error' : 'success'}
            />
          )}

          {/* Extracted Outputs */}
          {!!step.extractedOutputs && (
            <JsonSection label="Extracted Outputs" data={step.extractedOutputs} variant="success" />
          )}

          {/* Error message (fallback for steps without actualResponse) */}
          {step.errorMessage && !step.actualResponse && (
            <div className="text-red-400 font-mono break-all">{step.errorMessage}</div>
          )}
        </div>
      )}
    </div>
  );
}

function ErrorCategoryBadge({ category }: { category: string }) {
  const colors: Record<string, string> = {
    auth_error: 'bg-orange-500/20 text-orange-400',
    rate_limit: 'bg-yellow-500/20 text-yellow-400',
    validation_error: 'bg-red-500/20 text-red-400',
    not_found: 'bg-zinc-600/30 text-zinc-400',
    server_error: 'bg-red-600/20 text-red-300',
    timeout: 'bg-amber-500/20 text-amber-400',
    schema_mismatch: 'bg-purple-500/20 text-purple-400',
    unknown: 'bg-zinc-700 text-zinc-400',
  };

  const cls = colors[category] ?? colors.unknown;
  return (
    <span className={`text-[10px] rounded px-1.5 py-0.5 font-mono ${cls}`}>
      {category}
    </span>
  );
}

function JsonSection({
  label,
  data,
  variant = 'default',
}: {
  label: string;
  data: unknown;
  variant?: 'default' | 'success' | 'error';
}) {
  const [collapsed, setCollapsed] = useState(true);
  const json = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const preview = json.length > 120 ? json.substring(0, 120) + '...' : json;
  const isLong = json.length > 120;

  const borderColor =
    variant === 'error' ? 'border-red-800/50' :
    variant === 'success' ? 'border-emerald-800/50' :
    'border-zinc-700/50';

  const labelColor =
    variant === 'error' ? 'text-red-400' :
    variant === 'success' ? 'text-emerald-400' :
    'text-zinc-400';

  return (
    <div className={`border rounded ${borderColor}`}>
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center justify-between px-2 py-1 hover:bg-zinc-800/30"
      >
        <span className={`text-[10px] font-medium uppercase tracking-wide ${labelColor}`}>{label}</span>
        {isLong && (
          <span className="text-[10px] text-zinc-600">{collapsed ? 'expand' : 'collapse'}</span>
        )}
      </button>
      <div className="px-2 pb-2">
        <pre className="text-zinc-300 font-mono text-[11px] whitespace-pre-wrap break-all max-h-60 overflow-y-auto">
          {collapsed ? preview : json}
        </pre>
      </div>
    </div>
  );
}

function StepDot({ status, operation }: { status: string; operation: string }) {
  const color =
    status === 'passed' ? 'bg-emerald-500' :
    status === 'failed' ? 'bg-red-500' :
    'bg-zinc-600';

  return (
    <div
      className={`h-2 w-2 rounded-full ${color}`}
      title={`${operation}: ${status}`}
    />
  );
}

function StatusBadge({ status, small }: { status: string; small?: boolean }) {
  const colors: Record<string, string> = {
    passed: 'bg-emerald-500/20 text-emerald-400',
    completed: 'bg-emerald-500/20 text-emerald-400',
    failed: 'bg-red-500/20 text-red-400',
    partial: 'bg-yellow-500/20 text-yellow-400',
    skipped: 'bg-zinc-700 text-zinc-400',
  };

  const cls = colors[status] ?? 'bg-zinc-700 text-zinc-400';
  const size = small ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-xs';

  return <span className={`rounded font-medium ${cls} ${size}`}>{status}</span>;
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="text-lg font-semibold text-zinc-100">{value}</div>
    </div>
  );
}
