import { NextResponse } from 'next/server';
import { inspectServer } from '@/lib/probe-client';
import { validateServerConfig, mutationLimiter, RateLimitError, ValidationError, sanitizeErrorMessage } from '@/lib/security';

export async function POST(req: Request) {
  try {
    mutationLimiter.consume('inspect:post');
  } catch (err) {
    if (err instanceof RateLimitError) {
      return NextResponse.json({ error: err.message }, { status: 429 });
    }
    throw err;
  }

  const body = await req.json();

  // Validate server config
  try {
    validateServerConfig(body);
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json({ error: 'Invalid server configuration' }, { status: 400 });
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
    return NextResponse.json({ error: sanitizeErrorMessage(err) }, { status: 500 });
  }
}
