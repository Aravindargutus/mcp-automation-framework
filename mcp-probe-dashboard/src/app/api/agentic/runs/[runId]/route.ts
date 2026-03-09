import { NextResponse } from 'next/server';
import { getAgenticRun } from '@/lib/agentic-store';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  const run = getAgenticRun(runId);
  if (!run) {
    return NextResponse.json({ error: 'Agentic run not found' }, { status: 404 });
  }
  return NextResponse.json(run);
}
