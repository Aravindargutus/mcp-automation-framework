/**
 * AI Evaluation Suite — LLM-powered semantic evaluation of MCP tools.
 *
 * This suite is OPTIONAL. It only runs when:
 *   1. LLMJudgeConfig is provided with `enabled: true`
 *   2. The server has at least one tool to evaluate
 *
 * Four test categories:
 *   - arg-generation: LLM generates realistic args → calls tool → validates response
 *   - description-quality: LLM rates tool description quality 1-10
 *   - response-validation: LLM detects hidden failures in existing test responses
 *   - discoverability: LLM evaluates tool set naming and organization
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

export class AIEvaluationSuite implements TestSuite {
  name = 'ai-evaluation';
  description = 'LLM-powered semantic evaluation of tool quality, arguments, and responses';
  tags = ['ai-evaluation', 'llm'];

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
      ...generateArgGenerationTests(discovered, client),
      ...generateResponseValidationTests(discovered, client),
      ...generateDescriptionQualityTests(discovered, client),
      ...generateDiscoverabilityTests(discovered, client),
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
