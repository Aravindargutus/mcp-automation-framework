/**
 * Probe Client — wraps mcp-probe core for dashboard use.
 * Bridges the runner's callback API to our event bus and run store.
 */
import { randomUUID } from 'crypto';
import { eventBus, type RunEvent } from './event-emitter';
import { createRun, updateRunProgress, completeRun, failRun } from './run-store';
import { getOAuthTokens } from './server-store';
import { getLLMConfig } from './llm-store';

// Server config types (mirrored from mcp-probe to avoid import issues in Next.js)
export interface ServerConfig {
  name: string;
  transport: {
    type: 'stdio' | 'http' | 'sse';
    command?: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
  };
  auth?: {
    type: 'bearer' | 'apikey' | 'oauth';
    token?: string;
    header?: string;
    key?: string;
    // OAuth-specific fields
    clientId?: string;
    clientSecret?: string;
    authUrl?: string;
    tokenUrl?: string;
    scopes?: string;
  };
  timeout?: { request?: number; test?: number };
}

/**
 * Build auth headers for a server, including OAuth tokens from the token store.
 */
function buildServerAuthHeaders(server: ServerConfig): Record<string, string> {
  const headers: Record<string, string> = {};
  if (server.auth?.type === 'bearer' && server.auth.token) {
    headers['Authorization'] = `Bearer ${server.auth.token}`;
  } else if (server.auth?.type === 'apikey' && server.auth.key) {
    headers[server.auth.header ?? 'X-API-Key'] = server.auth.key;
  } else if (server.auth?.type === 'oauth') {
    // Look up stored OAuth token
    const tokens = getOAuthTokens(server.name);
    if (tokens?.accessToken) {
      const tokenType = tokens.tokenType ?? 'Bearer';
      // Zoho uses "Zoho-oauthtoken" prefix, standard OAuth uses "Bearer"
      if (tokenType.toLowerCase().includes('zoho')) {
        headers['Authorization'] = `Zoho-oauthtoken ${tokens.accessToken}`;
      } else {
        headers['Authorization'] = `${tokenType} ${tokens.accessToken}`;
      }
    }
  }
  return headers;
}

export interface StartRunParams {
  servers: ServerConfig[];
  suites?: string[];
}

function emit(runId: string, type: RunEvent['type'], data: unknown) {
  eventBus.emit(runId, { type, timestamp: Date.now(), data });
}

/**
 * Start a test run in the background.
 * Returns the run ID immediately.
 */
export async function startRun(params: StartRunParams): Promise<string> {
  const runId = randomUUID();
  createRun(runId, params.servers.length);

  // Import mcp-probe dynamically to avoid bundling issues
  const { run } = await import('mcp-probe');

  // Read LLM config and inject into runner if enabled
  const llmSettings = getLLMConfig();
  const llmJudge = llmSettings?.enabled
    ? { enabled: true, baseUrl: llmSettings.baseUrl, apiKey: llmSettings.apiKey, model: llmSettings.model, maxTokens: llmSettings.maxTokens }
    : undefined;

  const defaultSuites = ['protocol', 'schema', 'execution', 'error-handling', 'edge-cases'];
  if (llmJudge?.enabled) defaultSuites.push('ai-evaluation');

  const config = {
    version: '1' as const,
    servers: params.servers.map((s) => {
      // For OAuth servers, inject the stored token as bearer auth for the runner
      let auth = s.auth as any;
      if (s.auth?.type === 'oauth') {
        const tokens = getOAuthTokens(s.name);
        if (tokens?.accessToken) {
          auth = { type: 'bearer', token: tokens.accessToken };
        }
      }
      return { name: s.name, transport: s.transport as any, auth, timeout: s.timeout };
    }),
    suites: { include: params.suites ?? defaultSuites, exclude: [] },
    defaults: { maxConcurrent: 5, maxOutputBytes: 1_048_576, allowWriteFuzzing: true },
    llmJudge,
  };

  // Run in background (don't await)
  run({
    config: config as any,
    onServerStart(serverName: string) {
      emit(runId, 'server:start', { serverName });
    },
    onServerEnd(serverName: string, report: any) {
      updateRunProgress(runId, {
        completedServers: (report as any).connected ? 1 : 0,
      });
      emit(runId, 'server:end', { serverName, report });
    },
    onSuiteStart(suiteName: string, serverName: string, testCount: number) {
      emit(runId, 'suite:start', { suiteName, serverName, testCount });
    },
    onSuiteEnd(suiteName: string, serverName: string, result: any) {
      emit(runId, 'suite:end', { suiteName, serverName, result });
    },
    onTestStart(testId: string, testName: string, suiteName: string, serverName: string) {
      emit(runId, 'test:start', { testId, testName, suiteName, serverName });
    },
    onTestEnd(testResult: any) {
      const progress: any = {};
      if (testResult.status === 'passed') progress.passedTests = 1;
      if (testResult.status === 'failed') progress.failedTests = 1;
      progress.totalTests = 1;
      // Increment counters
      updateRunProgress(runId, progress);
      emit(runId, 'test:end', testResult);
    },
  })
    .then((report: any) => {
      completeRun(runId, report);
      emit(runId, 'run:end', report);
    })
    .catch((err: Error) => {
      failRun(runId, err.message);
      emit(runId, 'run:end', { error: err.message });
    });

  return runId;
}

/**
 * Inspect a server — discover its capabilities.
 */
export async function inspectServer(server: ServerConfig): Promise<any> {
  const { MCPProbeClient } = await import('mcp-probe');
  const { StdioTransport } = await import('mcp-probe');
  const { HttpTransport } = await import('mcp-probe');

  const authHeaders = buildServerAuthHeaders(server);

  let transport: any;
  if (server.transport.type === 'stdio') {
    transport = new StdioTransport({
      command: server.transport.command!,
      args: server.transport.args ?? [],
      cwd: server.transport.cwd,
      env: server.transport.env,
    });
  } else {
    transport = new HttpTransport({
      url: server.transport.url!,
      headers: { ...server.transport.headers, ...authHeaders },
    });
  }

  const client = new MCPProbeClient(transport, {
    name: server.name,
    transport: server.transport as any,
    timeout: server.timeout as any,
  });

  try {
    const discovered = await client.connect();
    await client.disconnect();
    return discovered;
  } catch (err) {
    throw new Error(`Failed to inspect server: ${(err as Error).message}`);
  }
}
