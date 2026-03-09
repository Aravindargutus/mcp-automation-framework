/**
 * Agentic Client — bridges mcp-probe's runAgentic to the dashboard event bus and store.
 */
import { randomUUID } from 'crypto';
import { agenticEventBus, type AgenticEvent } from './agentic-event-emitter';
import {
  createAgenticRun,
  updateAgenticProgress,
  completeAgenticRun,
  failAgenticRun,
} from './agentic-store';
import { getOAuthTokens } from './server-store';
import type { ServerConfig } from './probe-client';

function emit(runId: string, type: AgenticEvent['type'], data: unknown) {
  agenticEventBus.emit(runId, { type, timestamp: Date.now(), data });
}

export interface LLMConfig {
  enabled: boolean;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  maxTokens?: number;
}

export interface StartAgenticParams {
  serverConfig: ServerConfig;
  modules?: string[];
  maxEntitiesPerProduct?: number;
  llm?: LLMConfig;
}

/**
 * Start an agentic test run in the background.
 * Returns the run ID immediately.
 */
export async function startAgenticRun(params: StartAgenticParams): Promise<string> {
  const runId = randomUUID();
  createAgenticRun(runId, params.serverConfig.name);

  const { runAgentic } = await import('mcp-probe');

  // For OAuth servers, inject the stored token as bearer auth
  let auth = params.serverConfig.auth as any;
  if (params.serverConfig.auth?.type === 'oauth') {
    const tokens = getOAuthTokens(params.serverConfig.name);
    if (tokens?.accessToken) {
      auth = { type: 'bearer', token: tokens.accessToken };
    }
  }

  const serverConfig = {
    name: params.serverConfig.name,
    transport: params.serverConfig.transport as any,
    auth,
    timeout: params.serverConfig.timeout,
  };

  // Run in background (don't await)
  runAgentic(
    {
      serverConfig: serverConfig as any,
      modules: params.modules,
      maxEntitiesPerProduct: params.maxEntitiesPerProduct,
      llm: params.llm as any,
    },
    {
      onRunStart(rid: string, products: string[]) {
        updateAgenticProgress(runId, { totalProducts: products.length });
        emit(runId, 'agentic:run:start', { runId: rid, products });
      },
      onAgentStart(productName: string, entities: string[]) {
        updateAgenticProgress(runId, { totalEntities: entities.length });
        emit(runId, 'agentic:agent:start', { productName, entities });
      },
      onAgentEnd(productName: string, result: any) {
        updateAgenticProgress(runId, { completedProducts: 1 });
        emit(runId, 'agentic:agent:end', { productName, result });
      },
      onEntityStart(productName: string, entityName: string, steps: any[], representedEntities?: string[]) {
        emit(runId, 'agentic:entity:start', { productName, entityName, steps, representedEntities });
      },
      onEntityEnd(productName: string, entityName: string, result: any) {
        updateAgenticProgress(runId, { completedEntities: 1 });
        emit(runId, 'agentic:entity:end', { productName, entityName, result });
      },
      onStepStart(productName: string, entityName: string, operation: string, toolName: string) {
        emit(runId, 'agentic:step:start', { productName, entityName, operation, toolName });
      },
      onStepEnd(productName: string, entityName: string, step: any) {
        const progress: any = { totalSteps: 1 };
        if (step.status === 'passed') progress.passedSteps = 1;
        if (step.status === 'failed') progress.failedSteps = 1;
        updateAgenticProgress(runId, progress);
        emit(runId, 'agentic:step:end', { productName, entityName, step });
      },
      onRunEnd(result: any) {
        completeAgenticRun(runId, result);
        emit(runId, 'agentic:run:end', result);
      },
    },
  ).catch((err: Error) => {
    failAgenticRun(runId, err.message);
    emit(runId, 'agentic:run:end', { error: err.message });
  });

  return runId;
}
