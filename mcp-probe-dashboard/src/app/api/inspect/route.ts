import { NextResponse } from 'next/server';
import { inspectServer } from '@/lib/probe-client';

export async function POST(req: Request) {
  const body = await req.json();
  if (!body.name || !body.transport?.type) {
    return NextResponse.json({ error: 'name and transport are required' }, { status: 400 });
  }
  try {
    const discovered = await inspectServer(body);
    return NextResponse.json(discovered);
  } catch (err) {
    const error = err as any;
    // Structured 401 — server requires OAuth authorization
    if (error.name === 'HttpAuthRequiredError') {
      return NextResponse.json(
        { error: 'auth_required', wwwAuthenticate: error.wwwAuthenticate },
        { status: 401 },
      );
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
