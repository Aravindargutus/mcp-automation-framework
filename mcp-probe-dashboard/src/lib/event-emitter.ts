/**
 * SSE Event bridge — connects runner callbacks to HTTP event streams.
 */
import { EventEmitter } from 'events';

export interface RunEvent {
  type: 'server:start' | 'server:end' | 'suite:start' | 'suite:end' | 'test:start' | 'test:end' | 'run:end';
  timestamp: number;
  data: unknown;
}

class RunEventBus extends EventEmitter {
  emit(runId: string, event: RunEvent): boolean {
    return super.emit(runId, event);
  }

  subscribe(runId: string, handler: (event: RunEvent) => void): () => void {
    super.on(runId, handler);
    return () => super.off(runId, handler);
  }
}

export const eventBus = new RunEventBus();
