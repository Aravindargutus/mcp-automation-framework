/**
 * Report schema — versioned public API.
 *
 * This is the contract with CI integrations, dashboards, and downstream tooling.
 * Bump schemaVersion on breaking changes.
 */
import type { SuiteResult } from '../plugin/types.js';

export interface MCPProbeReport {
  schemaVersion: '1.0';
  runId: string;
  timestamp: string;
  duration: number;
  config: ReportConfig;
  servers: ServerReport[];
}

export interface ReportConfig {
  serverCount: number;
  suites: string[];
}

export interface ServerReport {
  serverName: string;
  durationMs: number;
  connected: boolean;
  connectionError: string | null;
  discovered: DiscoveredSummary | null;
  suites: SuiteResult[];
  score: ScoreCard | null;
}

export interface DiscoveredSummary {
  serverInfo: { name: string; version: string };
  protocolVersion: string;
  toolCount: number;
  resourceCount: number;
  promptCount: number;
}

export interface ScoreCard {
  percentage: number;
  grade: string;
  passed: number;
  total: number;
}
