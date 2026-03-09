/**
 * In-memory store for agentic runs — parallel to run-store.ts.
 * Persists completed runs to data/agentic-runs.json.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

export interface AgenticRunEntry {
  runId: string;
  serverName: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
  result?: unknown;
  progress?: {
    totalProducts: number;
    completedProducts: number;
    totalEntities: number;
    completedEntities: number;
    passedSteps: number;
    failedSteps: number;
    totalSteps: number;
  };
}

const DATA_DIR = join(process.cwd(), 'src', 'data');
const RUNS_FILE = join(DATA_DIR, 'agentic-runs.json');

// Use globalThis to survive Next.js HMR re-evaluations in dev mode
const g = globalThis as unknown as { __agenticRuns?: Map<string, AgenticRunEntry> };

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function loadPersistedRuns(target: Map<string, AgenticRunEntry>): void {
  ensureDataDir();
  if (existsSync(RUNS_FILE)) {
    try {
      const data = JSON.parse(readFileSync(RUNS_FILE, 'utf-8'));
      for (const entry of data) {
        if (!target.has(entry.runId)) {
          target.set(entry.runId, entry);
        }
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
    .slice(-50);
  writeFileSync(RUNS_FILE, JSON.stringify(completed, null, 2));
}

if (!g.__agenticRuns) {
  g.__agenticRuns = new Map();
  loadPersistedRuns(g.__agenticRuns);
}
const runs = g.__agenticRuns;

export function createAgenticRun(runId: string, serverName: string): AgenticRunEntry {
  const entry: AgenticRunEntry = {
    runId,
    serverName,
    status: 'running',
    startedAt: new Date().toISOString(),
    progress: {
      totalProducts: 0,
      completedProducts: 0,
      totalEntities: 0,
      completedEntities: 0,
      passedSteps: 0,
      failedSteps: 0,
      totalSteps: 0,
    },
  };
  runs.set(runId, entry);
  return entry;
}

export function updateAgenticProgress(
  runId: string,
  update: Partial<NonNullable<AgenticRunEntry['progress']>>,
): void {
  const entry = runs.get(runId);
  if (entry?.progress) {
    const p = entry.progress;
    if (update.totalProducts !== undefined) p.totalProducts = update.totalProducts;
    if (update.completedProducts) p.completedProducts += update.completedProducts;
    if (update.totalEntities !== undefined) p.totalEntities = update.totalEntities;
    if (update.completedEntities) p.completedEntities += update.completedEntities;
    if (update.passedSteps) p.passedSteps += update.passedSteps;
    if (update.failedSteps) p.failedSteps += update.failedSteps;
    if (update.totalSteps) p.totalSteps += update.totalSteps;
  }
}

export function completeAgenticRun(runId: string, result: unknown): void {
  const entry = runs.get(runId);
  if (entry) {
    entry.status = 'completed';
    entry.completedAt = new Date().toISOString();
    entry.result = result;
    persistRuns();
  }
}

export function failAgenticRun(runId: string, error: string): void {
  const entry = runs.get(runId);
  if (entry) {
    entry.status = 'failed';
    entry.completedAt = new Date().toISOString();
    persistRuns();
  }
}

export function getAgenticRun(runId: string): AgenticRunEntry | undefined {
  return runs.get(runId);
}

export function listAgenticRuns(): AgenticRunEntry[] {
  return Array.from(runs.values()).sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  );
}
