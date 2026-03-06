/**
 * Protocol Suite — validates MCP protocol conformance.
 *
 * Sub-modules:
 * - lifecycle: Initialize handshake, version negotiation, capabilities, discovery
 * - messages: JSON-RPC conformance, error codes, malformed request rejection
 */
import type { TestSuite, TestCase } from '../types.js';
import type { DiscoveredServer } from '../../client/mcp-client.js';
import type { ServerConfig } from '../../config/schema.js';
import { generateLifecycleTests } from './lifecycle.js';
import { generateMessageTests } from './messages.js';

export class ProtocolSuite implements TestSuite {
  name = 'protocol';
  description = 'MCP protocol conformance tests (lifecycle, JSON-RPC, transport)';
  tags = ['protocol', 'required'];

  isApplicable(_discovered: DiscoveredServer): boolean {
    // Protocol tests always apply — every server must conform
    return true;
  }

  generateTests(_discovered: DiscoveredServer, _serverConfig: ServerConfig): TestCase[] {
    return [
      ...generateLifecycleTests(),
      ...generateMessageTests(),
    ];
  }
}
