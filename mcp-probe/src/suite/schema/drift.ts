/**
 * Schema Drift Detector — compares current schema against a saved baseline.
 *
 * Reports:
 * - New tools/resources/prompts added
 * - Removed tools/resources/prompts
 * - Changed schemas (inputSchema, outputSchema differences)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DiscoveredServer, DiscoveredTool } from '../../client/mcp-client.js';

export interface DriftChange {
  type: 'added' | 'removed' | 'changed';
  primitive: 'tool' | 'resource' | 'prompt';
  name: string;
  details?: string;
  before?: unknown;
  after?: unknown;
}

export interface DriftReport {
  hasChanges: boolean;
  changes: DriftChange[];
  baselineTimestamp: string | null;
  currentTimestamp: string;
}

interface BaselineSnapshot {
  timestamp: string;
  serverName: string;
  protocolVersion: string;
  tools: Array<{ name: string; inputSchema: unknown; outputSchema?: unknown }>;
  resources: Array<{ uri: string; name: string; mimeType?: string }>;
  prompts: Array<{ name: string; arguments?: unknown[] }>;
}

/**
 * Compare current discovered state against a saved baseline.
 */
export function detectDrift(
  discovered: DiscoveredServer,
  baselinePath: string,
): DriftReport {
  const current = snapshotFromDiscovered(discovered);
  const now = new Date().toISOString();

  if (!existsSync(baselinePath)) {
    return {
      hasChanges: false,
      changes: [],
      baselineTimestamp: null,
      currentTimestamp: now,
    };
  }

  let baseline: BaselineSnapshot;
  try {
    baseline = JSON.parse(readFileSync(baselinePath, 'utf-8'));
  } catch {
    return {
      hasChanges: false,
      changes: [],
      baselineTimestamp: null,
      currentTimestamp: now,
    };
  }

  const changes: DriftChange[] = [];

  // --- Tools ---
  const baselineToolNames = new Set(baseline.tools.map((t) => t.name));
  const currentToolNames = new Set(current.tools.map((t) => t.name));

  for (const tool of current.tools) {
    if (!baselineToolNames.has(tool.name)) {
      changes.push({ type: 'added', primitive: 'tool', name: tool.name });
    }
  }

  for (const tool of baseline.tools) {
    if (!currentToolNames.has(tool.name)) {
      changes.push({ type: 'removed', primitive: 'tool', name: tool.name });
    }
  }

  // Check for schema changes in existing tools
  for (const currentTool of current.tools) {
    const baselineTool = baseline.tools.find((t) => t.name === currentTool.name);
    if (baselineTool) {
      const beforeSchema = JSON.stringify(baselineTool.inputSchema);
      const afterSchema = JSON.stringify(currentTool.inputSchema);
      if (beforeSchema !== afterSchema) {
        changes.push({
          type: 'changed',
          primitive: 'tool',
          name: currentTool.name,
          details: 'inputSchema changed',
          before: baselineTool.inputSchema,
          after: currentTool.inputSchema,
        });
      }
    }
  }

  // --- Resources ---
  const baselineResourceUris = new Set(baseline.resources.map((r) => r.uri));
  const currentResourceUris = new Set(current.resources.map((r) => r.uri));

  for (const res of current.resources) {
    if (!baselineResourceUris.has(res.uri)) {
      changes.push({ type: 'added', primitive: 'resource', name: res.name || res.uri });
    }
  }
  for (const res of baseline.resources) {
    if (!currentResourceUris.has(res.uri)) {
      changes.push({ type: 'removed', primitive: 'resource', name: res.name || res.uri });
    }
  }

  // --- Prompts ---
  const baselinePromptNames = new Set(baseline.prompts.map((p) => p.name));
  const currentPromptNames = new Set(current.prompts.map((p) => p.name));

  for (const prompt of current.prompts) {
    if (!baselinePromptNames.has(prompt.name)) {
      changes.push({ type: 'added', primitive: 'prompt', name: prompt.name });
    }
  }
  for (const prompt of baseline.prompts) {
    if (!currentPromptNames.has(prompt.name)) {
      changes.push({ type: 'removed', primitive: 'prompt', name: prompt.name });
    }
  }

  return {
    hasChanges: changes.length > 0,
    changes,
    baselineTimestamp: baseline.timestamp,
    currentTimestamp: now,
  };
}

/**
 * Save current discovered state as the new baseline.
 */
export function saveBaseline(discovered: DiscoveredServer, baselinePath: string): void {
  const snapshot = snapshotFromDiscovered(discovered);
  const dir = dirname(baselinePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(baselinePath, JSON.stringify(snapshot, null, 2));
}

function snapshotFromDiscovered(discovered: DiscoveredServer): BaselineSnapshot {
  return {
    timestamp: new Date().toISOString(),
    serverName: discovered.serverInfo.name,
    protocolVersion: discovered.protocolVersion,
    tools: discovered.tools.map((t: DiscoveredTool) => ({
      name: t.name,
      inputSchema: t.inputSchema,
      outputSchema: t.outputSchema,
    })),
    resources: discovered.resources.map((r) => ({
      uri: r.uri,
      name: r.name,
      mimeType: r.mimeType,
    })),
    prompts: discovered.prompts.map((p) => ({
      name: p.name,
      arguments: p.arguments,
    })),
  };
}
