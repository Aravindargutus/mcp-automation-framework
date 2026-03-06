'use client';

import { useState, useEffect } from 'react';

interface LLMConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
}

type Provider = 'anthropic' | 'openai' | 'custom';

const PROVIDER_DEFAULTS: Record<Provider, { baseUrl: string; model: string }> = {
  anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-20250514' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  custom: { baseUrl: '', model: '' },
};

function detectProvider(baseUrl: string): Provider {
  if (baseUrl.includes('anthropic.com')) return 'anthropic';
  if (baseUrl.includes('openai.com')) return 'openai';
  return 'custom';
}

export default function LLMSettings() {
  const [config, setConfig] = useState<LLMConfig>({
    enabled: false,
    baseUrl: 'https://api.anthropic.com',
    apiKey: '',
    model: 'claude-sonnet-4-20250514',
    maxTokens: 1024,
  });
  const [provider, setProvider] = useState<Provider>('anthropic');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [keyDirty, setKeyDirty] = useState(false);

  useEffect(() => {
    fetch('/api/llm-config')
      .then((r) => r.json())
      .then((data: LLMConfig) => {
        setConfig(data);
        setProvider(detectProvider(data.baseUrl));
      })
      .catch(() => {});
  }, []);

  const handleProviderChange = (p: Provider) => {
    setProvider(p);
    const defaults = PROVIDER_DEFAULTS[p];
    setConfig((prev) => ({ ...prev, baseUrl: defaults.baseUrl, model: defaults.model }));
    setDirty(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      // If the user didn't change the API key, send sentinel so backend preserves the original
      const payload = {
        ...config,
        apiKey: keyDirty ? config.apiKey : '__MASKED__',
      };
      const res = await fetch('/api/llm-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json();
        alert(`Save failed: ${err.error}`);
      } else {
        setDirty(false);
        setKeyDirty(false);
      }
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      // Save first, then trigger a test via a simple API call
      const payload = {
        ...config,
        apiKey: keyDirty ? config.apiKey : '__MASKED__',
      };
      await fetch('/api/llm-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const res = await fetch('/api/llm-config/test', { method: 'POST' });
      const data = await res.json();
      setTestResult(data.ok ? { ok: true, message: 'Connected successfully!' } : { ok: false, message: data.error });
      setDirty(false);
      setKeyDirty(false);
    } catch (err) {
      setTestResult({ ok: false, message: (err as Error).message });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="rounded-lg border border-zinc-700/50 bg-zinc-900/50">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-zinc-200">🤖 AI Evaluation (LLM Judge)</span>
          {config.enabled && (
            <span className="rounded-full bg-green-500/20 px-2 py-0.5 text-[10px] font-medium text-green-400">
              ON
            </span>
          )}
        </div>
        <span className="text-xs text-zinc-500">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="space-y-4 border-t border-zinc-700/50 px-4 pb-4 pt-3">
          {/* Enable toggle */}
          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <input
              type="checkbox"
              checked={config.enabled}
              onChange={(e) => {
                setConfig((prev) => ({ ...prev, enabled: e.target.checked }));
                setDirty(true);
              }}
              className="rounded border-zinc-600 bg-zinc-800"
            />
            Enable AI-powered semantic testing
          </label>

          {config.enabled && (
            <>
              {/* Provider selector */}
              <div>
                <label className="mb-1 block text-xs text-zinc-400">Provider</label>
                <div className="flex gap-2">
                  {(['anthropic', 'openai', 'custom'] as const).map((p) => (
                    <button
                      key={p}
                      onClick={() => handleProviderChange(p)}
                      className={`rounded px-3 py-1.5 text-xs font-medium ${
                        provider === p
                          ? 'bg-blue-500/20 text-blue-400 ring-1 ring-blue-500/50'
                          : 'bg-zinc-800 text-zinc-400 hover:text-zinc-300'
                      }`}
                    >
                      {p === 'anthropic' ? 'Anthropic (Claude)' : p === 'openai' ? 'OpenAI' : 'Custom'}
                    </button>
                  ))}
                </div>
              </div>

              {/* Base URL */}
              <div>
                <label className="mb-1 block text-xs text-zinc-400">Base URL</label>
                <input
                  type="text"
                  value={config.baseUrl}
                  onChange={(e) => {
                    setConfig((prev) => ({ ...prev, baseUrl: e.target.value }));
                    setDirty(true);
                  }}
                  placeholder="https://api.anthropic.com"
                  className="w-full rounded bg-zinc-800 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 ring-1 ring-zinc-700 focus:outline-none focus:ring-blue-500"
                />
              </div>

              {/* API Key */}
              <div>
                <label className="mb-1 block text-xs text-zinc-400">API Key</label>
                <input
                  type="password"
                  value={config.apiKey}
                  onFocus={(e) => {
                    // Clear the masked placeholder when user focuses to type a new key
                    if (!keyDirty && config.apiKey.includes('\u2022')) {
                      setConfig((prev) => ({ ...prev, apiKey: '' }));
                    }
                  }}
                  onChange={(e) => {
                    setConfig((prev) => ({ ...prev, apiKey: e.target.value }));
                    setKeyDirty(true);
                    setDirty(true);
                  }}
                  placeholder={provider === 'anthropic' ? 'sk-ant-...' : 'sk-...'}
                  className="w-full rounded bg-zinc-800 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 ring-1 ring-zinc-700 focus:outline-none focus:ring-blue-500"
                />
              </div>

              {/* Model */}
              <div>
                <label className="mb-1 block text-xs text-zinc-400">Model</label>
                <input
                  type="text"
                  value={config.model}
                  onChange={(e) => {
                    setConfig((prev) => ({ ...prev, model: e.target.value }));
                    setDirty(true);
                  }}
                  className="w-full rounded bg-zinc-800 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 ring-1 ring-zinc-700 focus:outline-none focus:ring-blue-500"
                />
                <p className="mt-1 text-[10px] text-zinc-500">
                  {provider === 'anthropic'
                    ? 'e.g., claude-sonnet-4-20250514, claude-haiku-4-20250514'
                    : provider === 'openai'
                      ? 'e.g., gpt-4o-mini, gpt-4o, gpt-4-turbo'
                      : 'Enter the model name supported by your endpoint'}
                </p>
              </div>

              {/* Max Tokens */}
              <div>
                <label className="mb-1 block text-xs text-zinc-400">Max Tokens</label>
                <input
                  type="number"
                  value={config.maxTokens}
                  onChange={(e) => {
                    setConfig((prev) => ({ ...prev, maxTokens: parseInt(e.target.value) || 1024 }));
                    setDirty(true);
                  }}
                  min={100}
                  max={8192}
                  className="w-32 rounded bg-zinc-800 px-3 py-2 text-sm text-zinc-200 ring-1 ring-zinc-700 focus:outline-none focus:ring-blue-500"
                />
              </div>

              {/* Actions */}
              <div className="flex items-center gap-3 pt-1">
                <button
                  onClick={handleSave}
                  disabled={saving || !dirty}
                  className="rounded bg-blue-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-40"
                >
                  {saving ? 'Saving...' : 'Save'}
                </button>
                <button
                  onClick={handleTest}
                  disabled={testing || !config.apiKey}
                  className="rounded bg-zinc-700 px-4 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-600 disabled:opacity-40"
                >
                  {testing ? 'Testing...' : 'Test Connection'}
                </button>
                {testResult && (
                  <span className={`text-xs ${testResult.ok ? 'text-green-400' : 'text-red-400'}`}>
                    {testResult.message}
                  </span>
                )}
              </div>
            </>
          )}

          {!config.enabled && (
            <p className="text-xs text-zinc-500">
              When enabled, an AI model will evaluate your MCP tools for description quality,
              generate realistic arguments, and detect hidden failures in responses.
              Requires an API key from Anthropic or OpenAI.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
