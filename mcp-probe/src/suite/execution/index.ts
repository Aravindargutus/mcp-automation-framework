/**
 * Execution Suite — tests actual tool/resource/prompt execution.
 *
 * Unlike the schema suite (which validates structure), this suite
 * actually calls tools, reads resources, and gets prompts, then
 * validates the response content, structure, and timing.
 */
import type { TestSuite, TestCase } from '../types.js';
import type { DiscoveredServer } from '../../client/mcp-client.js';
import type { ServerConfig } from '../../config/schema.js';
import { generateToolCallTests } from './tool-calls.js';
import { generateResourceReadTests } from './resources.js';
import { generatePromptGetTests } from './prompts.js';

export class ExecutionSuite implements TestSuite {
  name = 'execution';
  description = 'Tests actual tool/resource/prompt execution and response validation';
  tags = ['execution'];

  isApplicable(discovered: DiscoveredServer): boolean {
    return discovered.tools.length > 0 || discovered.resources.length > 0 || discovered.prompts.length > 0;
  }

  generateTests(discovered: DiscoveredServer, serverConfig: ServerConfig): TestCase[] {
    return [
      ...generateToolCallTests(discovered, serverConfig),
      ...generateResourceReadTests(discovered),
      ...generatePromptGetTests(discovered),
    ];
  }
}
