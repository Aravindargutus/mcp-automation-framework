/**
 * SSE Event bridge for agentic runs — separate from the standard run event bus.
 */
import { EventEmitter } from 'events';

export interface AgenticEvent {
  type:
    | 'agentic:run:start'
    | 'agentic:agent:start'
    | 'agentic:agent:end'
    | 'agentic:entity:start'
    | 'agentic:entity:end'
    | 'agentic:step:start'
    | 'agentic:step:end'
    | 'agentic:run:end';
  timestamp: number;
  data: unknown;
}

class AgenticEventBus extends EventEmitter {
  emit(runId: string, event: AgenticEvent): boolean {
    return super.emit(runId, event);
  }

  subscribe(runId: string, handler: (event: AgenticEvent) => void): () => void {
    super.on(runId, handler);
    return () => super.off(runId, handler);
  }
}

// Use globalThis to survive Next.js HMR re-evaluations in dev mode
const g = globalThis as unknown as { __agenticEventBus?: AgenticEventBus };
if (!g.__agenticEventBus) {
  g.__agenticEventBus = new AgenticEventBus();
}
export const agenticEventBus = g.__agenticEventBus;
