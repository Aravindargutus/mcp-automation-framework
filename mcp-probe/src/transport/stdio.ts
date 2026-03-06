/**
 * Stdio transport — manages a child process running an MCP server.
 *
 * Key design decisions (from architect review):
 * - Crash detection via child.on('exit') — aborts pending requests immediately
 * - Stderr capture (last 10KB) for diagnostics on crash
 * - Subprocess registry for cleanup on process.exit
 * - Proper shutdown: close stdin → SIGTERM → wait → SIGKILL
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { MCPTransport, StdioTransportOptions, TransportEvents, TransportMetrics } from './types.js';

const DEFAULT_STDERR_LIMIT = 10 * 1024; // 10KB
const SIGTERM_GRACE_MS = 5_000;

// Global subprocess registry — cleanup on unexpected exit
const activeProcesses = new Set<ChildProcess>();
function cleanupAllProcesses() {
  for (const proc of activeProcesses) {
    try {
      proc.kill('SIGKILL');
    } catch {
      // Already dead
    }
  }
  activeProcesses.clear();
}
process.on('exit', cleanupAllProcesses);
process.on('SIGINT', () => { cleanupAllProcesses(); process.exit(130); });
process.on('SIGTERM', () => { cleanupAllProcesses(); process.exit(143); });

export class StdioTransport implements MCPTransport {
  readonly type = 'stdio' as const;
  private child: ChildProcess | null = null;
  private buffer = '';
  private stderrBuffer = '';
  private handlers: Map<keyof TransportEvents, Set<(...args: unknown[]) => void>> = new Map();
  private _isConnected = false;
  private _metrics: TransportMetrics = {
    messagesSent: 0,
    messagesReceived: 0,
    bytesOut: 0,
    bytesIn: 0,
  };

  constructor(private options: StdioTransportOptions) {}

  get isConnected(): boolean {
    return this._isConnected;
  }

  get metrics(): TransportMetrics {
    return { ...this._metrics };
  }

  get stderr(): string {
    return this.stderrBuffer;
  }

  async connect(): Promise<void> {
    if (this.child) throw new Error('Already connected');

    const startTime = Date.now();

    this.child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    activeProcesses.add(this.child);

    // Stdout → parse JSON-RPC messages (newline-delimited JSON)
    this.child.stdout!.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      this._metrics.bytesIn += chunk.byteLength;
      this.buffer += text;
      this.processBuffer();
    });

    // Stderr → capture last N bytes for diagnostics
    const stderrLimit = this.options.stderrCaptureLimitBytes ?? DEFAULT_STDERR_LIMIT;
    this.child.stderr!.on('data', (chunk: Buffer) => {
      this.stderrBuffer += chunk.toString();
      if (this.stderrBuffer.length > stderrLimit) {
        this.stderrBuffer = this.stderrBuffer.slice(-stderrLimit);
      }
    });

    // Crash detection — the critical fix from architect review
    this.child.on('exit', (code, signal) => {
      this._isConnected = false;
      activeProcesses.delete(this.child!);
      this.emit('close', code ?? undefined, signal ?? undefined);
    });

    this.child.on('error', (err) => {
      this._isConnected = false;
      this.emit('error', err);
    });

    // Wait for the process to be ready
    // We consider it ready when: process is spawned and has not immediately exited
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        cleanup();
        reject(new Error(`Failed to start server: ${err.message}`));
      };
      const onExit = (code: number | null) => {
        cleanup();
        reject(new Error(`Server exited immediately with code ${code}. stderr: ${this.stderrBuffer.slice(-500)}`));
      };
      const cleanup = () => {
        this.child?.off('error', onError);
        this.child?.off('exit', onExit);
      };

      this.child!.on('error', onError);
      this.child!.once('exit', onExit);

      // Give the process a brief moment to fail fast, then consider it connected
      setTimeout(() => {
        cleanup();
        this._isConnected = true;
        this._metrics.connectTime = Date.now() - startTime;
        resolve();
      }, 500);
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.child?.stdin?.writable) {
      throw new Error('Transport not connected or stdin not writable');
    }

    const data = JSON.stringify(message) + '\n';
    this._metrics.bytesOut += Buffer.byteLength(data);
    this._metrics.messagesSent++;
    this._metrics.lastActivityAt = Date.now();

    return new Promise((resolve, reject) => {
      this.child!.stdin!.write(data, (err) => {
        if (err) reject(new Error(`Failed to write to stdin: ${err.message}`));
        else resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (!this.child) return;

    const child = this.child;
    this.child = null;
    this._isConnected = false;

    // Graceful shutdown: close stdin → SIGTERM → wait → SIGKILL
    try {
      child.stdin?.end();
    } catch {
      // stdin may already be closed
    }

    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already dead
        }
        resolve();
      }, SIGTERM_GRACE_MS);

      child.on('exit', () => {
        clearTimeout(killTimer);
        resolve();
      });

      try {
        child.kill('SIGTERM');
      } catch {
        clearTimeout(killTimer);
        resolve();
      }
    });

    activeProcesses.delete(child);
  }

  kill(): void {
    if (this.child) {
      try {
        this.child.kill('SIGKILL');
      } catch {
        // Already dead
      }
      activeProcesses.delete(this.child);
      this.child = null;
      this._isConnected = false;
    }
  }

  on<K extends keyof TransportEvents>(event: K, handler: TransportEvents[K]): void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler as (...args: unknown[]) => void);
  }

  off<K extends keyof TransportEvents>(event: K, handler: TransportEvents[K]): void {
    this.handlers.get(event)?.delete(handler as (...args: unknown[]) => void);
  }

  private emit<K extends keyof TransportEvents>(event: K, ...args: Parameters<TransportEvents[K]>): void {
    const handlers = this.handlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(...(args as unknown[]));
        } catch (err) {
          console.error(`Error in ${event} handler:`, err);
        }
      }
    }
  }

  private processBuffer(): void {
    const lines = this.buffer.split('\n');
    // Keep the last incomplete line in the buffer
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const message = JSON.parse(trimmed) as JSONRPCMessage;
        this._metrics.messagesReceived++;
        this._metrics.lastActivityAt = Date.now();
        this.emit('message', message);
      } catch {
        // Non-JSON output (e.g. server debug logs) — ignore
      }
    }
  }
}
