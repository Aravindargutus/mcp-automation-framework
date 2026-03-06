'use client';

import { useEffect, useState, useRef } from 'react';

interface ProgressEvent {
  type: string;
  timestamp: number;
  data: Record<string, unknown>;
}

interface LiveProgressProps {
  runId: string;
  onComplete?: () => void;
}

export default function LiveProgress({ runId, onComplete }: LiveProgressProps) {
  const [events, setEvents] = useState<ProgressEvent[]>([]);
  const [currentServer, setCurrentServer] = useState<string>('');
  const [currentSuite, setCurrentSuite] = useState<string>('');
  const [currentTest, setCurrentTest] = useState<string>('');
  const [stats, setStats] = useState({ total: 0, passed: 0, failed: 0 });
  const [done, setDone] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const es = new EventSource(`/api/runs/${runId}/stream`);

    es.onmessage = (e) => {
      try {
        const evt: ProgressEvent = JSON.parse(e.data);
        setEvents((prev) => [...prev.slice(-100), evt]);

        const d = evt.data;
        switch (evt.type) {
          case 'server:start':
            setCurrentServer(d.serverName as string);
            setCurrentSuite('');
            setCurrentTest('');
            break;
          case 'suite:start':
            setCurrentSuite(d.suiteName as string);
            setCurrentTest('');
            break;
          case 'test:start':
            setCurrentTest(d.testName as string);
            break;
          case 'test:end': {
            const status = (d as Record<string, unknown>).status as string;
            setStats((prev) => ({
              total: prev.total + 1,
              passed: prev.passed + (status === 'passed' ? 1 : 0),
              failed: prev.failed + (status === 'failed' ? 1 : 0),
            }));
            break;
          }
          case 'run:end':
            setDone(true);
            es.close();
            onComplete?.();
            break;
        }
      } catch {
        // Ignore malformed events
      }
    };

    es.onerror = () => {
      setDone(true);
      es.close();
    };

    return () => es.close();
  }, [runId, onComplete]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [events]);

  const pct = stats.total > 0 ? Math.round((stats.passed / stats.total) * 100) : 0;

  return (
    <div className="space-y-4">
      {/* Status bar */}
      <div className="flex items-center gap-4">
        {!done && (
          <div className="flex items-center gap-2">
            <div className="h-2 w-2 animate-pulse rounded-full bg-blue-400" />
            <span className="text-sm text-blue-400">Running</span>
          </div>
        )}
        {done && (
          <div className="flex items-center gap-2">
            <div className="h-2 w-2 rounded-full bg-emerald-400" />
            <span className="text-sm text-emerald-400">Complete</span>
          </div>
        )}
        <div className="flex-1" />
        <div className="flex gap-4 text-sm">
          <span className="text-emerald-400">{stats.passed} passed</span>
          <span className="text-red-400">{stats.failed} failed</span>
          <span className="text-zinc-400">{stats.total} total</span>
        </div>
      </div>

      {/* Progress bar */}
      <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
        <div
          className="h-full rounded-full bg-gradient-to-r from-blue-500 to-emerald-500 transition-all duration-300"
          style={{ width: `${done ? 100 : Math.min(pct, 95)}%` }}
        />
      </div>

      {/* Current activity */}
      {!done && (
        <div className="flex gap-6 text-xs text-zinc-400">
          {currentServer && <span>Server: <span className="text-zinc-200">{currentServer}</span></span>}
          {currentSuite && <span>Suite: <span className="text-zinc-200">{currentSuite}</span></span>}
          {currentTest && <span>Test: <span className="text-zinc-200 truncate max-w-[300px] inline-block align-bottom">{currentTest}</span></span>}
        </div>
      )}

      {/* Event log */}
      <div
        ref={logRef}
        className="h-48 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-xs"
      >
        {events.map((evt, i) => (
          <div key={i} className="flex gap-2">
            <span className="text-zinc-600 shrink-0">
              {new Date(evt.timestamp).toLocaleTimeString()}
            </span>
            <EventLine event={evt} />
          </div>
        ))}
        {events.length === 0 && (
          <div className="text-zinc-600">Waiting for events...</div>
        )}
      </div>
    </div>
  );
}

function EventLine({ event }: { event: ProgressEvent }) {
  const d = event.data;
  switch (event.type) {
    case 'server:start':
      return <span className="text-blue-400">Testing server: {d.serverName as string}</span>;
    case 'server:end':
      return <span className="text-blue-300">Server done: {d.serverName as string}</span>;
    case 'suite:start':
      return <span className="text-zinc-400">Suite: {d.suiteName as string} ({d.testCount as number} tests)</span>;
    case 'suite:end':
      return <span className="text-zinc-300">Suite done: {d.suiteName as string}</span>;
    case 'test:start':
      return <span className="text-zinc-500">{d.testName as string}</span>;
    case 'test:end': {
      const status = (d as Record<string, unknown>).status as string;
      const color = status === 'passed' ? 'text-emerald-400' : status === 'failed' ? 'text-red-400' : 'text-zinc-400';
      return <span className={color}>{status === 'passed' ? '\u2713' : '\u2717'} {(d as Record<string, unknown>).testName as string}</span>;
    }
    case 'run:end':
      return <span className="text-emerald-300 font-bold">Run complete</span>;
    default:
      return <span className="text-zinc-600">{event.type}</span>;
  }
}
