'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import ScoreCard from '@/components/ScoreCard';

interface RunEntry {
  runId: string;
  status: string;
  startedAt: string;
  completedAt?: string;
  report?: {
    duration: number;
    servers: {
      serverName: string;
      score: { grade: string; percentage: number; passed: number; total: number } | null;
    }[];
  };
}

export default function RunsPage() {
  const [runs, setRuns] = useState<RunEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/runs')
      .then((r) => r.json())
      .then(setRuns)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="text-zinc-500">Loading...</div>;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Run History</h1>

      {runs.length === 0 ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-12 text-center text-zinc-500">
          No runs yet. Go to the <Link href="/" className="text-blue-400 hover:underline">Dashboard</Link> to start a test run.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-zinc-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 bg-zinc-900/80 text-left text-xs text-zinc-500">
                <th className="px-4 py-3 font-medium">Run ID</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Servers</th>
                <th className="px-4 py-3 font-medium">Scores</th>
                <th className="px-4 py-3 font-medium">Duration</th>
                <th className="px-4 py-3 font-medium">Started</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.runId} className="border-b border-zinc-800/50 hover:bg-zinc-800/30">
                  <td className="px-4 py-3">
                    <Link
                      href={`/runs/${run.runId}`}
                      className="font-mono text-blue-400 hover:underline"
                    >
                      {run.runId.slice(0, 8)}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={run.status} />
                  </td>
                  <td className="px-4 py-3 text-zinc-300">
                    {run.report?.servers.map((s) => s.serverName).join(', ') ?? '-'}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1">
                      {run.report?.servers.map((srv) =>
                        srv.score ? (
                          <ScoreCard key={srv.serverName} {...srv.score} compact />
                        ) : null,
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-zinc-400">
                    {run.report ? `${(run.report.duration / 1000).toFixed(1)}s` : '-'}
                  </td>
                  <td className="px-4 py-3 text-zinc-500">
                    {new Date(run.startedAt).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
