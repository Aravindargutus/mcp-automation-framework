import { NextResponse } from 'next/server';
import { listServers, addServer, removeServer, getServer } from '@/lib/server-store';
import { maskSecret, maskUrlSecrets, isMasked } from '@/lib/mask-utils';
import { validateServerConfig, mutationLimiter, RateLimitError, ValidationError } from '@/lib/security';
import type { ServerConfig } from '@/lib/probe-client';

/** Mask all secret fields in a server config before sending to the browser. */
function maskServerSecrets(server: ServerConfig): ServerConfig {
  const masked = { ...server, transport: { ...server.transport } };

  // Mask URL query params that contain secrets
  if (masked.transport.url) {
    masked.transport.url = maskUrlSecrets(masked.transport.url);
  }

  // Mask auth credentials
  if (masked.auth) {
    masked.auth = { ...masked.auth };
    if (masked.auth.token) masked.auth.token = maskSecret(masked.auth.token);
    if (masked.auth.key) masked.auth.key = maskSecret(masked.auth.key);
    if (masked.auth.clientSecret) masked.auth.clientSecret = maskSecret(masked.auth.clientSecret);
  }

  return masked;
}

export async function GET() {
  const servers = listServers().map(maskServerSecrets);
  return NextResponse.json(servers);
}

export async function POST(req: Request) {
  try {
    mutationLimiter.consume('servers:post');
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

  // If auth fields contain masked sentinels, preserve the stored originals
  if (body.auth) {
    const existing = getServer(body.name);
    if (existing?.auth) {
      if (isMasked(body.auth.token)) body.auth.token = existing.auth.token;
      if (isMasked(body.auth.key)) body.auth.key = existing.auth.key;
      if (isMasked(body.auth.clientSecret)) body.auth.clientSecret = existing.auth.clientSecret;
    }
  }

  addServer(body);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  try {
    mutationLimiter.consume('servers:delete');
  } catch (err) {
    if (err instanceof RateLimitError) {
      return NextResponse.json({ error: err.message }, { status: 429 });
    }
    throw err;
  }

  const { searchParams } = new URL(req.url);
  const name = searchParams.get('name');
  if (!name) {
    return NextResponse.json({ error: 'name query param required' }, { status: 400 });
  }
  const removed = removeServer(name);
  return NextResponse.json({ ok: removed });
}
