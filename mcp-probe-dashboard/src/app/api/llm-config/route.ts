/**
 * API Route: GET / PUT /api/llm-config
 * Manages the LLM judge configuration for the AI evaluation suite.
 */
import { NextResponse } from 'next/server';
import { getLLMConfig, saveLLMConfig, type LLMJudgeSettings } from '@/lib/llm-store';

export async function GET() {
  const config = getLLMConfig();
  return NextResponse.json(config ?? { enabled: false, baseUrl: '', apiKey: '', model: 'claude-sonnet-4-20250514', maxTokens: 1024 });
}

export async function PUT(request: Request) {
  try {
    const body = (await request.json()) as LLMJudgeSettings;

    if (typeof body.enabled !== 'boolean') {
      return NextResponse.json({ error: 'enabled must be a boolean' }, { status: 400 });
    }
    if (body.enabled && !body.baseUrl) {
      return NextResponse.json({ error: 'baseUrl is required when enabled' }, { status: 400 });
    }
    if (body.enabled && !body.apiKey) {
      return NextResponse.json({ error: 'apiKey is required when enabled' }, { status: 400 });
    }

    saveLLMConfig({
      enabled: body.enabled,
      baseUrl: body.baseUrl || '',
      apiKey: body.apiKey || '',
      model: body.model || 'claude-sonnet-4-20250514',
      maxTokens: body.maxTokens || 1024,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
