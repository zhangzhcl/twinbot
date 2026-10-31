const assert = require('node:assert/strict');
const test = require('node:test');
const { SessionDeltaMessageSchema } = require('@lca/ws-protocol');
const { LocalToolRouter } = require('../dist/toolRouter.js');
const { AgentWorker } = require('../dist/agentWorker.js');

test('session.delta schema accepts structured run lifecycle payloads', () => {
  const parsed = SessionDeltaMessageSchema.safeParse({
    type: 'session.delta',
    sessionId: 'session-1',
    delta: {
      kind: 'run.status',
      runId: 'run-1',
      status: 'completed',
      at: new Date().toISOString(),
    },
  });
  assert.equal(parsed.success, true);
});

test('toolRouter.publishSessionDelta sends to registered machine sockets', () => {
  const router = new LocalToolRouter({
    async recordToolCallStarted() {},
    async recordToolCallStatus() {},
  });
  const sent = [];
  const socket = {
    readyState: 1,
    send(data) { sent.push(JSON.parse(data)); },
  };
  router.registerMachine('user-a', 'machine-a', ['fs'], socket);
  router.publishSessionDelta('user-a', 'session-1', {
    kind: 'run.status',
    runId: 'run-1',
    status: 'running',
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'session.delta');
  assert.equal(sent[0].sessionId, 'session-1');
  assert.equal(sent[0].delta.kind, 'run.status');
});

test('AgentWorker emits run.status and message.created deltas', async () => {
  const events = [];
  const messages = [
    { role: 'user', text: 'hi' },
  ];
  const store = {
    async claimNextRun() {
      return { id: 'run-1', userId: 'user-a', sessionId: 'session-1' };
    },
    async getRunMessages() { return messages; },
    async completeRun() {},
    async failRun() { throw new Error('should not fail'); },
    async getRun() { return { id: 'run-1', status: 'running' }; },
    async listMessages() {
      return [{
        id: 'msg-1',
        sequence: 2,
        role: 'assistant',
        text: 'hello back',
        createdAt: new Date().toISOString(),
      }];
    },
  };
  const worker = new AgentWorker({
    store,
    engine: {
      async generate() { return 'hello back'; },
    },
    concurrency: 1,
    publishSessionDelta: (userId, sessionId, delta) => {
      events.push({ userId, sessionId, delta });
    },
  });
  assert.equal(await worker.processOne(), true);
  assert.ok(events.some((e) => e.delta.kind === 'run.status' && e.delta.status === 'running'));
  assert.ok(events.some((e) => e.delta.kind === 'message.created'));
  assert.ok(events.some((e) => e.delta.kind === 'run.status' && e.delta.status === 'completed'));
});
