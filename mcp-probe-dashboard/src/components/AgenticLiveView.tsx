'use client';

import { useEffect, useState, useRef } from 'react';

interface StepInfo {
  operation: string;
  toolName: string;
  status?: 'passed' | 'failed' | 'skipped' | 'running' | 'pending';
  durationMs?: number;
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

interface EntityState {
  entityName: string;
  status: 'pending' | 'running' | 'passed' | 'failed' | 'partial' | 'skipped';
  steps: StepInfo[];
  representedEntities?: string[];
}

interface AgentState {
  productName: string;
  status: 'pending' | 'running' | 'passed' | 'failed' | 'partial';
  entities: Map<string, EntityState>;
  entityOrder: string[];
}

interface RunState {
  status: 'connecting' | 'running' | 'completed' | 'failed';
  products: string[];
  agents: Map<string, AgentState>;
  totalSteps: number;
  passedSteps: number;
  failedSteps: number;
}

interface Props {
  runId: string;
  onComplete?: () => void;
}

export default function AgenticLiveView({ runId, onComplete }: Props) {
  const [state, setState] = useState<RunState>({
    status: 'connecting',
    products: [],
    agents: new Map(),
    totalSteps: 0,
    passedSteps: 0,
    failedSteps: 0,
  });
  const [logs, setLogs] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  // Track whether we received real events (not just 'connected')
  const receivedEventsRef = useRef(false);

  useEffect(() => {
    receivedEventsRef.current = false;
    const es = new EventSource(`/api/agentic/runs/${runId}/stream`);

    const addLog = (msg: string) => {
      setLogs((prev) => [...prev.slice(-100), msg]);
    };

    es.onmessage = (e) => {
      const event = JSON.parse(e.data);
      if (!event.type) return;

      // Mark that we got a real event
      if (event.type !== 'connected') {
        receivedEventsRef.current = true;
      }

      setState((prev) => {
        const next = { ...prev, agents: new Map(prev.agents) };

        switch (event.type) {
          case 'connected':
            next.status = 'connecting';
            break;

          case 'agentic:run:start': {
            const products = event.data.products as string[];
            next.status = 'running';
            next.products = products;
            for (const p of products) {
              next.agents.set(p, {
                productName: p,
                status: 'pending',
                entities: new Map(),
                entityOrder: [],
              });
            }
            addLog(`Run started: ${products.length} product agents`);
            break;
          }

          case 'agentic:agent:start': {
            const { productName, entities } = event.data;
            const agent = next.agents.get(productName);
            if (agent) {
              agent.status = 'running';
              agent.entityOrder = entities;
              for (const e of entities) {
                agent.entities.set(e, { entityName: e, status: 'pending', steps: [] });
              }
              next.agents.set(productName, { ...agent });
            }
            addLog(`Agent ${productName}: testing ${entities.length} entities`);
            break;
          }

          case 'agentic:entity:start': {
            const { productName, entityName, steps, representedEntities } = event.data;
            const agent = next.agents.get(productName);
            if (agent) {
              const entity = agent.entities.get(entityName);
              if (entity) {
                entity.status = 'running';
                entity.steps = steps.map((s: StepInfo) => ({
                  ...s,
                  status: 'pending',
                }));
                entity.representedEntities = representedEntities;
                agent.entities.set(entityName, { ...entity });
                next.agents.set(productName, { ...agent });
              }
            }
            const dedupSuffix = representedEntities && representedEntities.length > 1
              ? ` (+${representedEntities.length - 1} similar entities)`
              : '';
            addLog(`${productName} > ${entityName}${dedupSuffix}: starting CRUD lifecycle`);
            break;
          }

          case 'agentic:step:start': {
            const { productName, entityName, toolName } = event.data;
            const agent = next.agents.get(productName);
            if (agent) {
              const entity = agent.entities.get(entityName);
              if (entity) {
                const step = entity.steps.find(
                  (s) => s.toolName === toolName && s.status === 'pending',
                );
                if (step) step.status = 'running';
                agent.entities.set(entityName, { ...entity });
                next.agents.set(productName, { ...agent });
              }
            }
            break;
          }

          case 'agentic:step:end': {
            const { productName, entityName, step } = event.data;
            const agent = next.agents.get(productName);
            if (agent) {
              const entity = agent.entities.get(entityName);
              if (entity) {
                const idx = entity.steps.findIndex(
                  (s) => s.toolName === step.toolName && (s.status === 'running' || s.status === 'pending'),
                );
                if (idx >= 0) {
                  entity.steps[idx] = { ...entity.steps[idx], ...step };
                }
                agent.entities.set(entityName, { ...entity });
                next.agents.set(productName, { ...agent });
              }
            }
            next.totalSteps++;
            if (step.status === 'passed') next.passedSteps++;
            if (step.status === 'failed') next.failedSteps++;
            const icon = step.status === 'passed' ? '+' : step.status === 'failed' ? 'x' : '-';
            addLog(`[${icon}] ${productName} > ${entityName} > ${step.operation} (${step.durationMs}ms)`);
            break;
          }

          case 'agentic:entity:end': {
            const { productName, entityName, result } = event.data;
            const agent = next.agents.get(productName);
            if (agent) {
              const entity = agent.entities.get(entityName);
              if (entity) {
                entity.status = result.status;
                agent.entities.set(entityName, { ...entity });
                next.agents.set(productName, { ...agent });
              }
            }
            break;
          }

          case 'agentic:agent:end': {
            const { productName, result } = event.data;
            const agent = next.agents.get(productName);
            if (agent) {
              agent.status = result.status;
              next.agents.set(productName, { ...agent });
            }
            addLog(`Agent ${productName}: ${result.status} (${result.passedEntities}/${result.totalEntities} entities passed)`);
            break;
          }

          case 'agentic:run:end': {
            next.status = event.data.error ? 'failed' : 'completed';
            if (event.data.error) {
              addLog(`Run failed: ${event.data.error}`);
            } else {
              addLog(`Run completed: ${event.data.passedSteps}/${event.data.totalSteps} steps passed in ${(event.data.durationMs / 1000).toFixed(1)}s`);
            }
            break;
          }
        }

        return next;
      });
    };

    es.onerror = () => {
      setState((prev) => {
        if (prev.status === 'running' || prev.status === 'connecting') {
          return { ...prev, status: 'failed' };
        }
        return prev;
      });
    };

    // Polling fallback: if no real events after 3s, check run status via API
    const pollTimer = setInterval(async () => {
      if (receivedEventsRef.current) return; // SSE is working, skip polling
      try {
        const res = await fetch(`/api/agentic/runs/${runId}`);
        if (!res.ok) return;
        const run = await res.json();
        if (run.status === 'completed' || run.status === 'failed') {
          receivedEventsRef.current = true;
          setState((prev) => {
            if (prev.status === 'completed' || prev.status === 'failed') return prev;
            return {
              ...prev,
              status: run.status,
              passedSteps: run.result?.passedSteps ?? 0,
              failedSteps: run.result?.failedSteps ?? 0,
              totalSteps: run.result?.totalSteps ?? 0,
            };
          });
          setLogs((prev) => {
            if (prev.some((l) => l.includes('completed') || l.includes('failed'))) return prev;
            if (run.result) {
              return [...prev, `Run completed: ${run.result.passedSteps}/${run.result.totalSteps} steps passed in ${(run.result.durationMs / 1000).toFixed(1)}s`];
            }
            return [...prev, `Run ${run.status}`];
          });
          es.close();
          clearInterval(pollTimer);
        }
      } catch {
        // Poll failed, will retry
      }
    }, 2000);

    return () => {
      es.close();
      clearInterval(pollTimer);
    };
  }, [runId]);

  // Auto-scroll logs
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  // Notify on completion
  useEffect(() => {
    if (state.status === 'completed' || state.status === 'failed') {
      onComplete?.();
    }
  }, [state.status, onComplete]);

  const statusColors: Record<string, string> = {
    connecting: 'text-yellow-400',
    running: 'text-blue-400',
    completed: 'text-emerald-400',
    failed: 'text-red-400',
  };

  return (
    <div className="space-y-6">
      {/* Status bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {state.status === 'running' && (
            <div className="h-2 w-2 rounded-full bg-blue-400 animate-pulse" />
          )}
          <span className={`font-medium ${statusColors[state.status] ?? 'text-zinc-400'}`}>
            {state.status === 'connecting' ? 'Connecting...' :
             state.status === 'running' ? 'Running...' :
             state.status === 'completed' ? 'Completed' : 'Failed'}
          </span>
        </div>
        {state.totalSteps > 0 && (
          <div className="flex gap-4 text-sm">
            <span className="text-emerald-400">{state.passedSteps} passed</span>
            <span className="text-red-400">{state.failedSteps} failed</span>
            <span className="text-zinc-400">{state.totalSteps} total</span>
          </div>
        )}
      </div>

      {/* Agent cards grid */}
      <div className="grid gap-4 sm:grid-cols-2">
        {Array.from(state.agents.values()).map((agent) => (
          <AgentCard key={agent.productName} agent={agent} />
        ))}
      </div>

      {/* Event log */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-950">
        <div className="border-b border-zinc-800 px-4 py-2 text-xs font-medium text-zinc-400">
          Event Log
        </div>
        <div
          ref={logRef}
          className="max-h-48 overflow-y-auto p-4 font-mono text-xs text-zinc-500 space-y-0.5"
        >
          {logs.map((log, i) => (
            <div
              key={i}
              className={
                log.includes('[x]')
                  ? 'text-red-400'
                  : log.includes('[+]')
                  ? 'text-emerald-400'
                  : ''
              }
            >
              {log}
            </div>
          ))}
          {logs.length === 0 && <div>Waiting for events...</div>}
        </div>
      </div>
    </div>
  );
}

function AgentCard({ agent }: { agent: AgentState }) {
  const statusBadge: Record<string, { bg: string; text: string }> = {
    pending: { bg: 'bg-zinc-800', text: 'text-zinc-400' },
    running: { bg: 'bg-blue-500/20', text: 'text-blue-400' },
    passed: { bg: 'bg-emerald-500/20', text: 'text-emerald-400' },
    failed: { bg: 'bg-red-500/20', text: 'text-red-400' },
    partial: { bg: 'bg-yellow-500/20', text: 'text-yellow-400' },
  };

  const badge = statusBadge[agent.status] ?? statusBadge.pending;
  const completedEntities = agent.entityOrder.filter((e) => {
    const entity = agent.entities.get(e);
    return entity && entity.status !== 'pending' && entity.status !== 'running';
  }).length;

  // Find the currently running entity
  const currentEntity = agent.entityOrder.find((e) => {
    const entity = agent.entities.get(e);
    return entity?.status === 'running';
  });

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="font-medium text-zinc-100 text-sm">{agent.productName}</div>
        <span className={`rounded px-2 py-0.5 text-xs font-medium ${badge.bg} ${badge.text}`}>
          {agent.status}
        </span>
      </div>

      {/* Entity progress */}
      <div className="text-xs text-zinc-400 mb-3">
        {completedEntities}/{agent.entityOrder.length} entities
      </div>

      {/* Entity progress bar */}
      {agent.entityOrder.length > 0 && (
        <div className="flex gap-1 mb-3">
          {agent.entityOrder.map((entityName) => {
            const entity = agent.entities.get(entityName);
            const represented = entity?.representedEntities;
            const dedupLabel = represented && represented.length > 1
              ? ` (represents: ${represented.join(', ')})`
              : '';
            const color =
              entity?.status === 'passed' ? 'bg-emerald-500' :
              entity?.status === 'failed' ? 'bg-red-500' :
              entity?.status === 'partial' ? 'bg-yellow-500' :
              entity?.status === 'running' ? 'bg-blue-500 animate-pulse' :
              'bg-zinc-700';
            return (
              <div
                key={entityName}
                className={`h-1.5 flex-1 rounded-full ${color}`}
                title={`${entityName}${dedupLabel}: ${entity?.status ?? 'pending'}`}
              />
            );
          })}
        </div>
      )}

      {/* Current entity step pipeline */}
      {currentEntity && (
        <CurrentEntityPanel
          entityName={currentEntity}
          entity={agent.entities.get(currentEntity)!}
        />
      )}
    </div>
  );
}

function CurrentEntityPanel({ entityName, entity }: { entityName: string; entity: EntityState }) {
  const passed = entity.steps.filter((s) => s.status === 'passed').length;
  const failed = entity.steps.filter((s) => s.status === 'failed').length;
  const total = entity.steps.length;
  const represented = entity.representedEntities;
  const otherCount = represented && represented.length > 1 ? represented.length - 1 : 0;

  return (
    <div className="rounded bg-zinc-800/50 p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-zinc-300">
          {entityName}
          {otherCount > 0 && (
            <span
              className="ml-1.5 text-[10px] text-zinc-500"
              title={`Also covers: ${represented!.filter(e => e !== entityName).join(', ')}`}
            >
              (+{otherCount} similar)
            </span>
          )}
        </span>
        <span className="text-[10px] text-zinc-500">
          {passed + failed}/{total} steps
        </span>
      </div>
      <div className="flex items-center gap-1 flex-wrap">
        {entity.steps.map((step, i) => {
          const icon =
            step.status === 'passed' ? 'text-emerald-400' :
            step.status === 'failed' ? 'text-red-400' :
            step.status === 'running' ? 'text-blue-400 animate-pulse' :
            step.status === 'skipped' ? 'text-zinc-600' :
            'text-zinc-600';

          const symbol =
            step.status === 'passed' ? '\u2713' :
            step.status === 'failed' ? '\u2717' :
            step.status === 'running' ? '\u25CB' :
            step.status === 'skipped' ? '-' :
            '\u00B7';

          // Show short tool name: strip common prefix (e.g. "ZohoCRM_")
          const shortName = step.toolName.replace(/^[A-Za-z]+_/, '').substring(0, 10);

          return (
            <span
              key={i}
              className={`text-[10px] font-mono ${icon} px-1 py-0.5 rounded bg-zinc-800`}
              title={step.toolName}
            >
              {shortName}{symbol}
            </span>
          );
        })}
      </div>
    </div>
  );
}
