'use client';

import { useState } from 'react';
import { sanitizeMetadata } from '@/lib/mask-utils';

interface AssertionResult {
  passed: boolean;
  name: string;
  message: string;
  expected?: unknown;
  actual?: unknown;
  severity: 'error' | 'warning' | 'info';
}

interface TestResult {
  testId: string;
  testName: string;
  suiteName: string;
  status: 'passed' | 'failed' | 'skipped' | 'errored';
  durationMs: number;
  assertions: AssertionResult[];
  error?: { message: string; stack?: string };
  metadata?: Record<string, unknown>;
}

interface SuiteResult {
  suiteName: string;
  serverName: string;
  durationMs: number;
  tests: TestResult[];
  passed: number;
  failed: number;
  skipped: number;
  errored: number;
}

interface ServerReport {
  serverName: string;
  durationMs: number;
  connected: boolean;
  connectionError: string | null;
  suites: SuiteResult[];
  score: { grade: string; percentage: number; passed: number; total: number } | null;
}

const STATUS_ICONS: Record<string, string> = {
  passed: '\u2713',
  failed: '\u2717',
  skipped: '\u2014',
  errored: '\u26A0',
};

const STATUS_COLORS: Record<string, string> = {
  passed: 'text-emerald-400',
  failed: 'text-red-400',
  skipped: 'text-zinc-500',
  errored: 'text-orange-400',
};

const SEVERITY_COLORS: Record<string, string> = {
  error: 'text-red-400',
  warning: 'text-yellow-400',
  info: 'text-zinc-400',
};

const SUITE_BADGES: Record<string, { label: string; color: string }> = {
  security: { label: '\uD83D\uDD12 Security', color: 'bg-red-500/20 text-red-400 border-red-500/30' },
  performance: { label: '\u26A1 Performance', color: 'bg-blue-500/20 text-blue-400 border-blue-500/30' },
  'ai-evaluation': { label: '\uD83E\uDD16 AI Eval', color: 'bg-purple-500/20 text-purple-400 border-purple-500/30' },
  workflow: { label: '\uD83D\uDD04 Workflow', color: 'bg-teal-500/20 text-teal-400 border-teal-500/30' },
};

interface TestResultTreeProps {
  servers: ServerReport[];
  filterStatus?: string;
}

export default function TestResultTree({ servers, filterStatus }: TestResultTreeProps) {
  return (
    <div className="space-y-4">
      {servers.map((server) => (
        <ServerNode key={server.serverName} server={server} filterStatus={filterStatus} />
      ))}
    </div>
  );
}

function ServerNode({ server, filterStatus }: { server: ServerReport; filterStatus?: string }) {
  const [open, setOpen] = useState(true);

  if (!server.connected) {
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4">
        <div className="font-semibold text-red-400">{server.serverName}</div>
        <div className="mt-1 text-sm text-red-400/70">Connection failed: {server.connectionError}</div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-zinc-700/50 bg-zinc-900/50">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between p-4 text-left hover:bg-zinc-800/50"
      >
        <div className="flex items-center gap-3">
          <span className="text-zinc-400">{open ? '\u25BC' : '\u25B6'}</span>
          <span className="font-semibold text-zinc-100">{server.serverName}</span>
          {server.score && (
            <span className={`rounded px-1.5 py-0.5 text-xs font-bold ${
              server.score.grade === 'A' ? 'bg-emerald-400/20 text-emerald-400' :
              server.score.grade === 'B' ? 'bg-blue-400/20 text-blue-400' :
              server.score.grade === 'F' ? 'bg-red-400/20 text-red-400' :
              'bg-yellow-400/20 text-yellow-400'
            }`}>
              {server.score.grade} ({server.score.percentage}%)
            </span>
          )}
        </div>
        <span className="text-xs text-zinc-500">{(server.durationMs / 1000).toFixed(1)}s</span>
      </button>
      {open && (
        <div className="border-t border-zinc-800 px-4 pb-4">
          {server.suites.map((suite) => (
            <SuiteNode key={suite.suiteName} suite={suite} filterStatus={filterStatus} />
          ))}
        </div>
      )}
    </div>
  );
}

function SuiteNode({ suite, filterStatus }: { suite: SuiteResult; filterStatus?: string }) {
  const [open, setOpen] = useState(true);
  const filtered = filterStatus ? suite.tests.filter((t) => t.status === filterStatus) : suite.tests;
  if (filtered.length === 0) return null;

  return (
    <div className="mt-3">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 text-left text-sm"
      >
        <span className="text-zinc-500">{open ? '\u25BC' : '\u25B6'}</span>
        <span className="font-medium text-zinc-300">{suite.suiteName}</span>
        {SUITE_BADGES[suite.suiteName] && (
          <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${SUITE_BADGES[suite.suiteName].color}`}>
            {SUITE_BADGES[suite.suiteName].label}
          </span>
        )}
        <span className="text-xs text-zinc-600">
          {suite.passed}p / {suite.failed}f / {suite.skipped}s
        </span>
      </button>
      {open && (
        <div className="ml-4 mt-1 space-y-1">
          {filtered.map((test) => (
            <TestNode key={test.testId} test={test} />
          ))}
        </div>
      )}
    </div>
  );
}

function TestNode({ test }: { test: TestResult }) {
  const [open, setOpen] = useState(false);

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-zinc-800/50"
      >
        <span className={`font-mono ${STATUS_COLORS[test.status]}`}>
          {STATUS_ICONS[test.status]}
        </span>
        <span className="flex-1 text-zinc-300">{test.testName}</span>
        {test.suiteName === 'security' && test.status === 'failed' && (
          <span className="rounded-full bg-red-500/20 px-2 py-0.5 text-[10px] font-bold text-red-400">
            VULNERABILITY
          </span>
        )}
        {test.suiteName === 'performance' && test.metadata?.rps !== undefined && (
          <span className="rounded-full bg-blue-500/15 px-2 py-0.5 text-[10px] text-blue-400">
            {String(test.metadata.rps)} RPS
          </span>
        )}
        {test.suiteName === 'workflow' && (test.metadata as Record<string, unknown>)?.actual ? (
          <span className="rounded-full bg-teal-500/15 px-2 py-0.5 text-[10px] text-teal-400">
            {String(((test.metadata as Record<string, unknown>).actual as Record<string, unknown>)?.stepsExecuted ?? '?')}/{String(((test.metadata as Record<string, unknown>).actual as Record<string, unknown>)?.stepCount ?? '?')} steps
          </span>
        ) : null}
        <span className="text-xs text-zinc-600">{test.durationMs}ms</span>
      </button>
      {open && (
        <div className="ml-8 mt-1 space-y-1">
          {test.assertions.map((a, i) => (
            <div key={i} className={`flex items-start gap-2 text-xs ${SEVERITY_COLORS[a.severity]}`}>
              <span className="mt-0.5 font-mono">{a.passed ? '\u2713' : '\u2717'}</span>
              <div>
                <span>{a.message}</span>
                {!a.passed && a.expected !== undefined && (
                  <div className="mt-0.5 text-zinc-500">
                    Expected: {JSON.stringify(a.expected)} | Got: {JSON.stringify(a.actual)}
                  </div>
                )}
              </div>
            </div>
          ))}
          {test.error && (
            <div className="mt-1 rounded bg-red-500/10 px-2 py-1 text-xs text-red-400">
              {test.error.message}
            </div>
          )}
          {test.metadata && Object.keys(test.metadata).length > 0 && (
            <TestDetailPanel metadata={test.metadata} />
          )}
        </div>
      )}
    </div>
  );
}

function TestDetailPanel({ metadata }: { metadata: Record<string, unknown> }) {
  const hasLLM = metadata.llm !== undefined;
  const hasFindings = metadata.findings !== undefined || metadata.leaksFound !== undefined;
  const baseTabs: string[] = ['input', 'expected', 'actual'];
  if (hasFindings) baseTabs.push('findings');
  if (hasLLM) baseTabs.push('llm');
  const allTabs = baseTabs;
  const [activeTab, setActiveTab] = useState<string>('input');

  return (
    <div className="mt-2 rounded border border-zinc-700/50 bg-zinc-900/80">
      <div className="flex items-center border-b border-zinc-700/50">
        {allTabs.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-3 py-1.5 text-xs font-medium capitalize ${
              activeTab === tab
                ? 'border-b-2 border-blue-400 text-blue-400'
                : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {tab === 'llm' ? '\uD83E\uDD16 LLM' : tab === 'findings' ? '\uD83D\uDD12 Findings' : tab}
          </button>
        ))}
        {/* Token usage badge for AI tests */}
        {hasLLM && (metadata.llm as Record<string, unknown>)?.tokensUsed != null && (
          <span className="ml-auto mr-3 rounded-full bg-purple-500/15 px-2 py-0.5 text-[10px] text-purple-400">
            {String((metadata.llm as Record<string, unknown>).tokensUsed)} tokens
          </span>
        )}
      </div>
      <div className="max-h-64 overflow-auto p-3">
        {activeTab === 'findings' ? (
          <FindingsBlock findings={metadata.findings ?? metadata.leaksFound} />
        ) : (
          <JsonBlock data={sanitizeMetadata(metadata[activeTab])} />
        )}
      </div>
    </div>
  );
}

const FINDING_SEVERITY_COLORS: Record<string, string> = {
  critical: 'bg-red-500/20 text-red-400 border-red-500/40',
  high: 'bg-orange-500/20 text-orange-400 border-orange-500/40',
  medium: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/40',
  low: 'bg-blue-500/20 text-blue-400 border-blue-500/40',
  info: 'bg-zinc-500/20 text-zinc-400 border-zinc-500/40',
};

function FindingsBlock({ findings }: { findings: unknown }) {
  if (!findings || !Array.isArray(findings) || findings.length === 0) {
    return <span className="text-xs italic text-emerald-400">No security findings</span>;
  }

  return (
    <div className="space-y-2">
      {findings.map((f: Record<string, unknown>, i: number) => {
        const severity = String(f.severity ?? 'info');
        const colorClass = FINDING_SEVERITY_COLORS[severity] ?? FINDING_SEVERITY_COLORS.info;
        return (
          <div key={i} className={`rounded border px-3 py-2 text-xs ${colorClass}`}>
            <div className="flex items-center gap-2">
              <span className="rounded-full border px-1.5 py-0.5 text-[10px] font-bold uppercase">
                {severity}
              </span>
              <span className="font-medium">{String(f.label ?? f.category ?? 'Finding')}</span>
            </div>
            {f.match ? (
              <div className="mt-1 font-mono text-[10px] opacity-75">Match: {String(f.match)}</div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function JsonBlock({ data }: { data: unknown }) {
  if (data === undefined || data === null) {
    return <span className="text-xs italic text-zinc-500">No data</span>;
  }
  return (
    <pre className="whitespace-pre-wrap break-all font-mono text-xs text-zinc-300">
      {typeof data === 'string' ? data : JSON.stringify(data, null, 2)}
    </pre>
  );
}
