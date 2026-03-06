/**
 * In-memory store for active and completed runs.
 * Persists completed runs to data/runs.json.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

interface MCPProbeReport {
  schemaVersion: string;
  runId: string;
  timestamp: string;
  duration: number;
  config: { serverCount: number; suites: string[] };
  servers: unknown[];
}

export interface RunEntry {
  runId: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
  report?: MCPProbeReport;
  progress?: {
    totalServers: number;
    completedServers: number;
    totalTests: number;
    passedTests: number;
    failedTests: number;
  };
}

const DATA_DIR = join(process.cwd(), 'src', 'data');
const RUNS_FILE = join(DATA_DIR, 'runs.json');

// In-memory store
const runs = new Map<string, RunEntry>();

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function loadPersistedRuns(): void {
  ensureDataDir();
  if (existsSync(RUNS_FILE)) {
    try {
      const data = JSON.parse(readFileSync(RUNS_FILE, 'utf-8'));
      for (const entry of data) {
        runs.set(entry.runId, entry);
      }
    } catch {
      // Corrupted file — start fresh
    }
  }
}

function persistRuns(): void {
  ensureDataDir();
  const completed = Array.from(runs.values())
    .filter((r) => r.status !== 'running')
    .slice(-50); // Keep last 50 runs
  writeFileSync(RUNS_FILE, JSON.stringify(completed, null, 2));
}

// Load on module init
loadPersistedRuns();

export function createRun(runId: string, totalServers: number): RunEntry {
  const entry: RunEntry = {
    runId,
    status: 'running',
    startedAt: new Date().toISOString(),
    progress: {
      totalServers,
      completedServers: 0,
      totalTests: 0,
      passedTests: 0,
      failedTests: 0,
    },
  };
  runs.set(runId, entry);
  return entry;
}

export function updateRunProgress(
  runId: string,
  update: Partial<NonNullable<RunEntry['progress']>>,
): void {
  const entry = runs.get(runId);
  if (entry?.progress) {
    const p = entry.progress;
    if (update.completedServers) p.completedServers += update.completedServers;
    if (update.totalTests) p.totalTests += update.totalTests;
    if (update.passedTests) p.passedTests += update.passedTests;
    if (update.failedTests) p.failedTests += update.failedTests;
  }
}

export function completeRun(runId: string, report: MCPProbeReport): void {
  const entry = runs.get(runId);
  if (entry) {
    entry.status = 'completed';
    entry.completedAt = new Date().toISOString();
    entry.report = report;
    persistRuns();
  }
}

export function failRun(runId: string, error: string): void {
  const entry = runs.get(runId);
  if (entry) {
    entry.status = 'failed';
    entry.completedAt = new Date().toISOString();
    persistRuns();
  }
}

export function getRun(runId: string): RunEntry | undefined {
  return runs.get(runId);
}

export function listRuns(): RunEntry[] {
  return Array.from(runs.values()).sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  );
}
