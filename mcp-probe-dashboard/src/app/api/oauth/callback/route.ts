import { NextResponse } from 'next/server';
import { getServer, setOAuthTokens } from '@/lib/server-store';
import { exchangeAuthorization } from '@modelcontextprotocol/sdk/client/auth.js';
import { retrieveVerifier } from '@/lib/pkce-store';

/**
 * GET /api/oauth/callback?code=...&state=...
 *
 * Handles the OAuth redirect from the provider.
 * Supports two modes based on state payload:
 *
 * 1. PKCE flow (usePkce=true in state): Uses SDK's exchangeAuthorization()
 *    with code_verifier from PKCE store. No client_secret needed.
 *
 * 2. Legacy flow: Uses client_secret from server config for token exchange.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');

  if (error) {
    return redirectToResult(req, { error: `OAuth error: ${error}` });
  }

  if (!code || !state) {
    return redirectToResult(req, { error: 'Missing code or state parameter' });
  }

  // Decode state
  let stateData: Record<string, unknown>;
  try {
    stateData = JSON.parse(Buffer.from(state, 'base64url').toString());
  } catch {
    return redirectToResult(req, { error: 'Invalid state parameter' });
  }

  const serverName = stateData.serverName as string;
  if (!serverName) {
    return redirectToResult(req, { error: 'Missing serverName in state' });
  }

  const origin = new URL(req.url).origin;
  const redirectUri = `${origin}/api/oauth/callback`;

  // --- PKCE flow (auto-discovered) ---
  if (stateData.usePkce) {
    const tokenEndpoint = stateData.tokenEndpoint as string;
    const authServerUrl = stateData.authorizationServerUrl as string;
    const clientId = stateData.clientId as string;
    const serverUrl = stateData.serverUrl as string | undefined;

    if (!tokenEndpoint || !authServerUrl || !clientId) {
      return redirectToResult(req, { error: 'Incomplete PKCE state data' });
    }

    const codeVerifier = retrieveVerifier(serverName);
    if (!codeVerifier) {
      return redirectToResult(req, { error: 'PKCE verifier not found (session expired?)' });
    }

    try {
      const tokens = await exchangeAuthorization(authServerUrl, {
        metadata: {
          token_endpoint: new URL(tokenEndpoint),
          response_types_supported: ['code'],
        } as any,
        clientInformation: { client_id: clientId },
        authorizationCode: code,
        codeVerifier,
        redirectUri,
        resource: serverUrl ? new URL(serverUrl) : undefined,
      });

      setOAuthTokens(serverName, {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: tokens.expires_in
          ? Date.now() + tokens.expires_in * 1000
          : undefined,
        tokenType: tokens.token_type ?? 'Bearer',
      });

      return redirectToResult(req, { success: true, serverName });
    } catch (err) {
      return redirectToResult(req, { error: `PKCE token exchange failed: ${(err as Error).message}` });
    }
  }

  // --- Legacy flow (manual OAuth config) ---
  const server = getServer(serverName);
  if (!server) {
    return redirectToResult(req, { error: `Server "${serverName}" not found` });
  }

  const oauth = server.auth;
  if (!oauth || oauth.type !== 'oauth') {
    return redirectToResult(req, { error: `Server "${serverName}" is not configured for OAuth` });
  }

  try {
    const tokenRes = await fetch((oauth as any).tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: (oauth as any).clientId,
        client_secret: (oauth as any).clientSecret,
      }),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      return redirectToResult(req, { error: `Token exchange failed: ${text}` });
    }

    const tokenData = await tokenRes.json();

    setOAuthTokens(serverName, {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresAt: tokenData.expires_in
        ? Date.now() + tokenData.expires_in * 1000
        : undefined,
      tokenType: tokenData.token_type ?? 'Bearer',
    });

    return redirectToResult(req, { success: true, serverName });
  } catch (err) {
    return redirectToResult(req, { error: (err as Error).message });
  }
}

function redirectToResult(req: Request, result: Record<string, unknown>) {
  const origin = new URL(req.url).origin;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(result)) {
    params.set(k, String(v));
  }
  return NextResponse.redirect(`${origin}/oauth/callback?${params.toString()}`);
}
