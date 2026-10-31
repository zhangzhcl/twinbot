const assert = require('node:assert/strict');
const test = require('node:test');
const { AgentWorker } = require('../dist/agentWorker.js');

class MemoryRunStore {
  constructor() {
    this.run = {
      id: 'run-1',
      userId: 'user-1',
      sessionId: 'session-1',
      status: 'queued',
    };
    this.messages = [{ role: 'user', text: 'Hello' }];
    this.completed = null;
    this.failure = null;
    this.cancelled = false;
  }

  async claimNextRun() {
    if (this.run.status !== 'queued') return null;
    this.run.status = 'running';
    return { ...this.run };
  }

  async getRunMessages() {
    return this.messages;
  }

  async getRun(userId, runId) {
    if (userId !== this.run.userId || runId !== this.run.id) return null;
    return { id: this.run.id, status: this.run.status };
  }

  async listMessages(userId, sessionId) {
      return [{
        id: 'assistant-1',
        sequence: 2,
        role: 'assistant',
        text: this.completed?.text ?? 'ok',
        createdAt: new Date().toISOString(),
      }];
    }

    async completeRun(runId, text) {
    this.completed = { runId: runId.id, text };
    this.run.status = 'completed';
    this.messages.push({ role: 'assistant', text });
  }

  async failRun(runId, error) {
    this.failure = { runId, error };
    this.run.status = 'failed';
  }

  async cancelRun(userId, runId) {
    if (userId !== this.run.userId || runId !== this.run.id) return null;
    if (!['queued', 'running'].includes(this.run.status)) {
      return { id: runId, status: this.run.status };
    }
    this.run.status = 'cancelled';
    this.cancelled = true;
    return { id: runId, status: 'cancelled' };
  }
}

test('worker persists assistant response and completes a queued run', async () => {
  const store = new MemoryRunStore();
  let receivedContext;
  const worker = new AgentWorker({
    store,
    engine: {
      async generate(_messages, context) {
        receivedContext = context;
        return 'Hello back';
      },
    },
    concurrency: 1,
  });

  assert.equal(await worker.processOne(), true);
  assert.deepEqual(receivedContext, {
    id: 'run-1',
    userId: 'user-1',
    sessionId: 'session-1',
    status: 'running',
  });
  assert.deepEqual(store.completed, { runId: 'run-1', text: 'Hello back' });
  assert.equal(store.run.status, 'completed');
  assert.deepEqual(store.messages.at(-1), { role: 'assistant', text: 'Hello back' });
});

test('worker marks a failed generation instead of leaving a run stuck', async () => {
  const store = new MemoryRunStore();
  const worker = new AgentWorker({
    store,
    engine: { async generate() { throw new Error('provider unavailable'); } },
    concurrency: 1,
  });

  assert.equal(await worker.processOne(), true);
  assert.equal(store.run.status, 'failed');
  assert.match(store.failure.error, /provider unavailable/);
});

test('worker does not claim a run when the durable queue is empty', async () => {
  const store = new MemoryRunStore();
  store.run.status = 'completed';
  let called = false;
  const worker = new AgentWorker({
    store,
    engine: { async generate() { called = true; return 'unused'; } },
    concurrency: 1,
  });

  assert.equal(await worker.processOne(), false);
  assert.equal(called, false);
});

test('worker aborts a running generation when its run is cancelled', async () => {
  const store = new MemoryRunStore();
  let receivedSignal;
  const worker = new AgentWorker({
    store,
    engine: {
      generate(_messages, _context, signal) {
        receivedSignal = signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(new Error('Generation aborted'));
          }, { once: true });
          setTimeout(() => reject(new Error('Cancellation test timed out')), 200);
        });
      },
    },
    concurrency: 1,
  });

  const processing = worker.processOne();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(receivedSignal, 'engine must receive an AbortSignal');
  await store.cancelRun('user-1', 'run-1');
  assert.equal(worker.cancelRun('run-1'), true);

  assert.equal(await processing, true);
  assert.equal(receivedSignal.aborted, true);
  assert.equal(store.run.status, 'cancelled');
  assert.equal(store.failure, null);
});

test('worker observes cancellation persisted by another control-api instance', async () => {
  const store = new MemoryRunStore();
  let receivedSignal;
  const worker = new AgentWorker({
    store,
    engine: {
      generate(_messages, _context, signal) {
        receivedSignal = signal;
        return new Promise((resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('Generation aborted')), {
            once: true,
          });
          setTimeout(() => resolve('unexpected reply'), 1000);
        });
      },
    },
    concurrency: 1,
    pollIntervalMs: 5,
  });

  const processing = worker.processOne();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await store.cancelRun('user-1', 'run-1');

  assert.equal(await processing, true);
  assert.equal(receivedSignal.aborted, true);
  assert.equal(store.run.status, 'cancelled');
  assert.equal(store.failure, null);
});

test('worker refuses to cancel a run it is not processing', () => {
  const worker = new AgentWorker({
    store: new MemoryRunStore(),
    engine: { async generate() { return 'unused'; } },
    concurrency: 1,
  });

  assert.equal(worker.cancelRun('run-1'), false);
});
