'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import RunSummary from '@/components/RunSummary';
import TestResultTree from '@/components/TestResultTree';
import LiveProgress from '@/components/LiveProgress';

interface RunEntry {
  runId: string;
  status: string;
  startedAt: string;
  completedAt?: string;
  report?: any;
}

export default function RunDetailPage() {
  const params = useParams();
  const runId = params.runId as string;
  const [run, setRun] = useState<RunEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>('');

  function fetchRun() {
    fetch(`/api/runs/${runId}`)
      .then((r) => r.json())
      .then(setRun)
      .finally(() => setLoading(false));
  }

  useEffect(() => { fetchRun(); }, [runId]);

  if (loading) return <div className="text-zinc-500">Loading...</div>;
  if (!run) return <div className="text-red-400">Run not found.</div>;

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-4">
        <Link href="/runs" className="text-zinc-400 hover:text-zinc-200">&larr; Runs</Link>
        <h1 className="text-2xl font-bold">Run {runId.slice(0, 8)}</h1>
        <StatusBadge status={run.status} />
      </div>

      {/* If still running, show live progress */}
      {run.status === 'running' && (
        <div className="rounded-xl border border-blue-500/30 bg-blue-500/5 p-6">
          <LiveProgress runId={runId} onComplete={fetchRun} />
        </div>
      )}

      {/* Completed — show summary + results */}
      {run.report && (
        <>
          <RunSummary report={run.report} />

          {/* Filter bar */}
          <div className="flex items-center gap-3">
            <span className="text-sm text-zinc-400">Filter:</span>
            {['', 'failed', 'passed', 'skipped'].map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`rounded-md px-3 py-1 text-xs ${
                  filter === f
                    ? 'bg-zinc-700 text-zinc-100'
                    : 'text-zinc-400 hover:bg-zinc-800'
                }`}
              >
                {f || 'All'}
              </button>
            ))}
          </div>

          <TestResultTree servers={run.report.servers} filterStatus={filter || undefined} />
        </>
      )}

      {/* Failed run */}
      {run.status === 'failed' && !run.report && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-6 text-red-400">
          Run failed. Check server logs for details.
        </div>
      )}

      {/* Metadata */}
      <div className="text-xs text-zinc-600">
        <div>Started: {new Date(run.startedAt).toLocaleString()}</div>
        {run.completedAt && <div>Completed: {new Date(run.completedAt).toLocaleString()}</div>}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    running: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
    completed: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
    failed: 'bg-red-500/20 text-red-400 border-red-500/30',
  };
  return (
    <span className={`inline-block rounded-md border px-2 py-0.5 text-xs font-medium ${styles[status] ?? 'bg-zinc-800 text-zinc-400 border-zinc-700'}`}>
      {status}
    </span>
  );
}
