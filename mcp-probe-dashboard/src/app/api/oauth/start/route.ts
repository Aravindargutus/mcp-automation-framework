import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { startAuthorization } from '@modelcontextprotocol/sdk/client/auth.js';
import { storeVerifier } from '@/lib/pkce-store';
import { signState, validateUrl, oauthLimiter, RateLimitError, sanitizeErrorMessage } from '@/lib/security';

/**
 * GET /api/oauth/start?serverName=...&clientId=...&...
 *
 * Supports two modes:
 *
 * 1. Auto-discovered (PKCE) — when authorizationServerUrl is present:
 *    Uses SDK's startAuthorization() which generates PKCE challenge automatically.
 *    Params: serverName, clientId, authorizationServerUrl, authorizationEndpoint,
 *            tokenEndpoint, scopes, serverUrl (resource)
 *
 * 2. Manual (legacy) — when authUrl is present:
 *    Builds authorization URL directly with client_secret flow.
 *    Params: serverName, clientId, authUrl, scopes
 */
export async function GET(req: Request) {
  try {
    oauthLimiter.consume('oauth:start');
  } catch (err) {
    if (err instanceof RateLimitError) {
      return NextResponse.json({ error: err.message }, { status: 429 });
    }
  }

  const { searchParams } = new URL(req.url);
  const serverName = searchParams.get('serverName');
  const clientId = searchParams.get('clientId');

  if (!serverName || !clientId) {
    return NextResponse.json(
      { error: 'serverName and clientId are required' },
      { status: 400 },
    );
  }

  const origin = new URL(req.url).origin;
  const redirectUri = `${origin}/api/oauth/callback`;
  const scopes = searchParams.get('scopes') ?? '';

  // --- Auto-discovered PKCE flow ---
  const authorizationServerUrl = searchParams.get('authorizationServerUrl');
  if (authorizationServerUrl) {
    // Validate URLs to prevent SSRF
    try {
      validateUrl(authorizationServerUrl, 'authorizationServerUrl');
    } catch (err) {
      return NextResponse.json({ error: sanitizeErrorMessage(err) }, { status: 400 });
    }

    const authEndpoint = searchParams.get('authorizationEndpoint');
    const tokenEndpoint = searchParams.get('tokenEndpoint');
    const serverUrl = searchParams.get('serverUrl');

    if (!tokenEndpoint) {
      return NextResponse.json({ error: 'tokenEndpoint is required for PKCE flow' }, { status: 400 });
    }

    try {
      validateUrl(tokenEndpoint, 'tokenEndpoint');
      if (authEndpoint) validateUrl(authEndpoint, 'authorizationEndpoint');
      if (serverUrl) validateUrl(serverUrl, 'serverUrl');
    } catch (err) {
      return NextResponse.json({ error: sanitizeErrorMessage(err) }, { status: 400 });
    }

    // Sign the state payload with HMAC
    const state = signState({
      serverName,
      clientId,
      tokenEndpoint,
      authorizationServerUrl,
      serverUrl,
      usePkce: true,
      nonce: randomUUID(),
    });

    try {
      // Build metadata object for startAuthorization if we have the endpoint
      const metadata = authEndpoint
        ? {
            authorization_endpoint: new URL(authEndpoint),
            response_types_supported: ['code'],
            code_challenge_methods_supported: ['S256'],
          }
        : undefined;

      const { authorizationUrl, codeVerifier } = await startAuthorization(
        authorizationServerUrl,
        {
          metadata: metadata as any,
          clientInformation: { client_id: clientId },
          redirectUrl: redirectUri,
          scope: scopes || undefined,
          state,
          resource: serverUrl ? new URL(serverUrl) : undefined,
        },
      );

      // Store PKCE verifier for the callback
      storeVerifier(serverName, codeVerifier);

      return NextResponse.redirect(authorizationUrl.toString());
    } catch {
      return NextResponse.json(
        { error: 'Failed to start authorization. Please check your OAuth configuration.' },
        { status: 500 },
      );
    }
  }

  // --- Manual (legacy) flow ---
  const authUrl = searchParams.get('authUrl');
  if (!authUrl) {
    return NextResponse.json(
      { error: 'authUrl or authorizationServerUrl is required' },
      { status: 400 },
    );
  }

  try {
    validateUrl(authUrl, 'authUrl');
  } catch (err) {
    return NextResponse.json({ error: sanitizeErrorMessage(err) }, { status: 400 });
  }

  // Sign state with HMAC
  const state = signState({ serverName, nonce: randomUUID() });

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopes,
    state,
    access_type: 'offline',
    prompt: 'consent',
  });

  const fullAuthUrl = `${authUrl}?${params.toString()}`;
  return NextResponse.redirect(fullAuthUrl);
}
