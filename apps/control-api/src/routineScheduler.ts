import type { ConversationStore, RoutineRecord } from './conversationStore';
import { SessionBusyError } from './conversationStore';
import { nextCronFire } from './cron';
import type { SessionDeltaPublisher } from './sessionDelta';

export interface RoutineSchedulerOptions {
  store: ConversationStore;
  publishSessionDelta?: SessionDeltaPublisher;
  pollIntervalMs?: number;
  /** When a routine has no session_id, create a dedicated session with this title prefix. */
  sessionTitlePrefix?: string;
}

/**
 * Polls due routines and enqueues agent runs via appendUserMessage.
 * Supports cron, interval, and named event triggers.
 */
export class RoutineScheduler {
  private stopped = true;
  private loop: Promise<void> | null = null;
  private readonly pollIntervalMs: number;
  private readonly sessionTitlePrefix: string;

  constructor(private readonly options: RoutineSchedulerOptions) {
    this.pollIntervalMs = options.pollIntervalMs ?? 15_000;
    this.sessionTitlePrefix = options.sessionTitlePrefix ?? 'Routine: ';
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.loop = this.consume();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.loop) await this.loop;
    this.loop = null;
  }

  /** Fire event-triggered routines (e.g. session.created). */
  async notifyEvent(userId: string, eventType: string, context?: { sessionId?: string }): Promise<number> {
    const due = await this.options.store.listDueRoutines(Date.now(), { userId, eventType });
    let fired = 0;
    for (const routine of due) {
      const ok = await this.fireRoutine(routine, context?.sessionId);
      if (ok) fired += 1;
    }
    return fired;
  }

  async processDue(nowMs = Date.now()): Promise<number> {
    const due = await this.options.store.listDueRoutines(nowMs);
    let fired = 0;
    for (const routine of due) {
      const ok = await this.fireRoutine(routine);
      if (ok) fired += 1;
    }
    return fired;
  }

  private async consume(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.processDue();
      } catch (error) {
        console.error(
          '[routine-scheduler] tick failed:',
          error instanceof Error ? error.message : 'unknown error',
        );
      }
      await delay(this.pollIntervalMs, () => this.stopped);
    }
  }

  private async fireRoutine(routine: RoutineRecord, overrideSessionId?: string): Promise<boolean> {
    let sessionId = overrideSessionId ?? routine.sessionId ?? null;
    try {
      if (!sessionId) {
        const session = await this.options.store.createSession(
          routine.ownerUserId,
          `${this.sessionTitlePrefix}${routine.name}`.slice(0, 120),
        );
        sessionId = session.id;
      }

      let accepted;
      try {
        accepted = await this.options.store.appendUserMessage(
          routine.ownerUserId,
          sessionId,
          routine.prompt,
        );
      } catch (error) {
        if (error instanceof SessionBusyError) {
          // Session busy: retry soon without advancing schedule far
          await this.options.store.markRoutineFired(routine.id, {
            nextRunAt: new Date(Date.now() + 60_000).toISOString(),
            lastError: 'SESSION_BUSY',
          });
          return false;
        }
        throw error;
      }

      if (!accepted) {
        await this.options.store.markRoutineFired(routine.id, {
          nextRunAt: this.computeNextRun(routine, new Date()).toISOString(),
          lastError: 'SESSION_NOT_FOUND',
        });
        return false;
      }

      const nextRunAt = routine.scheduleKind === 'event'
        ? null
        : this.computeNextRun(routine, new Date()).toISOString();

      await this.options.store.markRoutineFired(routine.id, {
        nextRunAt,
        lastError: null,
        bindSessionId: routine.sessionId ? undefined : sessionId,
      });

      this.options.publishSessionDelta?.(routine.ownerUserId, sessionId, {
        kind: 'routine.fired',
        routineId: routine.id,
        routineName: routine.name,
        runId: accepted.run.id,
        status: 'queued',
        message: {
          id: accepted.message.id,
          sequence: accepted.message.sequence,
          role: accepted.message.role,
          text: accepted.message.text,
          createdAt: accepted.message.createdAt,
        },
        at: new Date().toISOString(),
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.options.store.markRoutineFired(routine.id, {
        nextRunAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        lastError: message.slice(0, 500),
      }).catch(() => undefined);
      console.error(`[routine-scheduler] failed to fire ${routine.id}:`, message);
      return false;
    }
  }

  private computeNextRun(routine: RoutineRecord, from: Date): Date {
    if (routine.scheduleKind === 'interval') {
      const ms = Math.max(60_000, routine.intervalMs ?? 3_600_000);
      return new Date(from.getTime() + ms);
    }
    if (routine.scheduleKind === 'cron' && routine.cronExpr) {
      return nextCronFire(routine.cronExpr, from) ?? new Date(from.getTime() + 3_600_000);
    }
    return new Date(from.getTime() + 3_600_000);
  }
}

function delay(ms: number, shouldStop: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const check = setInterval(() => {
      if (shouldStop()) {
        clearTimeout(timer);
        clearInterval(check);
        resolve();
      }
    }, 250);
  });
}
