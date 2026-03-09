'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import AgenticLiveView from '@/components/AgenticLiveView';
import AgenticResultTree from '@/components/AgenticResultTree';

interface AgenticRunEntry {
  runId: string;
  serverName: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
  result?: any;
}

export default function AgenticRunDetailPage() {
  const params = useParams();
  const runId = params.runId as string;
  const [run, setRun] = useState<AgenticRunEntry | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/agentic/runs/${runId}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        setRun(data);
        setLoading(false);
      });
  }, [runId]);

  function refresh() {
    fetch(`/api/agentic/runs/${runId}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setRun(data));
  }

  if (loading) {
    return <div className="text-zinc-500">Loading...</div>;
  }

  if (!run) {
    return (
      <div className="text-zinc-500">
        Run not found.{' '}
        <Link href="/agentic" className="text-blue-400 hover:underline">Back to Agentic</Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <Link href="/agentic" className="text-sm text-zinc-500 hover:text-zinc-300">
            {'\u2190'} Back to Agentic Testing
          </Link>
          <h1 className="mt-1 text-xl font-bold">
            Run {runId.slice(0, 8)}
          </h1>
          <div className="mt-1 text-sm text-zinc-400">
            {run.serverName} | {new Date(run.startedAt).toLocaleString()}
          </div>
        </div>
        <StatusBadge status={run.status} />
      </div>

      {/* Live view if running */}
      {run.status === 'running' && (
        <div className="rounded-xl border border-blue-500/30 bg-blue-500/5 p-6">
          <AgenticLiveView runId={runId} onComplete={refresh} />
        </div>
      )}

      {/* Result tree if completed */}
      {run.status === 'completed' && run.result && (
        <AgenticResultTree result={run.result} />
      )}

      {/* Error state */}
      {run.status === 'failed' && !run.result && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-6 text-red-400">
          Run failed. Check the server logs for details.
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    running: 'bg-blue-500/20 text-blue-400',
    completed: 'bg-emerald-500/20 text-emerald-400',
    failed: 'bg-red-500/20 text-red-400',
  };

  return (
    <span className={`rounded-lg px-3 py-1 text-sm font-medium ${colors[status] ?? 'bg-zinc-700 text-zinc-400'}`}>
      {status}
    </span>
  );
}
