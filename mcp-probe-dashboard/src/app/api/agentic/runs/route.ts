import { NextResponse } from 'next/server';
import { startAgenticRun } from '@/lib/agentic-client';
import { listAgenticRuns } from '@/lib/agentic-store';
import { getServer } from '@/lib/server-store';
import { getLLMConfig } from '@/lib/llm-store';
import { mutationLimiter, RateLimitError } from '@/lib/security';

export async function GET() {
  const runs = listAgenticRuns().map((r) => ({
    runId: r.runId,
    serverName: r.serverName,
    status: r.status,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
    progress: r.progress,
    result: r.result
      ? {
          totalProducts: (r.result as any).totalProducts,
          totalEntities: (r.result as any).totalEntities,
          passedSteps: (r.result as any).passedSteps,
          failedSteps: (r.result as any).failedSteps,
          totalSteps: (r.result as any).totalSteps,
          durationMs: (r.result as any).durationMs,
          status: (r.result as any).status,
        }
      : undefined,
  }));
  return NextResponse.json(runs);
}

export async function POST(req: Request) {
  try {
    mutationLimiter.consume('agentic:post');
  } catch (err) {
    if (err instanceof RateLimitError) {
      return NextResponse.json({ error: err.message }, { status: 429 });
    }
    throw err;
  }

  const body = await req.json();
  if (!body.serverName) {
    return NextResponse.json({ error: 'serverName is required' }, { status: 400 });
  }

  // Resolve unmasked server config from the store
  const serverConfig = getServer(body.serverName);
  if (!serverConfig) {
    return NextResponse.json({ error: `Server "${body.serverName}" not found` }, { status: 404 });
  }

  // Load LLM config from server-side store (or use frontend override if provided)
  const llmConfig = body.llm ?? getLLMConfig();

  const runId = await startAgenticRun({
    serverConfig,
    modules: body.modules,
    maxEntitiesPerProduct: body.maxEntitiesPerProduct,
    llm: llmConfig?.enabled ? llmConfig : undefined,
  });

  return NextResponse.json({ runId });
}
