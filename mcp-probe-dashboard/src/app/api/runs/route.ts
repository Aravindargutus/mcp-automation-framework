import { NextResponse } from 'next/server';
import { startRun } from '@/lib/probe-client';
import { listRuns } from '@/lib/run-store';

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
  const body = await req.json();
  if (!body.servers?.length) {
    return NextResponse.json({ error: 'servers array is required' }, { status: 400 });
  }
  const runId = await startRun({
    servers: body.servers,
    suites: body.suites,
  });
  return NextResponse.json({ runId });
}
