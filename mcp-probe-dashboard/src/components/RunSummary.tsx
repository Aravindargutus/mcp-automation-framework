'use client';

import ScoreCard from './ScoreCard';

interface ServerReport {
  serverName: string;
  durationMs: number;
  connected: boolean;
  connectionError: string | null;
  score: { grade: string; percentage: number; passed: number; total: number } | null;
  suites: {
    suiteName: string;
    passed: number;
    failed: number;
    skipped: number;
    errored: number;
  }[];
}

interface MCPProbeReport {
  runId: string;
  timestamp: string;
  duration: number;
  servers: ServerReport[];
}

interface RunSummaryProps {
  report: MCPProbeReport;
}

export default function RunSummary({ report }: RunSummaryProps) {
  const totalPassed = report.servers.reduce((s, srv) => s + (srv.score?.passed ?? 0), 0);
  const totalTests = report.servers.reduce((s, srv) => s + (srv.score?.total ?? 0), 0);
  const totalFailed = totalTests - totalPassed;
  const overallPct = totalTests > 0 ? Math.round((totalPassed / totalTests) * 100) : 0;
  const overallGrade = overallPct >= 90 ? 'A' : overallPct >= 75 ? 'B' : overallPct >= 60 ? 'C' : overallPct >= 45 ? 'D' : 'F';

  return (
    <div className="space-y-6">
      {/* Overall score */}
      <div className="flex items-start gap-8">
        <ScoreCard grade={overallGrade} percentage={overallPct} passed={totalPassed} total={totalTests} />
        <div className="flex-1 space-y-3">
          <div className="grid grid-cols-4 gap-4">
            <StatBox label="Duration" value={`${(report.duration / 1000).toFixed(1)}s`} />
            <StatBox label="Servers" value={String(report.servers.length)} />
            <StatBox label="Passed" value={String(totalPassed)} color="text-emerald-400" />
            <StatBox label="Failed" value={String(totalFailed)} color="text-red-400" />
          </div>

          {/* Per-server table */}
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-left text-xs text-zinc-500">
                <th className="pb-2 font-medium">Server</th>
                <th className="pb-2 font-medium">Grade</th>
                <th className="pb-2 font-medium">Passed</th>
                <th className="pb-2 font-medium">Failed</th>
                <th className="pb-2 font-medium">Duration</th>
              </tr>
            </thead>
            <tbody>
              {report.servers.map((srv) => (
                <tr key={srv.serverName} className="border-b border-zinc-800/50">
                  <td className="py-2 text-zinc-200">{srv.serverName}</td>
                  <td className="py-2">
                    {srv.score ? (
                      <ScoreCard {...srv.score} compact />
                    ) : (
                      <span className="text-zinc-600">N/A</span>
                    )}
                  </td>
                  <td className="py-2 text-emerald-400">{srv.score?.passed ?? 0}</td>
                  <td className="py-2 text-red-400">{(srv.score?.total ?? 0) - (srv.score?.passed ?? 0)}</td>
                  <td className="py-2 text-zinc-400">{(srv.durationMs / 1000).toFixed(1)}s</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function StatBox({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 text-center">
      <div className={`text-xl font-bold ${color ?? 'text-zinc-100'}`}>{value}</div>
      <div className="mt-0.5 text-xs text-zinc-500">{label}</div>
    </div>
  );
}
