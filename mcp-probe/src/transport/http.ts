/**
 * HTTP Streamable transport for MCP servers.
 *
 * Implements the 2025-11-25 Streamable HTTP transport:
 * - POST for JSON-RPC requests → SSE or JSON responses
 * - GET for opening SSE stream (server-initiated messages)
 * - Session management via Mcp-Session-Id header
 * - MCP-Protocol-Version header on EVERY request (per spec)
 * - 404 → session expired → reinitialize
 * - Last-Event-ID for resumable SSE streams
 */
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { MCPTransport, HttpTransportOptions, TransportEvents, TransportMetrics } from './types.js';

const MCP_PROTOCOL_VERSION = '2025-11-25';

export class HttpAuthRequiredError extends Error {
  readonly status = 401;
  readonly wwwAuthenticate: string | null;
  constructor(wwwAuthenticate: string | null) {
    super('MCP server requires authentication (401)');
    this.name = 'HttpAuthRequiredError';
    this.wwwAuthenticate = wwwAuthenticate;
  }
}

export class HttpTransport implements MCPTransport {
  readonly type = 'http' as const;
  private sessionId: string | null = null;
  private lastEventId: string | null = null;
  private sseController: AbortController | null = null;
  private handlers: Map<keyof TransportEvents, Set<(...args: unknown[]) => void>> = new Map();
  private _isConnected = false;
  private _metrics: TransportMetrics = {
    messagesSent: 0,
    messagesReceived: 0,
    bytesOut: 0,
    bytesIn: 0,
  };

  constructor(private options: HttpTransportOptions) {}

  get isConnected(): boolean {
    return this._isConnected;
  }

  get metrics(): TransportMetrics {
    return { ...this._metrics };
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  async connect(): Promise<void> {
    const startTime = Date.now();

    // Per MCP spec, `initialize` must be the first request.
    // Don't send a pre-flight ping — it wastes a round-trip and can break
    // servers that use cookies/sessions (e.g. Zoho) since Node fetch
    // doesn't persist cookies between requests.
    // Connectivity is verified when the client sends `initialize`.
    this._isConnected = true;
    this._metrics.connectTime = Date.now() - startTime;
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this._isConnected) {
      throw new Error('Transport not connected');
    }

    const body = JSON.stringify(message);
    this._metrics.bytesOut += Buffer.byteLength(body);
    this._metrics.messagesSent++;
    this._metrics.lastActivityAt = Date.now();

    const resp = await fetch(this.options.url, {
      method: 'POST',
      headers: {
        ...this.buildHeaders(),
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body,
    });

    // Update session ID if server sends one
    const newSessionId = resp.headers.get('mcp-session-id');
    if (newSessionId) {
      this.sessionId = newSessionId;
    }

    // Handle auth required — server needs OAuth authorization
    if (resp.status === 401) {
      const wwwAuth = resp.headers.get('www-authenticate');
      throw new HttpAuthRequiredError(wwwAuth);
    }

    // Handle session expired — per spec, 404 means session gone
    if (resp.status === 404) {
      this.sessionId = null;
      this.emit('close', 404, 'session_expired');
      throw new Error('MCP session expired (404). Re-initialization required.');
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status}: ${text}`);
    }

    // 202 Accepted = server acknowledged a notification (no body expected).
    // Check before content-type: some servers (e.g. Zoho) return
    // Content-Type: application/json on 202 with an empty body.
    if (resp.status === 202) {
      return;
    }

    const contentType = resp.headers.get('content-type') ?? '';

    if (contentType.includes('text/event-stream')) {
      // SSE response — parse events
      await this.consumeSSEResponse(resp);
    } else if (contentType.includes('application/json')) {
      // Direct JSON response
      const text = await resp.text();
      if (!text) return; // Empty body — nothing to parse
      this._metrics.bytesIn += Buffer.byteLength(text);
      try {
        const responseMsg = JSON.parse(text) as JSONRPCMessage;
        this._metrics.messagesReceived++;
        this._metrics.lastActivityAt = Date.now();
        this.emit('message', responseMsg);
      } catch {
        throw new Error(`Invalid JSON response: ${text.slice(0, 200)}`);
      }
    }
  }

  /**
   * Open a persistent SSE stream for server-initiated messages.
   */
  async openSSEStream(): Promise<void> {
    this.sseController = new AbortController();

    const headers: Record<string, string> = {
      ...this.buildHeaders(),
      Accept: 'text/event-stream',
    };

    if (this.lastEventId) {
      headers['Last-Event-ID'] = this.lastEventId;
    }

    try {
      const resp = await fetch(this.options.url, {
        method: 'GET',
        headers,
        signal: this.sseController.signal,
      });

      if (!resp.ok) {
        throw new Error(`SSE stream failed: HTTP ${resp.status}`);
      }

      await this.consumeSSEResponse(resp);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        this.emit('error', err as Error);
      }
    }
  }

  async close(): Promise<void> {
    // Close SSE stream if open
    this.sseController?.abort();
    this.sseController = null;

    // Send DELETE to terminate session (per spec)
    if (this.sessionId) {
      try {
        await fetch(this.options.url, {
          method: 'DELETE',
          headers: this.buildHeaders(),
        });
      } catch {
        // Best-effort session cleanup
      }
    }

    this._isConnected = false;
    this.sessionId = null;
  }

  on<K extends keyof TransportEvents>(event: K, handler: TransportEvents[K]): void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler as (...args: unknown[]) => void);
  }

  off<K extends keyof TransportEvents>(event: K, handler: TransportEvents[K]): void {
    this.handlers.get(event)?.delete(handler as (...args: unknown[]) => void);
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
      ...this.options.headers,
    };

    if (this.sessionId) {
      headers['Mcp-Session-Id'] = this.sessionId;
    }

    return headers;
  }

  private async consumeSSEResponse(resp: Response): Promise<void> {
    const reader = resp.body?.getReader();
    if (!reader) return;

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';

        for (const event of events) {
          this.parseSSEEvent(event);
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        this.emit('error', err as Error);
      }
    } finally {
      reader.releaseLock();
    }
  }

  private parseSSEEvent(raw: string): void {
    let eventType = 'message';
    let data = '';
    let id: string | undefined;

    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        data += (data ? '\n' : '') + line.slice(5).trim();
      } else if (line.startsWith('id:')) {
        id = line.slice(3).trim();
      }
    }

    if (id) {
      this.lastEventId = id;
    }

    if (eventType === 'message' && data) {
      this._metrics.bytesIn += Buffer.byteLength(data);
      try {
        const message = JSON.parse(data) as JSONRPCMessage;
        this._metrics.messagesReceived++;
        this._metrics.lastActivityAt = Date.now();
        this.emit('message', message);
      } catch {
        // Malformed SSE data — skip
      }
    }
  }

  private emit<K extends keyof TransportEvents>(event: K, ...args: Parameters<TransportEvents[K]>): void {
    const handlers = this.handlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(...(args as unknown[]));
        } catch (err) {
          console.error(`Error in ${event} handler:`, err);
        }
      }
    }
  }
}
