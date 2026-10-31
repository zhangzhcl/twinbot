const assert = require('node:assert/strict');
const test = require('node:test');
const { RoutineScheduler } = require('../dist/routineScheduler.js');
const { nextCronFire } = require('../dist/cron.js');

/** In-memory store covering memory + routine claim/fire paths used by the scheduler. */
class MemoryRoutineStore {
  constructor() {
    this.memories = new Map();
    this.routines = new Map();
    this.sessions = new Map();
    this.appended = [];
  }

  async listMemories(userId) {
    return [...this.memories.values()].filter((m) => m.userId === userId);
  }

  async upsertMemory(userId, input) {
    const existing = [...this.memories.values()].find(
      (m) => m.userId === userId && m.key === input.key,
    );
    const record = {
      id: existing?.id ?? `mem-${this.memories.size + 1}`,
      userId,
      key: input.key,
      content: input.content,
      importance: input.importance ?? 0,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.memories.set(record.id, record);
    return record;
  }

  async deleteMemory(userId, memoryId) {
    const row = this.memories.get(memoryId);
    if (!row || row.userId !== userId) return false;
    this.memories.delete(memoryId);
    return true;
  }

  async getMemoryByKey(userId, key) {
    return [...this.memories.values()].find((m) => m.userId === userId && m.key === key) ?? null;
  }

  async createSession(userId, title) {
    const session = { id: `session-${this.sessions.size + 1}`, userId, title };
    this.sessions.set(session.id, session);
    return session;
  }

  async appendUserMessage(userId, sessionId, text) {
    const accepted = {
      message: {
        id: `msg-${this.appended.length + 1}`,
        sequence: this.appended.length + 1,
        role: 'user',
        text,
        createdAt: new Date().toISOString(),
      },
      run: { id: `run-${this.appended.length + 1}`, status: 'queued' },
    };
    this.appended.push({ userId, sessionId, text, accepted });
    return accepted;
  }

  async listDueRoutines(nowMs, filter) {
    return [...this.routines.values()].filter((routine) => {
      if (!routine.enabled) return false;
      if (filter?.userId && routine.ownerUserId !== filter.userId) return false;
      if (filter?.eventType) {
        return routine.scheduleKind === 'event' && routine.eventType === filter.eventType;
      }
      if (routine.scheduleKind === 'event') return false;
      if (!routine.nextRunAt) return false;
      return Date.parse(routine.nextRunAt) <= nowMs;
    });
  }

  async markRoutineFired(routineId, update) {
    const routine = this.routines.get(routineId);
    if (!routine) return;
    routine.lastRunAt = new Date().toISOString();
    routine.nextRunAt = update.nextRunAt;
    routine.lastError = update.lastError ?? null;
    if (update.bindSessionId) routine.sessionId = update.bindSessionId;
    routine.updatedAt = new Date().toISOString();
  }

  seedRoutine(routine) {
    this.routines.set(routine.id, routine);
  }
}

test('memory upsert/list/delete round-trip in store facade', async () => {
  const store = new MemoryRoutineStore();
  const saved = await store.upsertMemory('user-a', {
    key: 'pref.theme',
    content: 'dark',
    importance: 10,
  });
  assert.equal(saved.key, 'pref.theme');
  const listed = await store.listMemories('user-a');
  assert.equal(listed.length, 1);
  assert.equal((await store.getMemoryByKey('user-a', 'pref.theme')).content, 'dark');
  assert.equal(await store.deleteMemory('user-a', saved.id), true);
  assert.equal((await store.listMemories('user-a')).length, 0);
});

test('RoutineScheduler claims due interval routine and enqueues a run', async () => {
  const store = new MemoryRoutineStore();
  const deltas = [];
  store.seedRoutine({
    id: 'routine-1',
    ownerUserId: 'user-a',
    name: 'morning-brief',
    prompt: 'Summarize my day',
    sessionId: null,
    scheduleKind: 'interval',
    cronExpr: null,
    intervalMs: 60_000,
    eventType: null,
    enabled: true,
    nextRunAt: new Date(Date.now() - 1000).toISOString(),
    lastRunAt: null,
    lastError: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const scheduler = new RoutineScheduler({
    store,
    publishSessionDelta: (userId, sessionId, delta) => {
      deltas.push({ userId, sessionId, delta });
    },
  });

  const fired = await scheduler.processDue(Date.now());
  assert.equal(fired, 1);
  assert.equal(store.appended.length, 1);
  assert.equal(store.appended[0].text, 'Summarize my day');
  assert.ok(store.routines.get('routine-1').nextRunAt);
  assert.ok(deltas.some((d) => d.delta.kind === 'routine.fired'));
});

test('event routines fire via notifyEvent', async () => {
  const store = new MemoryRoutineStore();
  store.seedRoutine({
    id: 'routine-event',
    ownerUserId: 'user-a',
    name: 'on-session',
    prompt: 'Welcome the user',
    sessionId: null,
    scheduleKind: 'event',
    cronExpr: null,
    intervalMs: null,
    eventType: 'session.created',
    enabled: true,
    nextRunAt: null,
    lastRunAt: null,
    lastError: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const scheduler = new RoutineScheduler({ store });
  const fired = await scheduler.notifyEvent('user-a', 'session.created', {
    sessionId: 'session-fixed',
  });
  assert.equal(fired, 1);
  assert.equal(store.appended[0].sessionId, 'session-fixed');
});

test('nextCronFire used for cron schedule computation stays valid', () => {
  const next = nextCronFire('*/5 * * * *', new Date('2026-10-31T10:01:00'));
  assert.ok(next);
  assert.equal(next.getMinutes() % 5, 0);
});
