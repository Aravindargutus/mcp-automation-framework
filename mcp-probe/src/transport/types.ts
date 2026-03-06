/**
 * Transport layer types — separated from session management per architect review.
 * Transport handles raw byte I/O; Session handles MCP-specific state.
 */
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

export interface TransportEvents {
  message: (msg: JSONRPCMessage) => void;
  error: (err: Error) => void;
  close: (code?: number, signal?: string) => void;
}

export interface MCPTransport {
  readonly type: 'stdio' | 'http' | 'sse';
  readonly isConnected: boolean;

  /** Establish the underlying connection */
  connect(): Promise<void>;

  /** Send a JSON-RPC message */
  send(message: JSONRPCMessage): Promise<void>;

  /** Close the connection gracefully */
  close(): Promise<void>;

  /** Force kill (for stdio subprocess) */
  kill?(): void;

  /** Register event handlers */
  on<K extends keyof TransportEvents>(event: K, handler: TransportEvents[K]): void;
  off<K extends keyof TransportEvents>(event: K, handler: TransportEvents[K]): void;
}

export interface StdioTransportOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  stderrCaptureLimitBytes?: number;
}

export interface HttpTransportOptions {
  url: string;
  headers?: Record<string, string>;
}

export interface TransportMetrics {
  messagesSent: number;
  messagesReceived: number;
  bytesOut: number;
  bytesIn: number;
  connectTime?: number;
  lastActivityAt?: number;
}
