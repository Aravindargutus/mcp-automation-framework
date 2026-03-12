/**
 * MCP Client Wrapper — wraps the official SDK Client with:
 * - Paginated discovery (follows nextCursor — fixes the 50+ tools gap)
 * - Timeout enforcement (two-tier: request + test)
 * - Progress notification collection
 * - Session state tracking
 * - Cancellation support
 */
import type { ServerConfig } from '../config/schema.js';
import { SessionManager } from '../transport/session.js';
import { RawMCPClient, type RawResponse } from './raw-client.js';
import type { MCPTransport } from '../transport/types.js';

// --- Discovered server state ---

export interface DiscoveredTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface DiscoveredResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface DiscoveredPrompt {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

export interface DiscoveredServer {
  serverInfo: { name: string; version: string };
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  tools: DiscoveredTool[];
  resources: DiscoveredResource[];
  prompts: DiscoveredPrompt[];
}

// --- Progress tracking ---

export interface ProgressNotification {
  token: string | number;
  progress: number;
  total?: number;
  message?: string;
  timestamp: number;
}

export interface ToolCallTrace {
  toolName: string;
  args: unknown;
  progressNotifications: ProgressNotification[];
  response: unknown;
  isError: boolean;
  durationMs: number;
}

// --- Client ---

export class MCPProbeClient {
  private rawClient: RawMCPClient;
  private session = new SessionManager();
  private progressCollector: ProgressNotification[] = [];
  private requestTimeoutMs: number;
  private _discovered: DiscoveredServer | null = null;

  constructor(
    private transport: MCPTransport,
    config: ServerConfig,
  ) {
    this.rawClient = new RawMCPClient(transport);
    this.requestTimeoutMs = config.timeout?.request ?? 120_000;
  }

  get discovered(): DiscoveredServer | null {
    return this._discovered;
  }

  get sessionState() {
    return this.session.session;
  }

  /**
   * Full initialization handshake:
   * connect → initialize → notifications/initialized
   */
  async connect(): Promise<DiscoveredServer> {
    // 1. Connect transport
    await this.transport.connect();
    this.rawClient.attach();

    // 2. Set up progress notification listener
    this.transport.on('message', (msg) => {
      const msgAny = msg as Record<string, unknown>;
      if (msgAny.method === 'notifications/progress') {
        const params = msgAny.params as Record<string, unknown>;
        this.progressCollector.push({
          token: params.progressToken as string | number,
          progress: params.progress as number,
          total: params.total as number | undefined,
          message: params.message as string | undefined,
          timestamp: Date.now(),
        });
      }
    });

    // 3. Send initialize request
    const initResponse = await this.rawClient.sendRequest('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: {
        name: 'mcp-probe',
        version: '0.1.0',
      },
    }, this.requestTimeoutMs);

    if (initResponse.error || !initResponse.message) {
      throw new Error(`Initialize failed: ${initResponse.error?.message ?? 'no response'}`);
    }

    const result = (initResponse.message as Record<string, unknown>).result as Record<string, unknown>;
    if (!result) {
      const error = (initResponse.message as Record<string, unknown>).error as Record<string, unknown>;
      throw new Error(`Initialize error: ${JSON.stringify(error)}`);
    }

    // 4. Record session state
    this.session.recordInitialized({
      sessionId: null, // Stdio doesn't use session IDs
      protocolVersion: result.protocolVersion as string,
      serverInfo: result.serverInfo as { name: string; version: string },
      capabilities: result.capabilities as Record<string, unknown>,
    });

    // 5. Send notifications/initialized (MANDATORY per spec)
    await this.rawClient.sendNotification('notifications/initialized');

    // 6. Discover all server primitives (with pagination)
    this._discovered = await this.discoverAll(result);

    return this._discovered;
  }

  /**
   * Call a tool and capture the full trace including progress notifications.
   */
  async callTool(toolName: string, args: unknown): Promise<ToolCallTrace> {
    const progressBefore = this.progressCollector.length;

    const response = await this.rawClient.sendRequest('tools/call', {
      name: toolName,
      arguments: args,
    }, this.requestTimeoutMs);

    const progressAfter = this.progressCollector.slice(progressBefore);

    if (response.error) {
      return {
        toolName,
        args,
        progressNotifications: progressAfter,
        response: { error: response.error.message },
        isError: true,
        durationMs: response.durationMs,
      };
    }

    const msgAny = response.message as Record<string, unknown>;
    const result = msgAny?.result ?? msgAny?.error;
    const isError = !!(msgAny?.error || (result as Record<string, unknown>)?.isError);

    return {
      toolName,
      args,
      progressNotifications: progressAfter,
      response: result,
      isError,
      durationMs: response.durationMs,
    };
  }

  /**
   * Read a resource by URI.
   */
  async readResource(uri: string): Promise<RawResponse> {
    return this.rawClient.sendRequest('resources/read', { uri }, this.requestTimeoutMs);
  }

  /**
   * Get a prompt with arguments.
   */
  async getPrompt(name: string, args?: Record<string, string>): Promise<RawResponse> {
    return this.rawClient.sendRequest('prompts/get', { name, arguments: args }, this.requestTimeoutMs);
  }

  /**
   * Send a ping to check server liveness.
   */
  async ping(): Promise<RawResponse> {
    return this.rawClient.sendRequest('ping', {}, this.requestTimeoutMs);
  }

  /**
   * Send a cancellation notification for a pending request.
   */
  async cancelRequest(requestId: string | number, reason?: string): Promise<void> {
    await this.rawClient.sendNotification('notifications/cancelled', {
      requestId,
      reason: reason ?? 'Cancelled by mcp-probe',
    });
  }

  /**
   * Access the raw client for protocol conformance tests.
   */
  getRawClient(): RawMCPClient {
    return this.rawClient;
  }

  /**
   * Graceful disconnect.
   */
  async disconnect(): Promise<void> {
    this.rawClient.detach();
    await this.transport.close();
    this.session.reset();
  }

  // --- Private: paginated discovery ---

  private async discoverAll(initResult: Record<string, unknown>): Promise<DiscoveredServer> {
    const capabilities = initResult.capabilities as Record<string, unknown>;

    const [tools, resources, prompts] = await Promise.all([
      capabilities.tools ? this.discoverAllTools() : Promise.resolve([]),
      capabilities.resources ? this.discoverAllResources() : Promise.resolve([]),
      capabilities.prompts ? this.discoverAllPrompts() : Promise.resolve([]),
    ]);

    return {
      serverInfo: initResult.serverInfo as { name: string; version: string },
      protocolVersion: initResult.protocolVersion as string,
      capabilities,
      tools,
      resources,
      prompts,
    };
  }

  private async discoverAllTools(): Promise<DiscoveredTool[]> {
    const tools: DiscoveredTool[] = [];
    let cursor: string | undefined;

    do {
      const params: Record<string, unknown> = {};
      if (cursor) params.cursor = cursor;

      const resp = await this.rawClient.sendRequest('tools/list', params, this.requestTimeoutMs);
      if (resp.error || !resp.message) break;

      const result = (resp.message as Record<string, unknown>).result as Record<string, unknown>;
      if (!result) break;

      const serverTools = (result.tools ?? []) as DiscoveredTool[];
      tools.push(...serverTools);
      cursor = result.nextCursor as string | undefined;
    } while (cursor);

    return tools;
  }

  private async discoverAllResources(): Promise<DiscoveredResource[]> {
    const resources: DiscoveredResource[] = [];
    let cursor: string | undefined;

    do {
      const params: Record<string, unknown> = {};
      if (cursor) params.cursor = cursor;

      const resp = await this.rawClient.sendRequest('resources/list', params, this.requestTimeoutMs);
      if (resp.error || !resp.message) break;

      const result = (resp.message as Record<string, unknown>).result as Record<string, unknown>;
      if (!result) break;

      const serverResources = (result.resources ?? []) as DiscoveredResource[];
      resources.push(...serverResources);
      cursor = result.nextCursor as string | undefined;
    } while (cursor);

    return resources;
  }

  private async discoverAllPrompts(): Promise<DiscoveredPrompt[]> {
    const prompts: DiscoveredPrompt[] = [];
    let cursor: string | undefined;

    do {
      const params: Record<string, unknown> = {};
      if (cursor) params.cursor = cursor;

      const resp = await this.rawClient.sendRequest('prompts/list', params, this.requestTimeoutMs);
      if (resp.error || !resp.message) break;

      const result = (resp.message as Record<string, unknown>).result as Record<string, unknown>;
      if (!result) break;

      const serverPrompts = (result.prompts ?? []) as DiscoveredPrompt[];
      prompts.push(...serverPrompts);
      cursor = result.nextCursor as string | undefined;
    } while (cursor);

    return prompts;
  }
}
