/**
 * API Route: GET /api/llm-config/models
 * Proxies the Ollama /api/tags endpoint to list locally available models.
 * Avoids CORS issues and provides a consistent response format.
 */
import { NextResponse } from 'next/server';
import { getLLMConfig } from '@/lib/llm-store';
import { oauthLimiter, RateLimitError } from '@/lib/security';

export async function GET(request: Request) {
  try {
    oauthLimiter.consume('llm-config:models');
  } catch (err) {
    if (err instanceof RateLimitError) {
      return NextResponse.json({ models: [], error: err.message }, { status: 429 });
    }
    throw err;
  }

  // Determine Ollama host: prefer query param (unsaved UI state), then stored config, then default
  const { searchParams } = new URL(request.url);
  const baseUrlParam = searchParams.get('baseUrl');

  // Allowlist: only localhost/127.0.0.1 Ollama hosts are permitted.
  // This prevents SSRF attacks where a malicious baseUrl probes internal network services.
  const ALLOWED_OLLAMA_HOSTS = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/i;

  const sanitizeOllamaHost = (url: string): string | null => {
    const stripped = url.replace(/\/v1\/?$/, '').trim();
    return ALLOWED_OLLAMA_HOSTS.test(stripped) ? stripped : null;
  };

  let ollamaHost = 'http://localhost:11434';
  if (baseUrlParam) {
    const safe = sanitizeOllamaHost(baseUrlParam);
    if (!safe) {
      return NextResponse.json({ models: [], error: 'Invalid Ollama host. Only localhost URLs are allowed.' }, { status: 400 });
    }
    ollamaHost = safe;
  } else {
    const config = getLLMConfig();
    if (config?.baseUrl) {
      ollamaHost = sanitizeOllamaHost(config.baseUrl) ?? 'http://localhost:11434';
    }
  }

  try {
    const res = await fetch(`${ollamaHost}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      return NextResponse.json({
        models: [],
        error: `Ollama returned ${res.status}: ${(await res.text()).slice(0, 200)}`,
      });
    }

    const data = await res.json();
    const models: string[] = (data.models ?? []).map(
      (m: { name?: string; model?: string }) => m.name ?? m.model ?? 'unknown',
    );

    return NextResponse.json({ models });
  } catch (err) {
    const message = (err as Error)?.message ?? '';
    const isConnectionError =
      message.includes('ECONNREFUSED') ||
      message.includes('fetch failed') ||
      message.includes('aborted');

    return NextResponse.json({
      models: [],
      error: isConnectionError
        ? "Ollama is not running. Start it with 'ollama serve'"
        : `Failed to fetch models: ${message.slice(0, 200)}`,
    });
  }
}
