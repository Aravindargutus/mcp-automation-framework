/**
 * API Route: GET / PUT /api/llm-config
 * Manages the LLM judge configuration for the AI evaluation suite.
 */
import { NextResponse } from 'next/server';
import { getLLMConfig, saveLLMConfig, type LLMJudgeSettings } from '@/lib/llm-store';
import { maskSecret, isMasked } from '@/lib/mask-utils';
import { validateUrl, mutationLimiter, RateLimitError, ValidationError } from '@/lib/security';

export async function GET() {
  const config = getLLMConfig();
  if (config) {
    // Mask the API key before sending to the browser
    return NextResponse.json({ ...config, apiKey: maskSecret(config.apiKey) });
  }
  return NextResponse.json({ enabled: false, baseUrl: '', apiKey: '', model: 'claude-sonnet-4-20250514', maxTokens: 1024 });
}

export async function PUT(request: Request) {
  try {
    mutationLimiter.consume('llm-config:put');
  } catch (err) {
    if (err instanceof RateLimitError) {
      return NextResponse.json({ error: err.message }, { status: 429 });
    }
    throw err;
  }

  try {
    const body = (await request.json()) as LLMJudgeSettings;

    if (typeof body.enabled !== 'boolean') {
      return NextResponse.json({ error: 'enabled must be a boolean' }, { status: 400 });
    }

    // Validate baseUrl when enabled
    if (body.enabled) {
      if (!body.baseUrl) {
        return NextResponse.json({ error: 'baseUrl is required when enabled' }, { status: 400 });
      }
      try {
        validateUrl(body.baseUrl, 'baseUrl');
      } catch (err) {
        if (err instanceof ValidationError) {
          return NextResponse.json({ error: err.message }, { status: 400 });
        }
        return NextResponse.json({ error: 'Invalid baseUrl' }, { status: 400 });
      }
    }

    // Validate model field
    if (body.model && (typeof body.model !== 'string' || body.model.length > 100)) {
      return NextResponse.json({ error: 'model must be a string of at most 100 characters' }, { status: 400 });
    }

    // Validate maxTokens
    if (body.maxTokens !== undefined) {
      const mt = Number(body.maxTokens);
      if (!Number.isInteger(mt) || mt < 1 || mt > 100000) {
        return NextResponse.json({ error: 'maxTokens must be an integer between 1 and 100000' }, { status: 400 });
      }
    }

    // If the API key is masked/sentinel, preserve the stored original
    let apiKey = body.apiKey || '';
    if (isMasked(apiKey)) {
      const existing = getLLMConfig();
      apiKey = existing?.apiKey ?? '';
    }

    if (body.enabled && !apiKey) {
      return NextResponse.json({ error: 'apiKey is required when enabled' }, { status: 400 });
    }

    saveLLMConfig({
      enabled: body.enabled,
      baseUrl: body.baseUrl || '',
      apiKey,
      model: body.model || 'claude-sonnet-4-20250514',
      maxTokens: body.maxTokens || 1024,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: 'Invalid configuration' }, { status: 400 });
  }
}
