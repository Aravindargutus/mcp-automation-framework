/**
 * LLM Judge configuration store — persists to data/llm-config.json.
 * Same pattern as server-store.ts.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

export interface LLMJudgeSettings {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
}

const DATA_DIR = join(process.cwd(), 'src', 'data');
const CONFIG_FILE = join(DATA_DIR, 'llm-config.json');

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

let cached: LLMJudgeSettings | null = null;

function load(): void {
  ensureDataDir();
  if (existsSync(CONFIG_FILE)) {
    try {
      cached = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    } catch {
      cached = null;
    }
  }
}

// Load on init
load();

export function getLLMConfig(): LLMJudgeSettings | null {
  return cached ? { ...cached } : null;
}

export function saveLLMConfig(config: LLMJudgeSettings): void {
  cached = { ...config };
  ensureDataDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(cached, null, 2));
}
