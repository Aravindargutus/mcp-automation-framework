/**
 * AI Evaluation Suite — LLM-powered semantic evaluation of MCP tools.
 *
 * This suite is OPTIONAL. It only runs when:
 *   1. LLMJudgeConfig is provided with `enabled: true`
 *   2. The server has at least one tool to evaluate
 *
 * Eight test categories:
 *
 * Per-tool isolation:
 *   - arg-generation: LLM generates realistic args → calls tool → validates response
 *   - description-quality: LLM rates tool description quality 1-10
 *   - response-validation: LLM detects hidden failures in existing test responses
 *   - discoverability: LLM evaluates tool set naming and organization
 *
 * Agentic (tool composition — simulates AI IDE workflows):
 *   - tool-selection: LLM routes user tasks to the correct tool(s)
 *   - workflow-chaining: multi-step workflow with output→input data flow
 *   - scenario-execution: end-to-end scenario solved by a mini agent loop
 *   - agentic-loop: autonomous exploration loop testing breadth and recovery
 *
 * The LLM client is created in generateTests() and validated in setup().
 * Test closures capture the client instance via closure scope.
 */
import type { DiscoveredServer } from '../../client/mcp-client.js';
import type { LLMJudgeConfig, ServerConfig } from '../../config/schema.js';
import { LLMClient } from '../../llm/client.js';
import type { TestCase, TestRunContext, TestSuite } from '../types.js';
import { generateArgGenerationTests } from './arg-generation.js';
import { generateDescriptionQualityTests } from './description-quality.js';
import { generateDiscoverabilityTests } from './discoverability.js';
import { generateResponseValidationTests } from './response-validation.js';
// Agentic tests
import { generateToolSelectionTests } from './tool-selection.js';
import { generateWorkflowChainingTests } from './workflow-chaining.js';
import { generateScenarioExecutionTests } from './scenario-execution.js';
import { generateAgenticLoopTests } from './agentic-loop.js';

export class AIEvaluationSuite implements TestSuite {
  name = 'ai-evaluation';
  description = 'LLM-powered semantic evaluation: per-tool quality checks and agentic workflow testing';
  tags = ['ai-evaluation', 'llm', 'agentic'];

  private llmConfig: LLMJudgeConfig | undefined;
  private llmClient: LLMClient | null = null;

  constructor(llmConfig?: LLMJudgeConfig) {
    this.llmConfig = llmConfig;
  }

  isApplicable(discovered: DiscoveredServer): boolean {
    return !!this.llmConfig?.enabled && discovered.tools.length > 0;
  }

  generateTests(discovered: DiscoveredServer, _serverConfig: ServerConfig): TestCase[] {
    if (!this.llmConfig) return [];

    // Create client eagerly so test closures can capture it
    this.llmClient = new LLMClient(this.llmConfig);

    const client = this.llmClient;
    return [
      // Per-tool isolation tests
      ...generateArgGenerationTests(discovered, client),
      ...generateResponseValidationTests(discovered, client),
      ...generateDescriptionQualityTests(discovered, client),
      ...generateDiscoverabilityTests(discovered, client),
      // Agentic tests (tool composition)
      ...generateToolSelectionTests(discovered, client),
      ...generateWorkflowChainingTests(discovered, client),
      ...generateScenarioExecutionTests(discovered, client),
      ...generateAgenticLoopTests(discovered, client),
    ];
  }

  async setup(_context: TestRunContext): Promise<void> {
    // Validate LLM connectivity with a minimal test call
    if (this.llmClient) {
      try {
        await this.llmClient.chat(
          [{ role: 'user', content: 'Respond with exactly: ok' }],
          { maxTokens: 10 },
        );
      } catch (err) {
        throw new Error(`LLM judge connectivity check failed: ${(err as Error).message}`);
      }
    }
  }

  async teardown(_context: TestRunContext): Promise<void> {
    this.llmClient = null;
  }
}
