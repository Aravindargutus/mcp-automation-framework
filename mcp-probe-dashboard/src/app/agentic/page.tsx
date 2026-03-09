'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import AgenticLiveView from '@/components/AgenticLiveView';

interface ServerConfig {
  name: string;
  transport: { type: string; command?: string; url?: string };
}

interface AgenticRunEntry {
  runId: string;
  serverName: string;
  status: string;
  startedAt: string;
  completedAt?: string;
  progress?: {
    totalProducts: number;
    completedProducts: number;
    totalEntities: number;
    completedEntities: number;
    passedSteps: number;
    failedSteps: number;
    totalSteps: number;
  };
  result?: {
    totalProducts: number;
    totalEntities: number;
    passedSteps: number;
    failedSteps: number;
    totalSteps: number;
    durationMs: number;
    status: string;
  };
}

export default function AgenticPage() {
  const [servers, setServers] = useState<ServerConfig[]>([]);
  const [selectedServer, setSelectedServer] = useState('');
  const [modulesFilter, setModulesFilter] = useState('');
  const [runs, setRuns] = useState<AgenticRunEntry[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);

  const fetchData = useCallback(async () => {
    const [srvRes, runRes] = await Promise.all([
      fetch('/api/servers'),
      fetch('/api/agentic/runs'),
    ]);
    if (srvRes.ok) {
      const srvs = await srvRes.json();
      setServers(srvs);
      if (srvs.length > 0 && !selectedServer) {
        setSelectedServer(srvs[0].name);
      }
    }
    if (runRes.ok) setRuns(await runRes.json());
    setLoading(false);
  }, [selectedServer]);

  useEffect(() => { fetchData(); }, [fetchData]);

  async function startAgenticTest() {
    if (!selectedServer || starting) return;
    setStarting(true);

    const body: Record<string, unknown> = { serverName: selectedServer };
    if (modulesFilter.trim()) {
      body.modules = modulesFilter.split(',').map((m) => m.trim()).filter(Boolean);
    }

    const res = await fetch('/api/agentic/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    setStarting(false);
    if (res.ok) {
      const { runId } = await res.json();
      setActiveRunId(runId);
    }
  }

  if (loading) {
    return <div className="text-zinc-500">Loading...</div>;
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Agentic Testing</h1>
      </div>

      {/* Controls */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          {/* Server selector */}
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-400">Server</label>
            <select
              value={selectedServer}
              onChange={(e) => setSelectedServer(e.target.value)}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100"
            >
              {servers.map((srv) => (
                <option key={srv.name} value={srv.name}>{srv.name}</option>
              ))}
            </select>
          </div>

          {/* Modules filter */}
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-400">
              Modules (optional, comma-separated)
            </label>
            <input
              type="text"
              value={modulesFilter}
              onChange={(e) => setModulesFilter(e.target.value)}
              placeholder="e.g., Leads, Contacts, Deals"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600"
            />
          </div>

          {/* Start button */}
          <div className="flex items-end">
            <button
              onClick={startAgenticTest}
              disabled={!selectedServer || starting || !!activeRunId}
              className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
            >
              {starting ? 'Starting...' : activeRunId ? 'Running...' : 'Start Agentic Test'}
            </button>
          </div>
        </div>
        <p className="text-xs text-zinc-500">
          Spawns parallel product agents that test all available tools per entity using real CRUD lifecycle data.
          Creates a record, then tests every tool (Read, Update, Upsert, Tags, Territories, Search, etc.), then cleans up.
        </p>
      </div>

      {/* Live view */}
      {activeRunId && (
        <div className="rounded-xl border border-blue-500/30 bg-blue-500/5 p-6">
          <h2 className="mb-4 text-lg font-semibold">Live Run</h2>
          <AgenticLiveView
            runId={activeRunId}
            onComplete={() => {
              setActiveRunId(null);
              fetchData();
            }}
          />
        </div>
      )}

      {/* Recent runs */}
      <section>
        <h2 className="mb-4 text-lg font-semibold text-zinc-200">Recent Agentic Runs</h2>
        {runs.length === 0 ? (
          <div className="text-sm text-zinc-500">No agentic runs yet.</div>
        ) : (
          <div className="space-y-2">
            {runs.slice(0, 10).map((run) => (
              <Link
                key={run.runId}
                href={`/agentic/${run.runId}`}
                className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 hover:bg-zinc-800/50"
              >
                <div className="flex items-center gap-3">
                  <StatusDot status={run.status} />
                  <span className="text-sm font-mono text-zinc-400">{run.runId.slice(0, 8)}</span>
                  <span className="text-sm text-zinc-300">{run.serverName}</span>
                  <span className="text-xs text-zinc-500">
                    {new Date(run.startedAt).toLocaleString()}
                  </span>
                </div>
                <div className="flex items-center gap-3 text-xs">
                  {run.result && (
                    <>
                      <span className="text-emerald-400">{run.result.passedSteps} passed</span>
                      <span className="text-red-400">{run.result.failedSteps} failed</span>
                      <span className="text-zinc-400">{(run.result.durationMs / 1000).toFixed(1)}s</span>
                    </>
                  )}
                  {run.progress && run.status === 'running' && (
                    <span className="text-blue-400">
                      {run.progress.completedEntities}/{run.progress.totalEntities} entities
                    </span>
                  )}
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const colors: Record<string, string> = {
    running: 'bg-blue-400 animate-pulse',
    completed: 'bg-emerald-400',
    failed: 'bg-red-400',
  };
  return <div className={`h-2 w-2 rounded-full ${colors[status] ?? 'bg-zinc-600'}`} />;
}
