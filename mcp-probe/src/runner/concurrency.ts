/**
 * Concurrency limiter — semaphore-based, not unbounded Promise.all().
 * Prevents resource exhaustion when testing 100+ servers in parallel.
 */

export class Semaphore {
  private current = 0;
  private queue: Array<() => void> = [];

  constructor(private maxConcurrent: number) {}

  async acquire(): Promise<void> {
    if (this.current < this.maxConcurrent) {
      this.current++;
      return;
    }

    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.current++;
        resolve();
      });
    });
  }

  release(): void {
    this.current--;
    const next = this.queue.shift();
    if (next) next();
  }

  get activeCount(): number {
    return this.current;
  }

  get waitingCount(): number {
    return this.queue.length;
  }
}

/**
 * Run async tasks with a concurrency limit.
 */
export async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  maxConcurrent: number,
): Promise<T[]> {
  const semaphore = new Semaphore(maxConcurrent);
  const results: T[] = [];

  const wrappedTasks = tasks.map(async (task, index) => {
    await semaphore.acquire();
    try {
      const result = await task();
      results[index] = result;
    } finally {
      semaphore.release();
    }
  });

  await Promise.all(wrappedTasks);
  return results;
}
