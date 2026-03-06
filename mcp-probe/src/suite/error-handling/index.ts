/**
 * Error Handling Suite — tests server error responses for invalid requests.
 *
 * Validates that the server returns proper errors (not crashes) for:
 * - Nonexistent tools, resources, prompts
 * - Missing required arguments
 * - Wrong argument types
 * - Null arguments
 */
import type { TestSuite, TestCase } from '../types.js';
import type { DiscoveredServer } from '../../client/mcp-client.js';
import type { ServerConfig } from '../../config/schema.js';
import { generateInvalidRequestTests } from './invalid-requests.js';

export class ErrorHandlingSuite implements TestSuite {
  name = 'error-handling';
  description = 'Tests server error responses for invalid requests';
  tags = ['error-handling'];

  isApplicable(_discovered: DiscoveredServer): boolean {
    return true;
  }

  generateTests(discovered: DiscoveredServer, _serverConfig: ServerConfig): TestCase[] {
    return generateInvalidRequestTests(discovered);
  }
}
