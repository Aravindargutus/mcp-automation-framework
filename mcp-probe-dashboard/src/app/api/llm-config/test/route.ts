/**
 * API Route: POST /api/llm-config/test
 * Tests LLM connectivity with a minimal call.
 */
import { NextResponse } from 'next/server';
import { getLLMConfig } from '@/lib/llm-store';
import { oauthLimiter, RateLimitError } from '@/lib/security';

export async function POST() {
  try {
    oauthLimiter.consume('llm-config:test');
  } catch (err) {
    if (err instanceof RateLimitError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: 429 });
    }
    throw err;
  }

  const config = getLLMConfig();

  if (!config?.enabled || !config.apiKey) {
    return NextResponse.json({ ok: false, error: 'LLM judge not configured' });
  }

  try {
    const isAnthropic = config.baseUrl.includes('anthropic.com');

    if (isAnthropic) {
      // Anthropic Messages API
      const res = await fetch(`${config.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: 10,
          messages: [{ role: 'user', content: 'Respond with: ok' }],
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        const err = await res.text();
        return NextResponse.json({ ok: false, error: `API error ${res.status}: ${err.slice(0, 200)}` });
      }

      const data = await res.json();
      return NextResponse.json({
        ok: true,
        model: data.model,
        tokensUsed: data.usage?.input_tokens + data.usage?.output_tokens,
      });
    } else {
      // OpenAI-compatible
      const res = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: 10,
          messages: [{ role: 'user', content: 'Respond with: ok' }],
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        const err = await res.text();
        return NextResponse.json({ ok: false, error: `API error ${res.status}: ${err.slice(0, 200)}` });
      }

      const data = await res.json();
      return NextResponse.json({
        ok: true,
        model: data.model,
        tokensUsed: data.usage?.total_tokens,
      });
    }
  } catch {
    return NextResponse.json({ ok: false, error: 'Connection test failed. Please check your configuration.' });
  }
}
