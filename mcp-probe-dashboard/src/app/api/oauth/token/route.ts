import { NextResponse } from 'next/server';
import { getOAuthTokens } from '@/lib/server-store';

/**
 * GET /api/oauth/token?serverName=...
 *
 * Returns the current OAuth token status for a server (without exposing the full token).
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const serverName = searchParams.get('serverName');

  if (!serverName) {
    return NextResponse.json({ error: 'serverName is required' }, { status: 400 });
  }

  const tokens = getOAuthTokens(serverName);
  if (!tokens) {
    return NextResponse.json({ authorized: false });
  }

  const expired = tokens.expiresAt ? tokens.expiresAt < Date.now() : false;

  return NextResponse.json({
    authorized: true,
    expired,
    tokenType: tokens.tokenType ?? 'Bearer',
    expiresAt: tokens.expiresAt ?? null,
  });
}
