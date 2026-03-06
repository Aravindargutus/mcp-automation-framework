'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import ScoreCard from '@/components/ScoreCard';
import LiveProgress from '@/components/LiveProgress';
import LLMSettings from '@/components/LLMSettings';

interface ServerConfig {
  name: string;
  transport: { type: string; command?: string; url?: string };
}

interface RunEntry {
  runId: string;
  status: string;
  startedAt: string;
  completedAt?: string;
  report?: {
    servers: {
      serverName: string;
      score: { grade: string; percentage: number; passed: number; total: number } | null;
    }[];
  };
}

export default function DashboardPage() {
  const [servers, setServers] = useState<ServerConfig[]>([]);
  const [runs, setRuns] = useState<RunEntry[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    const [srvRes, runRes] = await Promise.all([
      fetch('/api/servers'),
      fetch('/api/runs'),
    ]);
    if (srvRes.ok) setServers(await srvRes.json());
    if (runRes.ok) setRuns(await runRes.json());
    setLoading(false);
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  async function runAll() {
    if (servers.length === 0) return;
    const res = await fetch('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ servers }),
    });
    if (res.ok) {
      const { runId } = await res.json();
      setActiveRunId(runId);
    }
  }

  async function runSingle(server: ServerConfig) {
    const res = await fetch('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ servers: [server] }),
    });
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
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <div className="flex gap-3">
          <Link
            href="/servers"
            className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
          >
            Add Server
          </Link>
          <button
            onClick={runAll}
            disabled={servers.length === 0}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          >
            Test All Servers
          </button>
        </div>
      </div>

      {/* Live progress */}
      {activeRunId && (
        <div className="rounded-xl border border-blue-500/30 bg-blue-500/5 p-6">
          <h2 className="mb-4 text-lg font-semibold">Live Run</h2>
          <LiveProgress
            runId={activeRunId}
            onComplete={() => {
              setActiveRunId(null);
              fetchData();
            }}
          />
        </div>
      )}

      {/* LLM Judge settings */}
      <LLMSettings />

      {/* Server list */}
      <section>
        <h2 className="mb-4 text-lg font-semibold text-zinc-200">Configured Servers</h2>
        {servers.length === 0 ? (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-8 text-center text-zinc-500">
            No servers configured.{' '}
            <Link href="/servers" className="text-blue-400 hover:underline">Add one</Link>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {servers.map((srv) => (
              <div key={srv.name} className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
                <div className="flex items-center justify-between">
                  <div className="font-medium text-zinc-100">{srv.name}</div>
                  <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">
                    {srv.transport.type}
                  </span>
                </div>
                <div className="mt-1 truncate text-xs text-zinc-500">
                  {srv.transport.command ?? srv.transport.url}
                </div>
                <button
                  onClick={() => runSingle(srv)}
                  className="mt-3 rounded-md bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700"
                >
                  Run Tests
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Recent runs */}
      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-zinc-200">Recent Runs</h2>
          <Link href="/runs" className="text-sm text-blue-400 hover:underline">View all</Link>
        </div>
        {runs.length === 0 ? (
          <div className="text-sm text-zinc-500">No runs yet.</div>
        ) : (
          <div className="space-y-2">
            {runs.slice(0, 5).map((run) => (
              <Link
                key={run.runId}
                href={`/runs/${run.runId}`}
                className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 hover:bg-zinc-800/50"
              >
                <div className="flex items-center gap-3">
                  <StatusDot status={run.status} />
                  <span className="text-sm font-mono text-zinc-400">{run.runId.slice(0, 8)}</span>
                  <span className="text-xs text-zinc-500">
                    {new Date(run.startedAt).toLocaleString()}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {run.report?.servers.map((srv) =>
                    srv.score ? (
                      <ScoreCard key={srv.serverName} {...srv.score} compact />
                    ) : null,
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
