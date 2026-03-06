'use client';

import { useState, useEffect, useCallback } from 'react';

interface ServerConfig {
  name: string;
  transport: {
    type: 'stdio' | 'http' | 'sse';
    command?: string;
    args?: string[];
    cwd?: string;
    url?: string;
    headers?: Record<string, string>;
  };
  auth?: {
    type: 'bearer' | 'apikey' | 'oauth';
    token?: string;
    header?: string;
    key?: string;
    clientId?: string;
    clientSecret?: string;
    authUrl?: string;
    tokenUrl?: string;
    scopes?: string;
  };
}

interface DiscoveredInfo {
  tools: { name: string; description?: string }[];
  resources: { name: string; uri: string }[];
  prompts: { name: string; description?: string }[];
  serverInfo?: { name: string; version: string };
}

interface OAuthDiscovery {
  authorizationServerUrl: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  registrationEndpoint?: string;
  scopesSupported?: string[];
  codeChallengeMethodsSupported?: string[];
  resource?: string;
  serverUrl: string;
}

interface ServerFormProps {
  initial?: ServerConfig;
  onSave: (config: ServerConfig) => Promise<void>;
  onCancel?: () => void;
}

export default function ServerForm({ initial, onSave, onCancel }: ServerFormProps) {
  const [name, setName] = useState(initial?.name ?? '');
  const [transportType, setTransportType] = useState<'stdio' | 'http' | 'sse'>(initial?.transport.type ?? 'stdio');
  const [command, setCommand] = useState(initial?.transport.command ?? '');
  const [args, setArgs] = useState(initial?.transport.args?.join(' ') ?? '');
  const [cwd, setCwd] = useState(initial?.transport.cwd ?? '');
  const [url, setUrl] = useState(initial?.transport.url ?? '');
  const [authType, setAuthType] = useState(initial?.auth?.type ?? '');
  const [authToken, setAuthToken] = useState(initial?.auth?.token ?? '');

  // OAuth fields
  const [oauthClientId, setOauthClientId] = useState(initial?.auth?.clientId ?? '');
  const [oauthClientSecret, setOauthClientSecret] = useState(initial?.auth?.clientSecret ?? '');
  const [oauthAuthUrl, setOauthAuthUrl] = useState(initial?.auth?.authUrl ?? '');
  const [oauthTokenUrl, setOauthTokenUrl] = useState(initial?.auth?.tokenUrl ?? '');
  const [oauthScopes, setOauthScopes] = useState(initial?.auth?.scopes ?? '');
  const [oauthStatus, setOauthStatus] = useState<'unknown' | 'authorized' | 'expired' | 'none'>('unknown');
  const [authorizing, setAuthorizing] = useState(false);

  // Auto-discovery state
  const [discoveryState, setDiscoveryState] = useState<OAuthDiscovery | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [showManualOAuth, setShowManualOAuth] = useState(false);

  // Track whether secret fields were edited (to avoid sending masked values back)
  const [tokenDirty, setTokenDirty] = useState(!initial); // new server = always dirty
  const [clientSecretDirty, setClientSecretDirty] = useState(!initial);

  const [saving, setSaving] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [discovered, setDiscovered] = useState<DiscoveredInfo | null>(null);
  const [error, setError] = useState('');

  // Check OAuth token status when name or authType changes
  useEffect(() => {
    if (authType === 'oauth' && name) {
      fetch(`/api/oauth/token?serverName=${encodeURIComponent(name)}`)
        .then((r) => r.json())
        .then((data) => {
          if (data.authorized && !data.expired) setOauthStatus('authorized');
          else if (data.authorized && data.expired) setOauthStatus('expired');
          else setOauthStatus('none');
        })
        .catch(() => setOauthStatus('none'));
    }
  }, [authType, name]);

  // Listen for OAuth callback messages from popup window
  const handleOAuthMessage = useCallback((event: MessageEvent) => {
    if (event.origin !== window.location.origin) return;
    if (event.data?.type === 'oauth-callback') {
      setAuthorizing(false);
      if (event.data.success) {
        setOauthStatus('authorized');
        setError('');
      } else {
        setError(event.data.error || 'Authorization failed');
      }
    }
  }, []);

  useEffect(() => {
    window.addEventListener('message', handleOAuthMessage);
    return () => window.removeEventListener('message', handleOAuthMessage);
  }, [handleOAuthMessage]);

  function buildConfig(): ServerConfig {
    const config: ServerConfig = {
      name,
      transport: { type: transportType },
    };
    if (transportType === 'stdio') {
      config.transport.command = command;
      config.transport.args = args.split(/\s+/).filter(Boolean);
      if (cwd) config.transport.cwd = cwd;
    } else {
      config.transport.url = url;
    }
    if (authType === 'bearer' && authToken) {
      // Send __MASKED__ sentinel if the token wasn't edited, so backend preserves the original
      config.auth = { type: 'bearer', token: tokenDirty ? authToken : '__MASKED__' };
    } else if (authType === 'apikey' && authToken) {
      config.auth = { type: 'apikey', key: tokenDirty ? authToken : '__MASKED__' };
    } else if (authType === 'oauth') {
      config.auth = {
        type: 'oauth',
        clientId: oauthClientId,
        clientSecret: clientSecretDirty ? oauthClientSecret : '__MASKED__',
        authUrl: oauthAuthUrl,
        tokenUrl: oauthTokenUrl,
        scopes: oauthScopes,
      };
    }
    return config;
  }

  async function handleSave() {
    if (!name.trim()) { setError('Name is required'); return; }
    if (transportType === 'stdio' && !command.trim()) { setError('Command is required'); return; }
    if (transportType !== 'stdio' && !url.trim()) { setError('URL is required'); return; }

    setSaving(true);
    setError('');
    try {
      await onSave(buildConfig());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleInspect() {
    setInspecting(true);
    setError('');
    setDiscovered(null);
    try {
      const res = await fetch('/api/inspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildConfig()),
      });

      // Handle 401 — server requires OAuth
      if (res.status === 401) {
        const data = await res.json();
        if (data.wwwAuthenticate) {
          await handleAutoDiscovery(data.wwwAuthenticate);
        } else {
          // 401 without WWW-Authenticate — suggest manual OAuth
          setAuthType('oauth');
          setShowManualOAuth(true);
          setError('Server requires authentication (401). Configure OAuth below.');
        }
        return;
      }

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Inspection failed');
      }
      setDiscovered(await res.json());
      setDiscoveryState(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setInspecting(false);
    }
  }

  async function handleAutoDiscovery(wwwAuthenticate: string) {
    setDiscovering(true);
    setError('');
    try {
      // Extract resource_metadata URL from WWW-Authenticate header
      const rmMatch = wwwAuthenticate.match(/resource_metadata="([^"]+)"/);
      const resourceMetadataUrl = rmMatch?.[1];

      const serverUrl = url;
      const res = await fetch('/api/oauth/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverUrl, resourceMetadataUrl }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Discovery failed');
      }

      const discovery = await res.json();
      setDiscoveryState({ ...discovery, serverUrl });
      setAuthType('oauth');

      // Auto-populate OAuth fields from discovery
      if (discovery.authorizationEndpoint) setOauthAuthUrl(discovery.authorizationEndpoint);
      if (discovery.tokenEndpoint) setOauthTokenUrl(discovery.tokenEndpoint);
      if (discovery.scopesSupported?.length) {
        setOauthScopes(discovery.scopesSupported.join(' '));
      }
    } catch (err) {
      setError(`OAuth discovery failed: ${(err as Error).message}. Try manual configuration.`);
      setAuthType('oauth');
      setShowManualOAuth(true);
    } finally {
      setDiscovering(false);
    }
  }

  function handleDiscoveredAuthorize() {
    if (!name.trim()) { setError('Enter a server name first'); return; }
    if (!oauthClientId.trim()) { setError('Client ID is required'); return; }
    if (!discoveryState) return;

    setAuthorizing(true);
    setError('');

    const params = new URLSearchParams({
      serverName: name,
      clientId: oauthClientId,
      authorizationServerUrl: discoveryState.authorizationServerUrl,
      scopes: oauthScopes,
      serverUrl: discoveryState.serverUrl,
    });
    if (discoveryState.authorizationEndpoint) {
      params.set('authorizationEndpoint', discoveryState.authorizationEndpoint);
    }
    if (discoveryState.tokenEndpoint) {
      params.set('tokenEndpoint', discoveryState.tokenEndpoint);
    }

    const popup = window.open(
      `/api/oauth/start?${params.toString()}`,
      'oauth-authorize',
      'width=600,height=700,menubar=no,toolbar=no',
    );

    if (!popup) {
      setError('Popup blocked. Please allow popups for this site.');
      setAuthorizing(false);
    }
  }

  function handleOAuthAuthorize() {
    if (!name.trim()) { setError('Save the server first before authorizing'); return; }
    if (!oauthClientId || !oauthAuthUrl) { setError('Client ID and Auth URL are required'); return; }

    setAuthorizing(true);
    setError('');

    const params = new URLSearchParams({
      serverName: name,
      authUrl: oauthAuthUrl,
      clientId: oauthClientId,
      scopes: oauthScopes,
    });

    const popup = window.open(
      `/api/oauth/start?${params.toString()}`,
      'oauth-authorize',
      'width=600,height=700,menubar=no,toolbar=no',
    );

    if (!popup) {
      setError('Popup blocked. Please allow popups for this site.');
      setAuthorizing(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        {/* Name */}
        <Field label="Server Name">
          <input
            className="input-field"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-mcp-server"
          />
        </Field>

        {/* Transport Type */}
        <Field label="Transport">
          <div className="flex gap-2">
            {(['stdio', 'http', 'sse'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTransportType(t)}
                className={`rounded-lg border px-4 py-2 text-sm transition-colors ${
                  transportType === t
                    ? 'border-blue-500 bg-blue-500/20 text-blue-400'
                    : 'border-zinc-700 bg-zinc-800/50 text-zinc-400 hover:border-zinc-600'
                }`}
              >
                {t.toUpperCase()}
              </button>
            ))}
          </div>
        </Field>

        {/* Stdio fields */}
        {transportType === 'stdio' && (
          <>
            <Field label="Command">
              <input
                className="input-field"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="mcp-server-filesystem"
              />
            </Field>
            <Field label="Arguments">
              <input
                className="input-field"
                value={args}
                onChange={(e) => setArgs(e.target.value)}
                placeholder="/tmp/test-dir"
              />
            </Field>
            <Field label="Working Directory (optional)">
              <input
                className="input-field"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder="/path/to/project"
              />
            </Field>
          </>
        )}

        {/* HTTP/SSE fields */}
        {transportType !== 'stdio' && (
          <Field label="URL">
            <input
              className="input-field"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="http://localhost:3000/mcp"
            />
          </Field>
        )}

        {/* Auth */}
        <Field label="Authentication">
          <select
            className="input-field"
            value={authType}
            onChange={(e) => {
              setAuthType(e.target.value);
              setDiscoveryState(null);
              setShowManualOAuth(false);
            }}
          >
            <option value="">None</option>
            <option value="bearer">Bearer Token</option>
            <option value="apikey">API Key</option>
            <option value="oauth">OAuth 2.0 (Browser Login)</option>
          </select>
        </Field>

        {/* Bearer / API Key */}
        {(authType === 'bearer' || authType === 'apikey') && (
          <Field label={authType === 'bearer' ? 'Token' : 'API Key'}>
            <input
              className="input-field"
              type="password"
              value={authToken}
              onFocus={() => {
                // Clear masked placeholder when user focuses to enter a new value
                if (!tokenDirty && authToken.includes('\u2022')) {
                  setAuthToken('');
                }
              }}
              onChange={(e) => {
                setAuthToken(e.target.value);
                setTokenDirty(true);
              }}
              placeholder="Enter token"
            />
          </Field>
        )}

        {/* Auto-discovered OAuth banner */}
        {authType === 'oauth' && discoveryState && !showManualOAuth && (
          <div className="space-y-3 rounded-lg border border-purple-500/30 bg-purple-500/5 p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-purple-400" />
                <span className="text-sm font-medium text-purple-300">
                  OAuth Endpoints Discovered
                </span>
              </div>
              {oauthStatus === 'authorized' && (
                <span className="flex items-center gap-1.5 rounded-full bg-emerald-500/20 px-2.5 py-0.5 text-xs text-emerald-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  Authorized
                </span>
              )}
            </div>

            <div className="space-y-1.5 text-xs text-zinc-500">
              <div className="flex gap-2">
                <span className="w-24 shrink-0 text-zinc-600">Auth Server:</span>
                <span className="truncate text-zinc-400">{discoveryState.authorizationServerUrl}</span>
              </div>
              {discoveryState.tokenEndpoint && (
                <div className="flex gap-2">
                  <span className="w-24 shrink-0 text-zinc-600">Token URL:</span>
                  <span className="truncate text-zinc-400">{discoveryState.tokenEndpoint}</span>
                </div>
              )}
              {discoveryState.scopesSupported && discoveryState.scopesSupported.length > 0 && (
                <div className="flex gap-2">
                  <span className="w-24 shrink-0 text-zinc-600">Scopes:</span>
                  <span className="truncate text-zinc-400">{discoveryState.scopesSupported.join(', ')}</span>
                </div>
              )}
            </div>

            <Field label="Client ID">
              <input
                className="input-field"
                value={oauthClientId}
                onChange={(e) => setOauthClientId(e.target.value)}
                placeholder="Enter your OAuth Client ID"
              />
            </Field>

            <Field label="Scopes (optional)">
              <input
                className="input-field"
                value={oauthScopes}
                onChange={(e) => setOauthScopes(e.target.value)}
                placeholder={discoveryState.scopesSupported?.join(' ') || 'Leave blank for default'}
              />
            </Field>

            <button
              onClick={handleDiscoveredAuthorize}
              disabled={authorizing || !oauthClientId.trim()}
              className="w-full rounded-lg border border-purple-500/40 bg-purple-500/10 px-4 py-2.5 text-sm font-medium text-purple-300 hover:bg-purple-500/20 disabled:opacity-50"
            >
              {authorizing
                ? 'Waiting for authorization...'
                : oauthStatus === 'authorized'
                  ? 'Re-authorize'
                  : 'Authorize with PKCE'}
            </button>

            <button
              onClick={() => setShowManualOAuth(true)}
              className="w-full text-center text-xs text-zinc-600 hover:text-zinc-400"
            >
              Use manual configuration instead
            </button>
          </div>
        )}

        {/* Discovering spinner */}
        {discovering && (
          <div className="flex items-center gap-2 rounded-lg border border-purple-500/20 bg-purple-500/5 px-4 py-3 text-sm text-purple-400">
            <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-purple-400 border-t-transparent" />
            Discovering OAuth endpoints...
          </div>
        )}

        {/* Manual OAuth fields (legacy or fallback) */}
        {authType === 'oauth' && (showManualOAuth || !discoveryState) && !discovering && (
          <div className="space-y-3 rounded-lg border border-zinc-700/50 bg-zinc-900/30 p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-zinc-300">OAuth 2.0 Configuration</span>
              {oauthStatus === 'authorized' && (
                <span className="flex items-center gap-1.5 rounded-full bg-emerald-500/20 px-2.5 py-0.5 text-xs text-emerald-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  Authorized
                </span>
              )}
              {oauthStatus === 'expired' && (
                <span className="flex items-center gap-1.5 rounded-full bg-yellow-500/20 px-2.5 py-0.5 text-xs text-yellow-400">
                  Token Expired
                </span>
              )}
            </div>

            {discoveryState && (
              <button
                onClick={() => setShowManualOAuth(false)}
                className="text-xs text-purple-400 hover:text-purple-300"
              >
                Back to auto-discovered configuration
              </button>
            )}

            <Field label="Authorization URL">
              <input
                className="input-field"
                value={oauthAuthUrl}
                onChange={(e) => setOauthAuthUrl(e.target.value)}
                placeholder="https://accounts.zoho.com/oauth/v2/auth"
              />
            </Field>
            <Field label="Token URL">
              <input
                className="input-field"
                value={oauthTokenUrl}
                onChange={(e) => setOauthTokenUrl(e.target.value)}
                placeholder="https://accounts.zoho.com/oauth/v2/token"
              />
            </Field>
            <Field label="Client ID">
              <input
                className="input-field"
                value={oauthClientId}
                onChange={(e) => setOauthClientId(e.target.value)}
                placeholder="1000.XXXXXXX"
              />
            </Field>
            <Field label="Client Secret">
              <input
                className="input-field"
                type="password"
                value={oauthClientSecret}
                onFocus={() => {
                  if (!clientSecretDirty && oauthClientSecret.includes('\u2022')) {
                    setOauthClientSecret('');
                  }
                }}
                onChange={(e) => {
                  setOauthClientSecret(e.target.value);
                  setClientSecretDirty(true);
                }}
                placeholder="Enter client secret"
              />
            </Field>
            <Field label="Scopes (space-separated)">
              <input
                className="input-field"
                value={oauthScopes}
                onChange={(e) => setOauthScopes(e.target.value)}
                placeholder="ZohoSheet.dataAPI.READ ZohoSheet.dataAPI.UPDATE"
              />
            </Field>
            <button
              onClick={handleOAuthAuthorize}
              disabled={authorizing}
              className="w-full rounded-lg border border-purple-500/40 bg-purple-500/10 px-4 py-2.5 text-sm font-medium text-purple-300 hover:bg-purple-500/20 disabled:opacity-50"
            >
              {authorizing
                ? 'Waiting for authorization...'
                : oauthStatus === 'authorized'
                  ? 'Re-authorize'
                  : 'Authorize with OAuth'}
            </button>
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-3">
        <button
          onClick={handleSave}
          disabled={saving}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
        >
          {saving ? 'Saving...' : initial ? 'Update Server' : 'Add Server'}
        </button>
        <button
          onClick={handleInspect}
          disabled={inspecting || discovering}
          className="rounded-lg border border-zinc-600 px-4 py-2 text-sm font-medium text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
        >
          {inspecting ? 'Inspecting...' : discovering ? 'Discovering...' : 'Test Connection'}
        </button>
        {onCancel && (
          <button
            onClick={onCancel}
            className="rounded-lg px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200"
          >
            Cancel
          </button>
        )}
      </div>

      {/* Discovered capabilities */}
      {discovered && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4">
          <div className="mb-3 flex items-center gap-2 text-emerald-400">
            <span className="text-lg">{'\u2713'}</span>
            <span className="font-medium">Connected</span>
            {discovered.serverInfo && (
              <span className="text-xs text-zinc-400">
                {discovered.serverInfo.name} v{discovered.serverInfo.version}
              </span>
            )}
          </div>
          <div className="grid grid-cols-3 gap-4 text-sm">
            <CapabilityList title="Tools" items={discovered.tools.map((t) => t.name)} />
            <CapabilityList title="Resources" items={discovered.resources.map((r) => r.name)} />
            <CapabilityList title="Prompts" items={discovered.prompts.map((p) => p.name)} />
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium text-zinc-400">{label}</label>
      {children}
    </div>
  );
}

function CapabilityList({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-zinc-400">{title} ({items.length})</div>
      {items.length === 0 ? (
        <div className="text-xs text-zinc-600">None</div>
      ) : (
        <ul className="space-y-0.5">
          {items.map((item) => (
            <li key={item} className="truncate text-xs text-zinc-300">{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
