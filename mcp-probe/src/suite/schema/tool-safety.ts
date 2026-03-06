/**
 * Tool Safety Classifier — 3-layer classification per architect review.
 *
 * Annotations are UNTRUSTED per spec. We use:
 * 1. Config override (authoritative, from user)
 * 2. Name-based heuristics (conservative)
 * 3. Annotation hint (unreliable, from server)
 *
 * Default posture: uncertain → treat as write
 */
import type { DiscoveredTool } from '../../client/mcp-client.js';
import type { ToolSafetyOverride } from '../../config/schema.js';

export type ToolSafetyClass = 'read' | 'write' | 'unknown';

// Name patterns that strongly suggest write operations
const WRITE_NAME_PATTERNS = [
  /^(create|delete|remove|drop|truncate|purge|write|update|insert|modify|set|add|put|post|patch|send|upload|push|move|rename|replace|destroy|kill|terminate|revoke|reset)/i,
  /(create|delete|remove|drop|write|update|insert|send|upload|push|destroy|kill|terminate)$/i,
];

// Name patterns that suggest read operations
const READ_NAME_PATTERNS = [
  /^(get|list|read|fetch|search|find|query|lookup|check|show|describe|inspect|count|exists|verify|validate|status|info|help|echo|ping|health|version)/i,
  /(get|list|read|fetch|search|find|query|lookup|status|info)$/i,
];

export function classifyToolSafety(
  tool: DiscoveredTool,
  overrides?: ToolSafetyOverride,
): ToolSafetyClass {
  // Layer 1: Config override (highest priority)
  if (overrides) {
    if (overrides.readOnly.includes(tool.name)) return 'read';
    if (overrides.write.includes(tool.name)) return 'write';
  }

  // Layer 2: Name-based heuristics
  for (const pattern of WRITE_NAME_PATTERNS) {
    if (pattern.test(tool.name)) return 'write';
  }
  for (const pattern of READ_NAME_PATTERNS) {
    if (pattern.test(tool.name)) return 'read';
  }

  // Layer 3: Annotation hint (untrusted — used only as tiebreaker)
  if (tool.annotations) {
    if (tool.annotations.readOnlyHint === true) return 'read';
    if (tool.annotations.destructiveHint === true) return 'write';
  }

  // Default: uncertain → write (conservative)
  return 'write';
}

/**
 * Determine if a tool is safe to fuzz with actual execution.
 */
export function isSafeToFuzz(
  tool: DiscoveredTool,
  overrides?: ToolSafetyOverride,
  allowWriteFuzzing = false,
): boolean {
  if (allowWriteFuzzing) return true;
  const safety = classifyToolSafety(tool, overrides);
  return safety === 'read';
}
