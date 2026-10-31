const assert = require('node:assert/strict');
const test = require('node:test');
const { LocalToolRouter } = require('../dist/toolRouter.js');

class FakeSocket {
  readyState = 1;
  sent = [];

  send(message) {
    this.sent.push(JSON.parse(message));
  }
}

function createAuditStore(events = []) {
  return {
    async recordToolCallStarted(event) {
      events.push({ type: 'started', ...event });
    },
    async recordToolCallStatus(event) {
      events.push({ type: 'status', ...event });
    },
  };
}

async function waitForRequest(socket) {
  const deadline = Date.now() + 1000;
  while (socket.sent.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.ok(socket.sent[0], 'tool request should be sent');
  return socket.sent[0];
}

test('local fs.read requires approval and returns the matching machine result', async () => {
  const router = new LocalToolRouter(createAuditStore());
  const socket = new FakeSocket();
  router.registerMachine('user-a', 'machine-a', ['fs'], socket);

  const pending = router.requestFsRead(
    'user-a',
    { path: 'C:\\Users\\user-a\\notes.txt' },
    1000,
    { runId: 'run-a', sessionId: 'session-a' },
  );
  const request = await waitForRequest(socket);
  assert.equal(request.type, 'tool.request');
  assert.equal(request.tool, 'fs.read');
  assert.equal(request.requiresApproval, true);

  assert.equal(await router.handleApproval(socket, {
    type: 'tool.approval',
    requestId: request.requestId,
    approvalId: request.approvalId,
    approved: true,
  }), true);
  assert.equal(await router.handleResult(socket, {
    type: 'tool.result',
    requestId: request.requestId,
    result: {
      ok: true,
      data: {
        path: 'C:\\Users\\user-a\\notes.txt',
        content: 'private note',
        encoding: 'utf8',
        size: 12,
      },
    },
  }), true);

  assert.deepEqual(await pending, {
    ok: true,
    data: {
      path: 'C:\\Users\\user-a\\notes.txt',
      content: 'private note',
      encoding: 'utf8',
      size: 12,
    },
  });
});

test('local fs.read persists a redacted audit lifecycle before resolving the Agent call', async () => {
  const auditEvents = [];
  const router = new LocalToolRouter(createAuditStore(auditEvents));
  const socket = new FakeSocket();
  router.registerMachine('user-a', 'machine-a', ['fs'], socket);

  const pending = router.requestFsRead(
    'user-a',
    { path: 'C:\\Users\\user-a\\private-notes.txt' },
    1000,
    { runId: 'run-a', sessionId: 'session-a' },
  );
  const request = await waitForRequest(socket);
  assert.equal(request.type, 'tool.request');
  await router.handleApproval(socket, {
    type: 'tool.approval',
    requestId: request.requestId,
    approvalId: request.approvalId,
    approved: true,
  });
  await router.handleResult(socket, {
    type: 'tool.result',
    requestId: request.requestId,
    result: {
      ok: true,
      data: {
        path: 'C:\\Users\\user-a\\private-notes.txt',
        content: 'do not persist this file content',
        encoding: 'utf8',
        size: 32,
      },
    },
  });
  await pending;

  assert.deepEqual(auditEvents.map(({ type, status, resultCode }) => ({
    type,
    status,
    resultCode,
  })), [
    { type: 'started', status: undefined, resultCode: undefined },
    { type: 'status', status: 'approved', resultCode: undefined },
    { type: 'status', status: 'completed', resultCode: undefined },
  ]);
  assert.equal(auditEvents[0].runId, 'run-a');
  assert.equal(auditEvents[0].sessionId, 'session-a');
  assert.equal(auditEvents[0].machineId, 'machine-a');
  assert.equal(auditEvents[0].args, undefined);
  assert.equal(JSON.stringify(auditEvents).includes('private-notes.txt'), false);
  assert.equal(JSON.stringify(auditEvents).includes('do not persist'), false);
});

test('local fs.read is not sent when the durable audit insert fails', async () => {
  const router = new LocalToolRouter({
    async recordToolCallStarted() {
      throw new Error('database unavailable');
    },
    async recordToolCallStatus() {},
  });
  const socket = new FakeSocket();
  router.registerMachine('user-a', 'machine-a', ['fs'], socket);

  await assert.rejects(
    () => router.requestFsRead(
      'user-a',
      { path: 'notes.txt' },
      1000,
      { runId: 'run-a', sessionId: 'session-a' },
    ),
    /database unavailable/,
  );
  assert.equal(socket.sent.length, 0);
});

test('local fs.list requires approval and persists only redacted audit metadata', async () => {
  const auditEvents = [];
  const router = new LocalToolRouter(createAuditStore(auditEvents));
  const socket = new FakeSocket();
  router.registerMachine('user-a', 'machine-a', ['fs'], socket);

  const pending = router.requestFsList(
    'user-a',
    { path: 'C:\\Users\\user-a\\Documents' },
    1000,
    { runId: 'run-list', sessionId: 'session-list' },
  );
  const request = await waitForRequest(socket);
  assert.equal(request.tool, 'fs.list');
  assert.equal(request.requiresApproval, true);
  assert.equal(await router.handleApproval(socket, {
    type: 'tool.approval',
    requestId: request.requestId,
    approvalId: request.approvalId,
    approved: true,
  }), true);
  assert.equal(await router.handleResult(socket, {
    type: 'tool.result',
    requestId: request.requestId,
    result: {
      ok: true,
      data: {
        path: request.args.path,
        entries: [{ name: 'private.txt', path: 'C:\\Users\\user-a\\Documents\\private.txt', type: 'file' }],
      },
    },
  }), true);

  assert.deepEqual(await pending, {
    ok: true,
    data: {
      path: 'C:\\Users\\user-a\\Documents',
      entries: [{ name: 'private.txt', path: 'C:\\Users\\user-a\\Documents\\private.txt', type: 'file' }],
    },
  });
  assert.deepEqual(auditEvents.map(({ type, status }) => ({ type, status })), [
    { type: 'started', status: undefined },
    { type: 'status', status: 'approved' },
    { type: 'status', status: 'completed' },
  ]);
  assert.equal(JSON.stringify(auditEvents).includes('private.txt'), false);
});

test('local fs.read ignores unapproved results and preserves a user denial', async () => {
  const router = new LocalToolRouter(createAuditStore());
  const socket = new FakeSocket();
  router.registerMachine('user-a', 'machine-a', ['fs'], socket);

  const pending = router.requestFsRead(
    'user-a',
    { path: 'notes.txt' },
    1000,
    { runId: 'run-a', sessionId: 'session-a' },
  );
  const request = await waitForRequest(socket);
  assert.equal(await router.handleResult(socket, {
    type: 'tool.result',
    requestId: request.requestId,
    result: {
      ok: true,
      data: {
        path: 'notes.txt',
        content: 'must not be accepted',
        encoding: 'utf8',
        size: 20,
      },
    },
  }), false);
  assert.equal(await router.handleApproval(socket, {
    type: 'tool.approval',
    requestId: request.requestId,
    approvalId: request.approvalId,
    approved: false,
    reason: 'User denied the tool request',
  }), true);
  assert.deepEqual(await pending, {
    ok: false,
    error: { code: 'ABORTED', message: 'User denied the tool request' },
  });
});

test('local fs.read never routes across users and requires explicit target selection', async () => {
  const router = new LocalToolRouter(createAuditStore());
  const first = new FakeSocket();
  router.registerMachine('user-a', 'machine-a', ['fs'], first);

  assert.deepEqual(
    await router.requestFsRead('user-b', { path: 'secret.txt' }, 1000, {
      runId: 'run-b',
      sessionId: 'session-b',
    }),
    {
      ok: false,
      error: { code: 'MACHINE_OFFLINE', message: 'No eligible local machine is online' },
    },
  );

  const second = new FakeSocket();
  router.registerMachine('user-a', 'machine-b', ['fs'], second);
  assert.deepEqual(
    await router.requestFsRead('user-a', { path: 'secret.txt' }, 1000, {
      runId: 'run-a',
      sessionId: 'session-a',
    }),
    {
      ok: false,
      error: {
        code: 'TARGET_SELECTION_REQUIRED',
        message: 'More than one local machine is online; select a target machine',
      },
    },
  );
  assert.equal(first.sent.length, 0);
  assert.equal(second.sent.length, 0);
});

test('local fs.read routes only to the selected eligible machine', async () => {
  const router = new LocalToolRouter(createAuditStore());
  const first = new FakeSocket();
  const second = new FakeSocket();
  router.registerMachine('user-a', 'machine-a', ['fs'], first);
  router.registerMachine('user-a', 'machine-b', ['fs'], second);

  assert.equal(router.selectMachine('user-a', 'machine-b'), true);

  const pending = router.requestFsRead(
    'user-a',
    { path: 'notes.txt' },
    1000,
    { runId: 'run-a', sessionId: 'session-a' },
  );
  const request = await waitForRequest(second);
  assert.equal(first.sent.length, 0);
  assert.equal(request.type, 'tool.request');
  router.unregisterMachine(second);
  assert.deepEqual(await pending, {
    ok: false,
    error: {
      code: 'MACHINE_OFFLINE',
      message: 'The target local machine disconnected',
    },
  });
  assert.deepEqual(
    await router.requestFsRead(
      'user-a',
      { path: 'notes.txt' },
      1000,
      { runId: 'run-b', sessionId: 'session-a' },
    ),
    {
      ok: false,
      error: {
        code: 'MACHINE_OFFLINE',
        message: 'The selected local machine is offline or does not support fs',
      },
    },
  );
  assert.equal(first.sent.length, 0);
});

test('machine selection is scoped to the user and can be cleared', () => {
  const router = new LocalToolRouter(createAuditStore());
  const socket = new FakeSocket();
  router.registerMachine('user-a', 'machine-a', ['fs'], socket);

  assert.equal(router.selectMachine('user-a', 'machine-a'), true);
  assert.equal(router.getSelectedMachineId('user-a'), 'machine-a');
  assert.equal(router.selectMachine('user-b', 'machine-a'), false);
  assert.equal(router.getSelectedMachineId('user-b'), null);
  assert.equal(router.selectMachine('user-a', null), true);
  assert.equal(router.getSelectedMachineId('user-a'), null);
});

test('local fs.read rejects results from a different registered machine', async () => {
  const router = new LocalToolRouter(createAuditStore());
  const target = new FakeSocket();
  const other = new FakeSocket();
  router.registerMachine('user-a', 'machine-a', ['fs'], target);
  router.registerMachine('user-a', 'machine-b', [], other);

  const pending = router.requestFsRead('user-a', { path: 'notes.txt' }, 1000, {
    runId: 'run-a',
    sessionId: 'session-a',
  });
  const request = await waitForRequest(target);

  assert.equal(await router.handleApproval(other, {
    type: 'tool.approval',
    requestId: request.requestId,
    approvalId: request.approvalId,
    approved: true,
  }), false);
  assert.equal(await router.handleResult(other, {
    type: 'tool.result',
    requestId: request.requestId,
    result: { ok: false, error: { code: 'INTERNAL', message: 'forged' } },
  }), false);

  router.unregisterMachine(target);
  assert.deepEqual(await pending, {
    ok: false,
    error: { code: 'MACHINE_OFFLINE', message: 'The target local machine disconnected' },
  });
});

test('local fs.read times out and releases its pending request', async () => {
  const router = new LocalToolRouter(createAuditStore());
  const socket = new FakeSocket();
  router.registerMachine('user-a', 'machine-a', ['fs'], socket);

  assert.deepEqual(
    await router.requestFsRead('user-a', { path: 'notes.txt' }, 10, {
      runId: 'run-a',
      sessionId: 'session-a',
    }),
    {
      ok: false,
      error: { code: 'TIMEOUT', message: 'Local fs.read request timed out' },
    },
  );
  assert.equal(router.pendingRequestCount, 0);
});

test('local fs.read rejects a result that does not match the fs.read result schema', async () => {
  const router = new LocalToolRouter(createAuditStore());
  const socket = new FakeSocket();
  router.registerMachine('user-a', 'machine-a', ['fs'], socket);

  const pending = router.requestFsRead('user-a', { path: 'notes.txt' }, 1000, {
    runId: 'run-a',
    sessionId: 'session-a',
  });
  const request = await waitForRequest(socket);
  await router.handleApproval(socket, {
    type: 'tool.approval',
    requestId: request.requestId,
    approvalId: request.approvalId,
    approved: true,
  });
  await router.handleResult(socket, {
    type: 'tool.result',
    requestId: request.requestId,
    result: { ok: true, data: 'not an fs.read result' },
  });

  assert.deepEqual(await pending, {
    ok: false,
    error: { code: 'INTERNAL', message: 'fs.read returned an invalid result' },
  });
});

test('cloud fs.read routes to connected runtime and handles result without approval prompt', async () => {
  const router = new LocalToolRouter(createAuditStore());
  const socket = new FakeSocket();
  router.registerRuntime('user-a', 'pod-1', ['fs'], socket);

  assert.deepEqual(router.listConnectedRuntimes('user-a'), [
    { podId: 'pod-1', capabilities: ['fs'] },
  ]);
  assert.deepEqual(router.listConnectedRuntimes('user-b'), []);

  const pending = router.requestCloudFsRead('user-a', { path: 'data.json' }, 1000, {
    runId: 'run-cloud-1',
    sessionId: 'session-cloud-1',
  });
  const request = await waitForRequest(socket);
  assert.equal(request.type, 'tool.request');
  assert.equal(request.tool, 'fs.read');
  assert.equal(request.requiresApproval, false);

  assert.equal(await router.handleResult(socket, {
    type: 'tool.result',
    requestId: request.requestId,
    result: {
      ok: true,
      data: {
        path: 'data.json',
        content: '{"cloud":true}',
        encoding: 'utf8',
        size: 14,
      },
    },
  }), true);

  const res = await pending;
  assert.equal(res.ok, true);
  assert.equal(res.data.content, '{"cloud":true}');
});

test('cloud fs.read returns RUNTIME_OFFLINE when no runtime is registered', async () => {
  const router = new LocalToolRouter(createAuditStore());
  const res = await router.requestCloudFsRead('user-a', { path: 'data.json' }, 1000, {
    runId: 'run-cloud-2',
    sessionId: 'session-cloud-2',
  });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'RUNTIME_OFFLINE');
});

test('generic local routing rejects tools the machine capability does not cover', async () => {
  const router = new LocalToolRouter(createAuditStore());
  const socket = new FakeSocket();
  router.registerMachine('user-a', 'machine-a', ['fs'], socket);

  const res = await router.requestLocalTool(
    'user-a',
    'shell.exec',
    { command: 'echo hi' },
    1000,
    { runId: 'run-shell', sessionId: 'session-shell' },
  );
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'MACHINE_OFFLINE');
});

test('generic local shell.exec routes with approval to a shell-capable machine', async () => {
  const auditEvents = [];
  const router = new LocalToolRouter(createAuditStore(auditEvents));
  const socket = new FakeSocket();
  router.registerMachine('user-a', 'machine-a', ['fs', 'shell'], socket);

  const pending = router.requestLocalTool(
    'user-a',
    'shell.exec',
    { command: 'echo hi' },
    1000,
    { runId: 'run-shell', sessionId: 'session-shell' },
  );
  const request = await waitForRequest(socket);
  assert.equal(request.tool, 'shell.exec');
  assert.equal(request.requiresApproval, true);
  await router.handleApproval(socket, {
    type: 'tool.approval',
    requestId: request.requestId,
    approvalId: request.approvalId,
    approved: true,
  });
  await router.handleResult(socket, {
    type: 'tool.result',
    requestId: request.requestId,
    result: {
      ok: true,
      data: { stdout: 'hi\n', stderr: '', exitCode: 0, truncated: false },
    },
  });

  const res = await pending;
  assert.equal(res.ok, true);
  assert.equal(res.data.stdout, 'hi\n');
  assert.equal(auditEvents[0].tool, 'shell.exec');
});

test('user.ask routes without approval and resolves with the answer', async () => {
  const router = new LocalToolRouter(createAuditStore());
  const socket = new FakeSocket();
  router.registerMachine('user-a', 'machine-a', ['fs', 'ask'], socket);

  const pending = router.requestLocalTool(
    'user-a',
    'user.ask',
    { question: 'Which stack?', choices: ['React', 'Vue'] },
    1000,
    { runId: 'run-ask', sessionId: 'session-ask' },
  );
  const request = await waitForRequest(socket);
  assert.equal(request.tool, 'user.ask');
  // 提问即交互：不再叠加审批
  assert.equal(request.requiresApproval, false);
  assert.equal(request.approvalId, undefined);

  await router.handleResult(socket, {
    type: 'tool.result',
    requestId: request.requestId,
    result: {
      ok: true,
      data: { answer: 'React', choice: 'React' },
    },
  });

  const res = await pending;
  assert.deepEqual(res, {
    ok: true,
    data: { answer: 'React', choice: 'React' },
  });
});

test('cloud tools only route to runtimes advertising the matching capability', async () => {
  const router = new LocalToolRouter(createAuditStore());
  const fsSocket = new FakeSocket();
  router.registerRuntime('user-a', 'pod-fs', ['fs'], fsSocket);

  const noWeb = await router.requestCloudTool(
    'user-a',
    'web.fetch',
    { url: 'https://example.com' },
    1000,
    { runId: 'run-web', sessionId: 'session-web' },
  );
  assert.equal(noWeb.ok, false);
  assert.equal(noWeb.error.code, 'RUNTIME_OFFLINE');

  const webSocket = new FakeSocket();
  router.registerRuntime('user-a', 'pod-web', ['fs', 'web'], webSocket);
  const pending = router.requestCloudTool(
    'user-a',
    'web.fetch',
    { url: 'https://example.com' },
    1000,
    { runId: 'run-web', sessionId: 'session-web' },
  );
  const request = await waitForRequest(webSocket);
  assert.equal(request.tool, 'web.fetch');
  assert.equal(request.requiresApproval, false);
  await router.handleResult(webSocket, {
    type: 'tool.result',
    requestId: request.requestId,
    result: {
      ok: true,
      data: {
        url: 'https://example.com/',
        status: 200,
        body: 'hello',
        encoding: 'utf8',
        truncated: false,
      },
    },
  });
  const res = await pending;
  assert.equal(res.ok, true);
  assert.equal(res.data.body, 'hello');
});

test('files.copy orchestrates local read with approval then cloud write', async () => {
  const auditEvents = [];
  const router = new LocalToolRouter(createAuditStore(auditEvents));
  const machineSocket = new FakeSocket();
  const runtimeSocket = new FakeSocket();
  router.registerMachine('user-a', 'machine-a', ['fs'], machineSocket);
  router.registerRuntime('user-a', 'pod-a', ['fs'], runtimeSocket);

  const pending = router.requestFilesCopy(
    'user-a',
    {
      source: 'C:\\Users\\user-a\\report.pdf',
      destination: 'uploads/report.pdf',
      direction: 'local-to-cloud',
    },
    2000,
    { runId: 'run-copy', sessionId: 'session-copy' },
  );

  const readRequest = await waitForRequest(machineSocket);
  assert.equal(readRequest.tool, 'fs.read');
  assert.deepEqual(readRequest.args, {
    path: 'C:\\Users\\user-a\\report.pdf',
    encoding: 'base64',
  });
  await router.handleApproval(machineSocket, {
    type: 'tool.approval',
    requestId: readRequest.requestId,
    approvalId: readRequest.approvalId,
    approved: true,
  });
  await router.handleResult(machineSocket, {
    type: 'tool.result',
    requestId: readRequest.requestId,
    result: {
      ok: true,
      data: {
        path: 'C:\\Users\\user-a\\report.pdf',
        content: 'QUJD',
        encoding: 'base64',
        size: 3,
      },
    },
  });

  const writeRequest = await waitForRequest(runtimeSocket);
  assert.equal(writeRequest.tool, 'fs.write');
  assert.deepEqual(writeRequest.args, {
    path: 'uploads/report.pdf',
    content: 'QUJD',
    encoding: 'base64',
    createDirs: true,
  });
  await router.handleResult(runtimeSocket, {
    type: 'tool.result',
    requestId: writeRequest.requestId,
    result: {
      ok: true,
      data: { path: 'uploads/report.pdf', bytesWritten: 3 },
    },
  });

  const res = await pending;
  assert.deepEqual(res, {
    ok: true,
    data: {
      source: 'C:\\Users\\user-a\\report.pdf',
      destination: 'uploads/report.pdf',
      bytesCopied: 3,
    },
  });

  // 复合操作不写独立审计行，由两次子调用各自审计
  assert.equal(auditEvents.some((event) => event.tool === 'files.copy'), false);
  assert.deepEqual(
    auditEvents.filter((event) => event.type === 'started').map((event) => event.tool),
    ['fs.read', 'fs.write'],
  );
});

test('preview relay forwards desktop requests to the runtime and back', () => {
  const router = new LocalToolRouter(createAuditStore());
  const desktopSocket = new FakeSocket();
  const runtimeSocket = new FakeSocket();
  router.registerRuntime('user-a', 'pod-a', ['fs'], runtimeSocket);

  router.relayPreviewRequest('user-a', {
    type: 'preview.request',
    requestId: 'prev-1',
    port: 34567,
    method: 'GET',
    path: '/index.html',
    headers: {},
  }, desktopSocket);

  // 转发给 runtime 的请求原样携带 requestId / port / path
  assert.equal(runtimeSocket.sent[0].type, 'preview.request');
  assert.equal(runtimeSocket.sent[0].requestId, 'prev-1');
  assert.equal(runtimeSocket.sent[0].port, 34567);

  // runtime 回包后转发给桌面 socket
  assert.equal(router.handlePreviewResponse(runtimeSocket, {
    type: 'preview.response',
    requestId: 'prev-1',
    status: 200,
    headers: { 'content-type': 'text/html' },
    bodyBase64: Buffer.from('<h1>ok</h1>').toString('base64'),
  }), true);
  assert.equal(desktopSocket.sent[0].type, 'preview.response');
  assert.equal(desktopSocket.sent[0].status, 200);
});

test('preview relay returns 503 when no runtime is online and rejects unknown responses', () => {
  const router = new LocalToolRouter(createAuditStore());
  const desktopSocket = new FakeSocket();

  router.relayPreviewRequest('user-a', {
    type: 'preview.request',
    requestId: 'prev-2',
    port: 34567,
    method: 'GET',
    path: '/',
    headers: {},
  }, desktopSocket);

  assert.equal(desktopSocket.sent[0].type, 'preview.response');
  assert.equal(desktopSocket.sent[0].status, 503);
  assert.equal(router.handlePreviewResponse(new FakeSocket(), {
    type: 'preview.response',
    requestId: 'prev-2',
    status: 200,
    headers: {},
    bodyBase64: '',
  }), false);
});
