import { NextResponse } from 'next/server';
import { startRun } from '@/lib/probe-client';
import { listRuns } from '@/lib/run-store';
import { validateServerConfig, mutationLimiter, RateLimitError, ValidationError } from '@/lib/security';

export async function GET() {
  const runs = listRuns().map((r) => ({
    runId: r.runId,
    status: r.status,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
    progress: r.progress,
    report: r.report
      ? {
          duration: r.report.duration,
          servers: (r.report.servers as any[]).map((s) => ({
            serverName: s.serverName,
            score: s.score ?? null,
          })),
        }
      : undefined,
  }));
  return NextResponse.json(runs);
}

export async function POST(req: Request) {
  try {
    mutationLimiter.consume('runs:post');
  } catch (err) {
    if (err instanceof RateLimitError) {
      return NextResponse.json({ error: err.message }, { status: 429 });
    }
  }

  const body = await req.json();
  if (!body.servers?.length) {
    return NextResponse.json({ error: 'servers array is required' }, { status: 400 });
  }

  // Validate each server config
  try {
    for (const server of body.servers) {
      validateServerConfig(server);
    }
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json({ error: 'Invalid server configuration' }, { status: 400 });
  }

  const runId = await startRun({
    servers: body.servers,
    suites: body.suites,
  });
  return NextResponse.json({ runId });
}
