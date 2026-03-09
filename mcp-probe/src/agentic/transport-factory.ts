/**
 * Transport Factory — shared module for creating MCP transports and auth headers.
 *
 * Extracted from agentic-runner.ts so both the runner (discovery) and
 * individual product agents (per-product connections) can create transports.
 */
import type { ServerConfig } from '../config/schema.js';
import { StdioTransport } from '../transport/stdio.js';
import { HttpTransport } from '../transport/http.js';
import type { MCPTransport } from '../transport/types.js';

/**
 * Build auth headers from the auth config.
 */
export function buildAuthHeaders(auth?: ServerConfig['auth']): Record<string, string> {
  if (!auth) return {};
  const resolveSecret = (val: string | { env: string }): string =>
    typeof val === 'string' ? val : process.env[val.env] ?? '';
  switch (auth.type) {
    case 'bearer':
      return { Authorization: `Bearer ${resolveSecret(auth.token)}` };
    case 'apikey':
      return { [auth.header]: resolveSecret(auth.key) };
    default:
      return {};
  }
}

/**
 * Create a transport from server config.
 */
export function createTransport(serverConfig: ServerConfig): MCPTransport {
  const authHeaders = buildAuthHeaders(serverConfig.auth);

  switch (serverConfig.transport.type) {
    case 'stdio':
      return new StdioTransport({
        command: serverConfig.transport.command,
        args: serverConfig.transport.args,
        cwd: serverConfig.transport.cwd,
        env: serverConfig.transport.env,
      });
    case 'http':
    case 'sse':
      return new HttpTransport({
        url: serverConfig.transport.url,
        headers: { ...serverConfig.transport.headers, ...authHeaders },
      });
    default:
      throw new Error(`Unsupported transport type: ${(serverConfig.transport as { type: string }).type}`);
  }
}
