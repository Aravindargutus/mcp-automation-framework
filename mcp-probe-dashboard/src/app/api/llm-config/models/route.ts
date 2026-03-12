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

  let ollamaHost = 'http://localhost:11434';
  if (baseUrlParam) {
    ollamaHost = baseUrlParam.replace(/\/v1\/?$/, '');
  } else {
    const config = getLLMConfig();
    if (config?.baseUrl) {
      ollamaHost = config.baseUrl.replace(/\/v1\/?$/, '');
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
