import { NextResponse } from 'next/server';
import { discoverOAuthServerInfo } from '@modelcontextprotocol/sdk/client/auth.js';
import { validateUrl, oauthLimiter, RateLimitError } from '@/lib/security';

/**
 * POST /api/oauth/discover
 *
 * Discovers OAuth endpoints for an MCP server using the MCP spec flow:
 * 1. RFC 9728 — Protected Resource Metadata (/.well-known/oauth-protected-resource)
 * 2. RFC 8414 — Auth Server Metadata (/.well-known/oauth-authorization-server)
 *
 * Accepts: { serverUrl: string, resourceMetadataUrl?: string }
 * Returns discovered endpoints or error.
 */
export async function POST(req: Request) {
  try {
    oauthLimiter.consume('oauth:discover');
  } catch (err) {
    if (err instanceof RateLimitError) {
      return NextResponse.json({ error: err.message }, { status: 429 });
    }
    throw err;
  }

  const body = await req.json();
  const { serverUrl, resourceMetadataUrl } = body;

  if (!serverUrl) {
    return NextResponse.json({ error: 'serverUrl is required' }, { status: 400 });
  }

  // Validate URLs to prevent SSRF
  try {
    validateUrl(serverUrl, 'serverUrl');
    if (resourceMetadataUrl) validateUrl(resourceMetadataUrl, 'resourceMetadataUrl');
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }

  try {
    const info = await discoverOAuthServerInfo(serverUrl, {
      resourceMetadataUrl: resourceMetadataUrl ? new URL(resourceMetadataUrl) : undefined,
    });

    const metadata = info.authorizationServerMetadata;
    const resourceMeta = info.resourceMetadata;

    return NextResponse.json({
      authorizationServerUrl: info.authorizationServerUrl,
      authorizationEndpoint: metadata?.authorization_endpoint?.toString(),
      tokenEndpoint: metadata?.token_endpoint?.toString(),
      registrationEndpoint: metadata?.registration_endpoint?.toString(),
      scopesSupported: resourceMeta?.scopes_supported ?? metadata?.scopes_supported,
      codeChallengeMethodsSupported: metadata?.code_challenge_methods_supported,
      responseTypesSupported: metadata?.response_types_supported,
      resource: resourceMeta?.resource,
    });
  } catch {
    return NextResponse.json(
      { error: 'OAuth discovery failed. Please verify the server URL supports OAuth.' },
      { status: 502 },
    );
  }
}
