/**
 * Edge Cases Suite — tests boundary conditions, concurrency, and unusual inputs.
 *
 * Validates that the server handles:
 * - Empty/unicode/large/special-char inputs
 * - Extra unknown fields in arguments
 * - Duplicate calls (idempotency)
 * - Rapid request bursts
 * - Parallel tool calls and list operations
 * - Request cancellation
 */
import type { TestSuite, TestCase } from '../types.js';
import type { DiscoveredServer } from '../../client/mcp-client.js';
import type { ServerConfig } from '../../config/schema.js';
import { generateBoundaryTests } from './boundary.js';
import { generateConcurrencyTests } from './concurrency.js';

export class EdgeCasesSuite implements TestSuite {
  name = 'edge-cases';
  description = 'Tests boundary conditions, concurrency, and unusual inputs';
  tags = ['edge-cases'];

  isApplicable(_discovered: DiscoveredServer): boolean {
    return true;
  }

  generateTests(discovered: DiscoveredServer, serverConfig: ServerConfig): TestCase[] {
    return [
      ...generateBoundaryTests(discovered, serverConfig),
      ...generateConcurrencyTests(discovered, serverConfig),
    ];
  }
}
