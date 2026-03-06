'use client';

import { useEffect, useState, useCallback } from 'react';
import ServerForm from '@/components/ServerForm';

interface ServerConfig {
  name: string;
  transport: {
    type: 'stdio' | 'http' | 'sse';
    command?: string;
    args?: string[];
    cwd?: string;
    url?: string;
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

export default function ServersPage() {
  const [servers, setServers] = useState<ServerConfig[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editServer, setEditServer] = useState<ServerConfig | undefined>();

  const fetchServers = useCallback(async () => {
    const res = await fetch('/api/servers');
    if (res.ok) setServers(await res.json());
  }, []);

  useEffect(() => { fetchServers(); }, [fetchServers]);

  async function handleSave(config: ServerConfig) {
    const res = await fetch('/api/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    if (!res.ok) throw new Error('Failed to save');
    setShowForm(false);
    setEditServer(undefined);
    fetchServers();
  }

  async function handleDelete(name: string) {
    await fetch(`/api/servers?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
    fetchServers();
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Server Configuration</h1>
        {!showForm && (
          <button
            onClick={() => { setEditServer(undefined); setShowForm(true); }}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500"
          >
            Add Server
          </button>
        )}
      </div>

      {showForm && (
        <div className="rounded-xl border border-zinc-700 bg-zinc-900/50 p-6">
          <h2 className="mb-4 text-lg font-semibold">
            {editServer ? `Edit: ${editServer.name}` : 'New Server'}
          </h2>
          <ServerForm
            initial={editServer}
            onSave={handleSave}
            onCancel={() => { setShowForm(false); setEditServer(undefined); }}
          />
        </div>
      )}

      {servers.length === 0 && !showForm ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-12 text-center">
          <div className="text-zinc-500">No servers configured yet.</div>
          <button
            onClick={() => setShowForm(true)}
            className="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500"
          >
            Add Your First Server
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {servers.map((srv) => (
            <div
              key={srv.name}
              className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/50 p-4"
            >
              <div>
                <div className="flex items-center gap-3">
                  <span className="font-medium text-zinc-100">{srv.name}</span>
                  <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">
                    {srv.transport.type}
                  </span>
                </div>
                <div className="mt-1 text-xs text-zinc-500">
                  {srv.transport.type === 'stdio'
                    ? `${srv.transport.command} ${srv.transport.args?.join(' ') ?? ''}`
                    : srv.transport.url}
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => { setEditServer(srv); setShowForm(true); }}
                  className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
                >
                  Edit
                </button>
                <button
                  onClick={() => handleDelete(srv.name)}
                  className="rounded-md border border-red-500/30 px-3 py-1.5 text-xs text-red-400 hover:bg-red-500/10"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
