/**
 * Raw MCP Client — bypasses SDK validation for protocol conformance testing.
 *
 * The official SDK Client enforces protocol rules on the client side and won't
 * let you send malformed requests. This raw client writes directly to the
 * transport for testing server rejection behavior:
 *   - Null/missing IDs
 *   - Pre-initialization requests
 *   - Unknown methods
 *   - Malformed params
 */
import type { MCPTransport } from '../transport/types.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

export interface RawResponse {
  message: JSONRPCMessage | null;
  error?: Error;
  durationMs: number;
}

export class RawMCPClient {
  private requestId = 0;
  private pendingRequests = new Map<
    string | number,
    { resolve: (msg: JSONRPCMessage) => void; reject: (err: Error) => void }
  >();
  private messageHandler: ((msg: JSONRPCMessage) => void) | null = null;
  private closeHandler: ((code?: number, signal?: string) => void) | null = null;

  constructor(private transport: MCPTransport) {}

  /**
   * Attach event handlers to the transport.
   * Must be called after transport.connect().
   */
  attach(): void {
    this.messageHandler = (msg: JSONRPCMessage) => {
      // Try to match to a pending request by ID
      const msgAny = msg as Record<string, unknown>;
      const id = msgAny.id;
      if (id !== undefined && id !== null) {
        const pending = this.pendingRequests.get(id as string | number);
        if (pending) {
          this.pendingRequests.delete(id as string | number);
          pending.resolve(msg);
        }
      }
    };

    this.closeHandler = (_code?: number, signal?: string) => {
      // Reject all pending requests on transport close
      for (const [id, pending] of this.pendingRequests) {
        pending.reject(new Error(`Transport closed (signal: ${signal ?? 'none'})`));
        this.pendingRequests.delete(id);
      }
    };

    this.transport.on('message', this.messageHandler);
    this.transport.on('close', this.closeHandler);
  }

  /**
   * Detach event handlers from the transport.
   */
  detach(): void {
    if (this.messageHandler) {
      this.transport.off('message', this.messageHandler);
      this.messageHandler = null;
    }
    if (this.closeHandler) {
      this.transport.off('close', this.closeHandler);
      this.closeHandler = null;
    }

    // Reject remaining pending requests
    for (const [id, pending] of this.pendingRequests) {
      pending.reject(new Error('Client detached'));
      this.pendingRequests.delete(id);
    }
  }

  /**
   * Send a raw JSON-RPC message and wait for a response.
   * The message is sent exactly as-is — no validation.
   */
  async sendRaw(message: unknown, timeoutMs = 120_000): Promise<RawResponse> {
    const startTime = Date.now();
    const msgAny = message as Record<string, unknown>;
    const id = msgAny.id;

    // If it's a notification (no id), just send without waiting
    if (id === undefined || id === null) {
      try {
        await this.transport.send(message as JSONRPCMessage);
      } catch (err) {
        return { message: null, error: err as Error, durationMs: Date.now() - startTime };
      }
      return { message: null, durationMs: Date.now() - startTime };
    }

    // Register pending request BEFORE sending so HTTP synchronous responses
    // aren't lost (HTTP transport emits 'message' inside send())
    const responsePromise = this.waitForResponse(id as string | number, timeoutMs);

    try {
      await this.transport.send(message as JSONRPCMessage);
    } catch (err) {
      this.pendingRequests.delete(id as string | number);
      return { message: null, error: err as Error, durationMs: Date.now() - startTime };
    }

    try {
      const response = await responsePromise;
      return { message: response, durationMs: Date.now() - startTime };
    } catch (err) {
      return { message: null, error: err as Error, durationMs: Date.now() - startTime };
    }
  }

  /**
   * Send a well-formed JSON-RPC request with auto-incrementing ID.
   */
  async sendRequest(method: string, params?: unknown, timeoutMs = 120_000): Promise<RawResponse> {
    const id = ++this.requestId;
    return this.sendRaw(
      {
        jsonrpc: '2.0',
        id,
        method,
        params: params ?? {},
      },
      timeoutMs,
    );
  }

  /**
   * Send a JSON-RPC notification (no id, no response expected).
   */
  async sendNotification(method: string, params?: unknown): Promise<void> {
    await this.transport.send({
      jsonrpc: '2.0',
      method,
      params: params ?? {},
    } as JSONRPCMessage);
  }

  /**
   * Generate the next request ID (useful for tests that need to predict IDs).
   */
  nextId(): number {
    return this.requestId + 1;
  }

  private waitForResponse(id: string | number, timeoutMs: number): Promise<JSONRPCMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request ${id} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }
}
