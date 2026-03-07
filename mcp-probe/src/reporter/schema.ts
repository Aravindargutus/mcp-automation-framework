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

// --- Security Findings ---
export interface SecurityFinding {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  category: 'prompt-injection' | 'credential-exposure' | 'tool-poisoning' | 'input-sanitization' | 'auth' | 'info-disclosure';
  tool: string;
  description: string;
  evidence?: string;
  remediation?: string;
}

// --- Performance Data ---
export interface PerformanceData {
  goldenSignals: {
    latency: { p50Ms: number; p95Ms: number; p99Ms: number };
    traffic: { rps: number };
    errors: { rate: number };
    saturation: { degradationPoint: number | null };
  };
  perTool: Array<{
    toolName: string;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    meanMs: number;
  }>;
}
