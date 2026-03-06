/**
 * Task Client — handles the async Tasks primitive (2025-11-25 spec).
 *
 * When a server declares tasks.requests.tools.call, tool calls return
 * CreateTaskResult instead of direct results. This client manages:
 * - Task creation via tools/call
 * - Polling via tasks/get at server-specified intervals
 * - Result retrieval via tasks/result
 * - Cancellation via tasks/cancel
 * - TTL awareness
 */
import { RawMCPClient, type RawResponse } from './raw-client.js';

export type TaskStatus = 'working' | 'completed' | 'failed' | 'canceled' | 'input_required';

export interface TaskState {
  taskId: string;
  status: TaskStatus;
  progress?: number;
  total?: number;
  message?: string;
  pollInterval?: number;
  ttl?: number;
}

export interface TaskResult {
  taskId: string;
  status: TaskStatus;
  result?: unknown;
  error?: unknown;
  states: TaskState[];
  durationMs: number;
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_TASK_TIMEOUT_MS = 300_000; // 5 minutes

export class TaskClient {
  constructor(
    private rawClient: RawMCPClient,
    private requestTimeoutMs = 30_000,
  ) {}

  /**
   * Call a tool that may return a task, and poll until completion.
   */
  async callToolWithTaskSupport(
    toolName: string,
    args: unknown,
    taskTimeoutMs = DEFAULT_TASK_TIMEOUT_MS,
  ): Promise<TaskResult> {
    const startTime = Date.now();
    const states: TaskState[] = [];

    // 1. Initial tool call
    const callResponse = await this.rawClient.sendRequest(
      'tools/call',
      { name: toolName, arguments: args },
      this.requestTimeoutMs,
    );

    if (callResponse.error || !callResponse.message) {
      return {
        taskId: '',
        status: 'failed',
        error: callResponse.error?.message ?? 'No response',
        states,
        durationMs: Date.now() - startTime,
      };
    }

    const msgAny = callResponse.message as Record<string, unknown>;
    const result = msgAny.result as Record<string, unknown> | undefined;

    // Check if it's a direct result (not a task)
    if (!result || !('taskId' in result)) {
      return {
        taskId: '',
        status: result?.isError ? 'failed' : 'completed',
        result,
        states,
        durationMs: Date.now() - startTime,
      };
    }

    // It's a task — start polling
    const taskId = result.taskId as string;
    let currentState: TaskState = {
      taskId,
      status: (result.status as TaskStatus) ?? 'working',
      pollInterval: result.pollInterval as number | undefined,
    };
    states.push({ ...currentState });

    // 2. Poll loop
    while (
      currentState.status === 'working' ||
      currentState.status === 'input_required'
    ) {
      // Check timeout
      if (Date.now() - startTime > taskTimeoutMs) {
        // Try to cancel the task
        await this.cancelTask(taskId).catch(() => {});
        return {
          taskId,
          status: 'failed',
          error: `Task timed out after ${taskTimeoutMs}ms`,
          states,
          durationMs: Date.now() - startTime,
        };
      }

      // Wait for poll interval
      const interval = currentState.pollInterval ?? DEFAULT_POLL_INTERVAL_MS;
      await this.sleep(interval);

      // Poll for status
      const pollResponse = await this.rawClient.sendRequest(
        'tasks/get',
        { taskId },
        this.requestTimeoutMs,
      );

      if (pollResponse.error || !pollResponse.message) {
        return {
          taskId,
          status: 'failed',
          error: pollResponse.error?.message ?? 'Poll failed',
          states,
          durationMs: Date.now() - startTime,
        };
      }

      const pollResult = (pollResponse.message as Record<string, unknown>).result as Record<string, unknown>;
      if (!pollResult) break;

      currentState = {
        taskId,
        status: (pollResult.status as TaskStatus) ?? 'failed',
        progress: pollResult.progress as number | undefined,
        total: pollResult.total as number | undefined,
        message: pollResult.message as string | undefined,
        pollInterval: pollResult.pollInterval as number | undefined,
      };
      states.push({ ...currentState });
    }

    // 3. Get final result if completed
    if (currentState.status === 'completed') {
      const resultResponse = await this.rawClient.sendRequest(
        'tasks/result',
        { taskId },
        this.requestTimeoutMs,
      );

      if (resultResponse.error || !resultResponse.message) {
        return {
          taskId,
          status: 'failed',
          error: resultResponse.error?.message ?? 'Result retrieval failed',
          states,
          durationMs: Date.now() - startTime,
        };
      }

      const finalResult = (resultResponse.message as Record<string, unknown>).result;
      return {
        taskId,
        status: 'completed',
        result: finalResult,
        states,
        durationMs: Date.now() - startTime,
      };
    }

    // Task ended in a non-completed state
    return {
      taskId,
      status: currentState.status,
      error: currentState.message,
      states,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Cancel a running task.
   */
  async cancelTask(taskId: string): Promise<RawResponse> {
    return this.rawClient.sendRequest('tasks/cancel', { taskId }, this.requestTimeoutMs);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
