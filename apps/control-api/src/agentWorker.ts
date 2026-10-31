import type {
  AgentPromptMessage,
  ConversationStore,
  QueuedAgentRun,
} from './conversationStore';
import type { SessionDeltaPublisher } from './sessionDelta';

export interface AgentEngine {
  generate(
    messages: AgentPromptMessage[],
    context?: QueuedAgentRun,
    signal?: AbortSignal,
  ): Promise<string>;
}

interface AgentWorkerOptions {
  store: ConversationStore;
  engine: AgentEngine;
  concurrency: number;
  pollIntervalMs?: number;
  leaseMs?: number;
  publishSessionDelta?: SessionDeltaPublisher;
}

const delay = (
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    }
    signal?.addEventListener('abort', finish, { once: true });
  });

export class AgentWorker {
  private stopped = true;
  private loops: Promise<void>[] = [];
  private readonly pollIntervalMs: number;
  private readonly leaseMs: number;
  private readonly activeRuns = new Map<string, AbortController>();

  constructor(private readonly options: AgentWorkerOptions) {
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
      throw new Error('Agent worker concurrency must be a positive integer');
    }
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.leaseMs = options.leaseMs ?? 60_000;
  }

  async processOne(): Promise<boolean> {
    const run = await this.options.store.claimNextRun(this.leaseMs);
    if (!run) return false;
    await this.processRun(run);
    return true;
  }

  cancelRun(runId: string): boolean {
    const controller = this.activeRuns.get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.loops = Array.from({ length: this.options.concurrency }, () =>
      this.consume(),
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all(this.loops);
    this.loops = [];
  }

  private async consume(): Promise<void> {
    while (!this.stopped) {
      try {
        const processed = await this.processOne();
        if (!processed && !this.stopped) await delay(this.pollIntervalMs);
      } catch (error) {
        console.error(
          '[agent-worker] loop processing failed:',
          error instanceof Error ? error.message : 'unknown error',
        );
        if (!this.stopped) await delay(this.pollIntervalMs);
      }
    }
  }

  private async processRun(run: QueuedAgentRun): Promise<void> {
    const controller = new AbortController();
    const monitorController = new AbortController();
    this.activeRuns.set(run.id, controller);
    const publish = this.options.publishSessionDelta;
    const cancellationMonitor = this.watchCancellation(
      run,
      controller,
      monitorController.signal,
    );
    try {
      publish?.(run.userId, run.sessionId, {
        kind: 'run.status',
        runId: run.id,
        status: 'running',
        at: new Date().toISOString(),
      });
      const messages = await this.options.store.getRunMessages(run);
      if (controller.signal.aborted) {
        publish?.(run.userId, run.sessionId, {
          kind: 'run.status',
          runId: run.id,
          status: 'cancelled',
          at: new Date().toISOString(),
        });
        return;
      }
      const reply = await this.options.engine.generate(
        messages,
        run,
        controller.signal,
      );
      if (controller.signal.aborted) {
        publish?.(run.userId, run.sessionId, {
          kind: 'run.status',
          runId: run.id,
          status: 'cancelled',
          at: new Date().toISOString(),
        });
        return;
      }
      if (reply.trim().length === 0) {
        throw new Error('Agent returned empty assistant content');
      }
      await this.options.store.completeRun(run, reply);
      const stored = await this.options.store.listMessages(run.userId, run.sessionId);
      const lastAssistant = [...(stored ?? [])].reverse().find((m) => m.role === 'assistant');
      if (lastAssistant) {
        publish?.(run.userId, run.sessionId, {
          kind: 'message.created',
          runId: run.id,
          message: {
            id: lastAssistant.id,
            sequence: lastAssistant.sequence,
            role: lastAssistant.role,
            text: lastAssistant.text,
            createdAt: lastAssistant.createdAt,
          },
          at: new Date().toISOString(),
        });
      }
      publish?.(run.userId, run.sessionId, {
        kind: 'run.status',
        runId: run.id,
        status: 'completed',
        at: new Date().toISOString(),
      });
    } catch (error) {
      if (controller.signal.aborted) {
        publish?.(run.userId, run.sessionId, {
          kind: 'run.status',
          runId: run.id,
          status: 'cancelled',
          at: new Date().toISOString(),
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      await this.options.store.failRun(run, message);
      publish?.(run.userId, run.sessionId, {
        kind: 'run.status',
        runId: run.id,
        status: 'failed',
        error: message.slice(0, 500),
        at: new Date().toISOString(),
      });
    } finally {
      monitorController.abort();
      await cancellationMonitor;
      this.activeRuns.delete(run.id);
    }
  }

  private async watchCancellation(
    run: QueuedAgentRun,
    controller: AbortController,
    monitorSignal: AbortSignal,
  ): Promise<void> {
    while (!monitorSignal.aborted && !controller.signal.aborted) {
      try {
        const current = await this.options.store.getRun(run.userId, run.id);
        if (current?.status === 'cancelled') {
          controller.abort();
          return;
        }
      } catch (error) {
        console.error(
          `[agent-worker] cancellation check failed for run ${run.id}:`,
          error instanceof Error ? error.message : 'unknown error',
        );
      }
      await delay(this.pollIntervalMs, monitorSignal);
    }
  }
}
