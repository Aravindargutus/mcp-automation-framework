import { agenticEventBus } from '@/lib/agentic-event-emitter';
import { getAgenticRun } from '@/lib/agentic-store';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;

      const send = (data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          // Stream closed
        }
      };

      const closeStream = () => {
        if (closed) return;
        closed = true;
        try { controller.close(); } catch { /* Already closed */ }
      };

      // Send initial heartbeat
      send({ type: 'connected', runId });

      const unsubscribe = agenticEventBus.subscribe(runId, (event) => {
        send(event);

        // Close stream when run ends
        if (event.type === 'agentic:run:end') {
          setTimeout(closeStream, 100);
        }
      });

      // Race condition fix: check if run already completed before SSE connected
      const run = getAgenticRun(runId);
      if (run && run.status !== 'running') {
        send({
          type: 'agentic:run:end',
          runId,
          data: run.result ?? { error: 'Run already finished', status: run.status },
        });
        setTimeout(() => {
          unsubscribe();
          closeStream();
        }, 100);
      }

      // Cleanup on abort
      _req.signal.addEventListener('abort', () => {
        unsubscribe();
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
