/**
 * Server configuration store — persists to data/servers.json.
 * Also manages OAuth tokens per server.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { ServerConfig } from './probe-client';

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType?: string;
}

const DATA_DIR = join(process.cwd(), 'src', 'data');
const SERVERS_FILE = join(DATA_DIR, 'servers.json');
const TOKENS_FILE = join(DATA_DIR, 'oauth-tokens.json');

let servers: ServerConfig[] = [];

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function load(): void {
  ensureDataDir();
  if (existsSync(SERVERS_FILE)) {
    try {
      servers = JSON.parse(readFileSync(SERVERS_FILE, 'utf-8'));
    } catch {
      servers = [];
    }
  }
}

function save(): void {
  ensureDataDir();
  writeFileSync(SERVERS_FILE, JSON.stringify(servers, null, 2));
}

// Load on init
load();

export function listServers(): ServerConfig[] {
  return [...servers];
}

export function getServer(name: string): ServerConfig | undefined {
  return servers.find((s) => s.name === name);
}

export function addServer(config: ServerConfig): void {
  const existing = servers.findIndex((s) => s.name === config.name);
  if (existing >= 0) {
    servers[existing] = config;
  } else {
    servers.push(config);
  }
  save();
}

export function removeServer(name: string): boolean {
  const before = servers.length;
  servers = servers.filter((s) => s.name !== name);
  if (servers.length < before) {
    save();
    removeOAuthTokens(name);
    return true;
  }
  return false;
}

// --- OAuth token management ---

let oauthTokens: Record<string, OAuthTokens> = {};

function loadTokens(): void {
  ensureDataDir();
  if (existsSync(TOKENS_FILE)) {
    try {
      oauthTokens = JSON.parse(readFileSync(TOKENS_FILE, 'utf-8'));
    } catch {
      oauthTokens = {};
    }
  }
}

function saveTokens(): void {
  ensureDataDir();
  writeFileSync(TOKENS_FILE, JSON.stringify(oauthTokens, null, 2));
}

loadTokens();

export function getOAuthTokens(serverName: string): OAuthTokens | undefined {
  return oauthTokens[serverName];
}

export function setOAuthTokens(serverName: string, tokens: OAuthTokens): void {
  oauthTokens[serverName] = tokens;
  saveTokens();
}

export function removeOAuthTokens(serverName: string): void {
  delete oauthTokens[serverName];
  saveTokens();
}
