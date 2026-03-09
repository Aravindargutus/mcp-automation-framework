/**
 * Module Selector — picks a representative module for testing.
 *
 * When no modules filter is specified, instead of running ALL modules
 * (redundant since tools are shared), selects ONE module that covers
 * the most tools with full CRUD lifecycle.
 *
 * Two strategies:
 *   A. Deterministic — score by CRUD completeness (always available)
 *   B. LLM-powered — ask the LLM to pick the best module (opt-in)
 */
import { LLMClient } from './client.js';
import type { LLMJudgeConfig } from '../config/schema.js';
import type { EntityGroup } from '../suite/workflow/types.js';
import type { ChatMessage } from './types.js';

export interface ModuleSelectionResult {
  selectedModule: string;
  reasoning: string;
  confidence: number;
}

/**
 * LLM-powered module selector. Uses the LLM to analyze entity groups
 * and pick the best one for comprehensive testing.
 */
export class LLMModuleSelector {
  private client: LLMClient;

  constructor(config: LLMJudgeConfig) {
    this.client = new LLMClient(config);
  }

  async selectModule(
    entityGroups: EntityGroup[],
    productName: string,
  ): Promise<ModuleSelectionResult> {
    const summary = entityGroups.map((g) => ({
      name: g.entityName,
      createTools: g.create.length,
      readTools: g.read.length,
      updateTools: g.update.length,
      deleteTools: g.delete.length,
      searchTools: g.search.length,
      otherTools: g.other.length,
      totalTools: g.create.length + g.read.length + g.update.length +
                  g.delete.length + g.search.length + g.other.length,
    }));

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `You are an MCP server testing expert. Given a list of modules/entities with their available CRUD tool counts, select the ONE best module for comprehensive testing.

Selection criteria (in priority order):
1. Must have create + read + update + delete (full lifecycle) if possible
2. Prefer modules with search tools
3. Prefer modules with more total tools (tests more functionality)
4. Prefer well-known entity names (e.g., Leads > Custom_Module_1)

Respond ONLY with JSON: { "selectedModule": "exact_module_name", "reasoning": "brief explanation", "confidence": 0.0-1.0 }`,
      },
      {
        role: 'user',
        content: `Product: ${productName}\n\nAvailable modules:\n${JSON.stringify(summary, null, 2)}`,
      },
    ];

    const result = await this.client.chatJSON<ModuleSelectionResult>(messages, {
      maxTokens: 256,
      temperature: 0.1,
    });

    return result.data;
  }
}

/**
 * Deterministic module selector — picks the module with the best CRUD coverage.
 * No LLM needed. Used when LLM is disabled or as fallback.
 */
export function selectModuleDeterministic(entityGroups: EntityGroup[]): string | null {
  if (entityGroups.length === 0) return null;
  if (entityGroups.length === 1) return entityGroups[0].entityName;

  const scored = entityGroups.map((g) => {
    let score = 0;
    // Full CRUD lifecycle is most important
    if (g.create.length > 0) score += 10;
    if (g.read.length > 0) score += 5;
    if (g.update.length > 0) score += 5;
    if (g.delete.length > 0) score += 10;
    if (g.search.length > 0) score += 3;
    // More tools = more test coverage
    score += g.create.length + g.read.length + g.update.length +
             g.delete.length + g.search.length + g.other.length;
    return { entityName: g.entityName, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0].entityName;
}
