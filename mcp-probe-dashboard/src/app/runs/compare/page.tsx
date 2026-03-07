'use client';

import { useState, useEffect, useCallback } from 'react';

interface RunEntry {
  runId: string;
  status: string;
  startedAt: number;
  report?: { timestamp?: string; servers?: Array<{ serverName: string; score?: { grade: string; percentage: number } }> };
}

interface CompareResult {
  regressions: Array<{ testId: string; testName: string; suiteName: string; serverName: string }>;
  improvements: Array<{ testId: string; testName: string; suiteName: string; serverName: string }>;
  newTests: Array<{ testId: string; testName: string; suiteName: string; serverName: string }>;
  removedTests: Array<{ testId: string; testName: string; suiteName: string; serverName: string }>;
  gradeChanges: Array<{ serverName: string; oldGrade: string; newGrade: string; oldPct: number; newPct: number }>;
  oldRunId: string;
  newRunId: string;
  oldTimestamp: string;
  newTimestamp: string;
}

export default function ComparePage() {
  const [runs, setRuns] = useState<RunEntry[]>([]);
  const [oldRunId, setOldRunId] = useState('');
  const [newRunId, setNewRunId] = useState('');
  const [result, setResult] = useState<CompareResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/runs')
      .then((r) => r.json())
      .then((data) => {
        const allRuns = Array.isArray(data) ? data : (data.runs ?? []);
        const completedRuns = allRuns.filter((r: RunEntry) => r.status === 'completed');
        setRuns(completedRuns);
        if (completedRuns.length >= 2) {
          setOldRunId(completedRuns[1].runId);
          setNewRunId(completedRuns[0].runId);
        }
      });
  }, []);

  const doCompare = useCallback(async () => {
    if (!oldRunId || !newRunId) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/runs/compare?old=${oldRunId}&new=${newRunId}`);
      if (!res.ok) {
        const body = await res.json();
        setError(body.error ?? 'Compare failed');
        return;
      }
      setResult(await res.json());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [oldRunId, newRunId]);

  const formatRunLabel = (run: RunEntry) => {
    const date = new Date(run.startedAt).toLocaleString();
    const grades = (run.report?.servers ?? [])
      .map((s) => s.score ? `${s.serverName}:${s.score.grade}` : '')
      .filter(Boolean)
      .join(', ');
    return `${run.runId.slice(0, 8)} — ${date}${grades ? ` (${grades})` : ''}`;
  };

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <h1 className="text-2xl font-bold text-zinc-100">Run Comparison</h1>
      <p className="mt-1 text-sm text-zinc-500">Compare two test runs to detect regressions and improvements</p>

      {/* Run selectors */}
      <div className="mt-6 flex items-end gap-4">
        <div className="flex-1">
          <label className="mb-1 block text-xs font-medium text-zinc-400">Baseline (Old)</label>
          <select
            value={oldRunId}
            onChange={(e) => setOldRunId(e.target.value)}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200"
          >
            <option value="">Select run...</option>
            {runs.map((r) => (
              <option key={r.runId} value={r.runId}>{formatRunLabel(r)}</option>
            ))}
          </select>
        </div>
        <div className="pb-2 text-zinc-500">vs</div>
        <div className="flex-1">
          <label className="mb-1 block text-xs font-medium text-zinc-400">New</label>
          <select
            value={newRunId}
            onChange={(e) => setNewRunId(e.target.value)}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200"
          >
            <option value="">Select run...</option>
            {runs.map((r) => (
              <option key={r.runId} value={r.runId}>{formatRunLabel(r)}</option>
            ))}
          </select>
        </div>
        <button
          onClick={doCompare}
          disabled={!oldRunId || !newRunId || loading}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
        >
          {loading ? 'Comparing...' : 'Compare'}
        </button>
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Results */}
      {result && (
        <div className="mt-8 space-y-6">
          {/* Grade Changes */}
          {result.gradeChanges.length > 0 && (
            <section>
              <h2 className="text-lg font-semibold text-zinc-200">Grade Changes</h2>
              <div className="mt-2 space-y-2">
                {result.gradeChanges.map((gc) => (
                  <div key={gc.serverName} className="flex items-center gap-3 rounded-lg border border-zinc-700/50 bg-zinc-900/50 px-4 py-3">
                    <span className="font-medium text-zinc-200">{gc.serverName}</span>
                    <span className={gc.oldPct > gc.newPct ? 'text-red-400' : 'text-emerald-400'}>
                      {gc.oldGrade} ({gc.oldPct}%) {gc.newPct >= gc.oldPct ? '\u2191' : '\u2193'} {gc.newGrade} ({gc.newPct}%)
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Regressions */}
          {result.regressions.length > 0 && (
            <section>
              <h2 className="flex items-center gap-2 text-lg font-semibold text-red-400">
                <span className="rounded-full bg-red-500/20 px-2 py-0.5 text-xs">{result.regressions.length}</span>
                Regressions
              </h2>
              <div className="mt-2 space-y-1">
                {result.regressions.map((r, i) => (
                  <div key={i} className="rounded border border-red-500/20 bg-red-500/5 px-3 py-2 text-sm text-red-400">
                    <span className="font-mono">{'\u2717'}</span>{' '}
                    {r.serverName} {'\u203A'} {r.suiteName} {'\u203A'} {r.testName}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Improvements */}
          {result.improvements.length > 0 && (
            <section>
              <h2 className="flex items-center gap-2 text-lg font-semibold text-emerald-400">
                <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-xs">{result.improvements.length}</span>
                Improvements
              </h2>
              <div className="mt-2 space-y-1">
                {result.improvements.map((r, i) => (
                  <div key={i} className="rounded border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-400">
                    <span className="font-mono">{'\u2713'}</span>{' '}
                    {r.serverName} {'\u203A'} {r.suiteName} {'\u203A'} {r.testName}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* New Tests */}
          {result.newTests.length > 0 && (
            <section>
              <h2 className="flex items-center gap-2 text-lg font-semibold text-blue-400">
                <span className="rounded-full bg-blue-500/20 px-2 py-0.5 text-xs">{result.newTests.length}</span>
                New Tests
              </h2>
              <div className="mt-2 space-y-1">
                {result.newTests.map((r, i) => (
                  <div key={i} className="rounded border border-blue-500/20 bg-blue-500/5 px-3 py-2 text-sm text-blue-400">
                    <span className="font-mono">+</span>{' '}
                    {r.serverName} {'\u203A'} {r.suiteName} {'\u203A'} {r.testName}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Removed Tests */}
          {result.removedTests.length > 0 && (
            <section>
              <h2 className="flex items-center gap-2 text-lg font-semibold text-zinc-400">
                <span className="rounded-full bg-zinc-500/20 px-2 py-0.5 text-xs">{result.removedTests.length}</span>
                Removed Tests
              </h2>
              <div className="mt-2 space-y-1">
                {result.removedTests.map((r, i) => (
                  <div key={i} className="rounded border border-zinc-700/30 bg-zinc-800/30 px-3 py-2 text-sm text-zinc-500">
                    <span className="font-mono">-</span>{' '}
                    {r.serverName} {'\u203A'} {r.suiteName} {'\u203A'} {r.testName}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Summary */}
          <div className="rounded-lg border border-zinc-700/50 bg-zinc-900/50 p-4">
            <h3 className="text-sm font-semibold text-zinc-300">Summary</h3>
            <div className="mt-2 grid grid-cols-4 gap-4 text-center text-sm">
              <div>
                <div className="text-xl font-bold text-red-400">{result.regressions.length}</div>
                <div className="text-zinc-500">Regressions</div>
              </div>
              <div>
                <div className="text-xl font-bold text-emerald-400">{result.improvements.length}</div>
                <div className="text-zinc-500">Improvements</div>
              </div>
              <div>
                <div className="text-xl font-bold text-blue-400">{result.newTests.length}</div>
                <div className="text-zinc-500">New</div>
              </div>
              <div>
                <div className="text-xl font-bold text-zinc-400">{result.removedTests.length}</div>
                <div className="text-zinc-500">Removed</div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
