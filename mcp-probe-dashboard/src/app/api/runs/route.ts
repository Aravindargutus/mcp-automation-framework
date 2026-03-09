import { NextResponse } from 'next/server';
import { startRun } from '@/lib/probe-client';
import { listRuns } from '@/lib/run-store';
import { getServer } from '@/lib/server-store';
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
    throw err;
  }

  const body = await req.json();
  if (!body.servers?.length) {
    return NextResponse.json({ error: 'servers array is required' }, { status: 400 });
  }

  // Resolve server configs from the store using server names.
  // The frontend sends masked configs (secrets redacted for display),
  // so we look up the real (unmasked) config by name from the server store.
  const resolvedServers = body.servers.map((s: { name: string }) => {
    const stored = getServer(s.name);
    return stored ?? s;
  });

  // Validate each server config
  try {
    for (const server of resolvedServers) {
      validateServerConfig(server);
    }
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json({ error: 'Invalid server configuration' }, { status: 400 });
  }

  const runId = await startRun({
    servers: resolvedServers,
    suites: body.suites,
  });
  return NextResponse.json({ runId });
}
