import { eventBus } from '@/lib/event-emitter';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      const send = (data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          // Stream closed
        }
      };

      // Send initial heartbeat
      send({ type: 'connected', runId });

      const unsubscribe = eventBus.subscribe(runId, (event) => {
        send(event);

        // Close stream when run ends
        if (event.type === 'run:end') {
          setTimeout(() => {
            try {
              controller.close();
            } catch {
              // Already closed
            }
          }, 100);
        }
      });

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
