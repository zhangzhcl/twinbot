const assert = require('node:assert/strict');
const test = require('node:test');
const { LocalToolRouter } = require('../dist/toolRouter.js');

class FakeSocket {
  readyState = 1;
  sent = [];
  send(message) { this.sent.push(JSON.parse(message)); }
}

function createAuditStore() {
  return {
    async recordToolCallStarted() {},
    async recordToolCallStatus() {},
  };
}

async function waitForRequest(socket) {
  const deadline = Date.now() + 1000;
  while (socket.sent.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1));
  }
  return socket.sent[0];
}

test('cloud tools honor selected runtime instead of eligible[0]', async () => {
  const router = new LocalToolRouter(createAuditStore());
  const socketA = new FakeSocket();
  const socketB = new FakeSocket();
  router.registerRuntime('user-a', 'pod-a', ['fs'], socketA);
  router.registerRuntime('user-a', 'pod-b', ['fs'], socketB);

  assert.equal(router.selectRuntime('user-a', 'pod-b'), true);
  const pending = router.requestCloudTool(
    'user-a',
    'fs.list',
    { path: '.' },
    1000,
    { runId: 'run-a', sessionId: 'session-a' },
  );
  const request = await waitForRequest(socketB);
  assert.equal(request.tool, 'fs.list');
  assert.equal(socketA.sent.length, 0);

  await router.handleResult(socketB, {
    type: 'tool.result',
    requestId: request.requestId,
    result: { ok: true, data: { path: '.', entries: [] } },
  });
  assert.equal((await pending).ok, true);
});

test('multiple online runtimes without selection require TARGET_SELECTION_REQUIRED', async () => {
  const router = new LocalToolRouter(createAuditStore());
  router.registerRuntime('user-a', 'pod-a', ['fs'], new FakeSocket());
  router.registerRuntime('user-a', 'pod-b', ['fs'], new FakeSocket());
  const result = await router.requestCloudTool(
    'user-a',
    'fs.list',
    { path: '.' },
    1000,
    { runId: 'run-a', sessionId: 'session-a' },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'TARGET_SELECTION_REQUIRED');
});
