const assert = require('node:assert/strict');
const { once } = require('node:events');
const test = require('node:test');
const WebSocket = require('ws');
const { createControlServer } = require('../dist/server.js');
const { createRuntimeTokenAuthenticator } = require('../dist/auth.js');
const { SessionBusyError } = require('../dist/conversationStore.js');
const { LocalToolRouter } = require('../dist/toolRouter.js');
const RUNTIME_TOKEN = 'r'.repeat(48);

class MemoryConversationStore {
  constructor() {
    this.sessions = new Map();
    this.messages = new Map();
    this.machines = new Map();
    this.machineSelections = new Map();
    this.runtimes = new Map();
    this.runtimeHeartbeats = [];
    this.runs = new Map();
    this.toolCalls = [];
    this.failMachineSelectionWrite = false;
  }

  async registerMachine(userId, machineId, label, capabilities) {
    this.machines.set(`${userId}:${machineId}`, { label, capabilities });
  }

  async registerRuntime(userId, podId, capabilities) {
    this.runtimes.set(`${userId}:${podId}`, { capabilities });
  }

  async touchRuntime(userId, podId) {
    this.runtimeHeartbeats.push({ userId, podId });
  }

  async setSelectedMachineId(userId, machineId) {
    if (this.failMachineSelectionWrite) {
      throw new Error('selection persistence unavailable');
    }
    if (machineId === null) this.machineSelections.delete(userId);
    else this.machineSelections.set(userId, machineId);
  }

  async getSelectedMachineId(userId) {
    return this.machineSelections.get(userId) ?? null;
  }

  async setSelectedRuntimeId(userId, podId) {
    if (!this.runtimeSelections) this.runtimeSelections = new Map();
    if (podId === null) this.runtimeSelections.delete(userId);
    else this.runtimeSelections.set(userId, podId);
  }

  async getSelectedRuntimeId(userId) {
    if (!this.runtimeSelections) this.runtimeSelections = new Map();
    return this.runtimeSelections.get(userId) ?? null;
  }

  async listMemories(userId) {
    if (!this.memories) this.memories = new Map();
    return [...this.memories.values()].filter((m) => m.userId === userId);
  }

  async upsertMemory(userId, input) {
    if (!this.memories) this.memories = new Map();
    const id = `mem-${this.memories.size + 1}`;
    const record = {
      id,
      userId,
      key: input.key,
      content: input.content,
      importance: input.importance ?? 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.memories.set(id, record);
    return record;
  }

  async deleteMemory(userId, memoryId) {
    if (!this.memories) return false;
    const row = this.memories.get(memoryId);
    if (!row || row.userId !== userId) return false;
    this.memories.delete(memoryId);
    return true;
  }

  async getMemoryByKey(userId, key) {
    if (!this.memories) return null;
    return [...this.memories.values()].find((m) => m.userId === userId && m.key === key) ?? null;
  }

  async listRoutines(userId) {
    if (!this.routines) this.routines = new Map();
    return [...this.routines.values()].filter((r) => r.ownerUserId === userId);
  }

  async createRoutine(userId, input) {
    if (!this.routines) this.routines = new Map();
    const id = `routine-${this.routines.size + 1}`;
    const record = {
      id,
      ownerUserId: userId,
      name: input.name,
      prompt: input.prompt,
      sessionId: input.sessionId ?? null,
      scheduleKind: input.scheduleKind,
      cronExpr: input.cronExpr ?? null,
      intervalMs: input.intervalMs ?? null,
      eventType: input.eventType ?? null,
      enabled: input.enabled ?? true,
      nextRunAt: input.scheduleKind === 'event' ? null : new Date(Date.now() + 60_000).toISOString(),
      lastRunAt: null,
      lastError: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.routines.set(id, record);
    return record;
  }

  async updateRoutine(userId, routineId, patch) {
    if (!this.routines) return null;
    const current = this.routines.get(routineId);
    if (!current || current.ownerUserId !== userId) return null;
    Object.assign(current, patch, { updatedAt: new Date().toISOString() });
    return current;
  }

  async deleteRoutine(userId, routineId) {
    if (!this.routines) return false;
    const current = this.routines.get(routineId);
    if (!current || current.ownerUserId !== userId) return false;
    this.routines.delete(routineId);
    return true;
  }

  async listDueRoutines() { return []; }
  async markRoutineFired() {}

  async createSession(userId, title) {
    const session = { id: `session-${this.sessions.size + 1}`, userId, title };
    this.sessions.set(session.id, session);
    this.messages.set(session.id, []);
    return session;
  }

  async updateSessionTitle(userId, sessionId, title) {
    const session = this.sessions.get(sessionId);
    if (!session || session.userId !== userId) return null;
    session.title = title;
    return session;
  }

  async deleteSession(userId, sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || session.userId !== userId) return false;
    const hasActiveRun = [...this.runs.values()].some((run) =>
      run.userId === userId &&
      run.sessionId === sessionId &&
      (run.status === 'queued' || run.status === 'running'),
    );
    if (hasActiveRun) throw new SessionBusyError();
    this.sessions.delete(sessionId);
    this.messages.delete(sessionId);
    for (const [runId, run] of [...this.runs.entries()]) {
      if (run.sessionId === sessionId) this.runs.delete(runId);
    }
    return true;
  }

  async setUserModelConfig(userId, config) {
    if (!this.userModelConfigs) this.userModelConfigs = new Map();
    this.userModelConfigs.set(userId, config);
  }

  async getUserModelConfig(userId) {
    if (!this.userModelConfigs) this.userModelConfigs = new Map();
    return this.userModelConfigs.get(userId) ?? null;
  }

  async listModelProfiles(userId) {
    if (!this.modelProfiles) this.modelProfiles = new Map();
    return [...this.modelProfiles.values()]
      .filter((profile) => profile.userId === userId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async saveModelProfile(userId, profile) {
    if (!this.modelProfiles) this.modelProfiles = new Map();
    const existing = [...this.modelProfiles.values()].find(
      (item) => item.userId === userId && item.name === profile.name,
    );
    const now = new Date().toISOString();
    if (existing) {
      Object.assign(existing, { ...profile, updatedAt: now });
      return { ...existing };
    }
    const record = {
      id: `profile-${this.modelProfiles.size + 1}`,
      userId,
      ...profile,
      createdAt: now,
      updatedAt: now,
    };
    this.modelProfiles.set(record.id, record);
    return { ...record };
  }

  async deleteModelProfile(userId, profileId) {
    if (!this.modelProfiles) this.modelProfiles = new Map();
    const record = this.modelProfiles.get(profileId);
    if (!record || record.userId !== userId) return false;
    this.modelProfiles.delete(profileId);
    return true;
  }

  async activateModelProfile(userId, profileId) {
    if (!this.modelProfiles) this.modelProfiles = new Map();
    const record = this.modelProfiles.get(profileId);
    if (!record || record.userId !== userId) return null;
    await this.setUserModelConfig(userId, {
      provider: record.provider,
      apiBaseUrl: record.apiBaseUrl,
      apiKey: record.apiKey,
      model: record.model,
    });
    return { ...record };
  }

  async recordUiToolCallStarted(event) {
    if (!this.uiToolCalls) this.uiToolCalls = new Map();
    this.uiToolCalls.set(event.requestId, { ...event, status: 'requested' });
  }

  async recordUiToolCallStatus(event) {
    if (!this.uiToolCalls) this.uiToolCalls = new Map();
    const record = this.uiToolCalls.get(event.requestId);
    if (!record) return;
    record.status = event.status;
    record.resultCode = event.resultCode;
  }

  async listSessions(userId) {
    return [...this.sessions.values()].filter((session) => session.userId === userId);
  }

  async listMessages(userId, sessionId) {
    const session = this.sessions.get(sessionId);
    return session?.userId === userId ? this.messages.get(sessionId) : null;
  }

  async appendUserMessage(userId, sessionId, text) {
    const session = this.sessions.get(sessionId);
    if (session?.userId !== userId) return null;
    if ([...this.runs.values()].some((run) => run.userId === userId && run.sessionId === sessionId && run.status === 'queued')) {
      throw new SessionBusyError();
    }
    const message = { id: `message-${this.messages.get(sessionId).length + 1}`, role: 'user', text };
    const run = { id: `run-${message.id}`, status: 'queued' };
    this.messages.get(sessionId).push(message);
    this.runs.set(run.id, { ...run, userId, sessionId });
    return { message, run };
  }

  async getRun(userId, runId) {
    const run = this.runs.get(runId);
    return run?.userId === userId ? { id: run.id, status: run.status } : null;
  }

  async cancelRun(userId, runId) {
    const run = this.runs.get(runId);
    if (!run || run.userId !== userId) return null;
    if (run.status === 'queued' || run.status === 'running') {
      run.status = 'cancelled';
      return { id: run.id, status: run.status };
    }
    return { id: run.id, status: run.status };
  }

  async recordToolCallStarted(event) {
    this.toolCalls.push({ ...event, status: 'requested' });
  }

  async recordToolCallStatus(event) {
    const toolCall = this.toolCalls.find(
      (call) =>
        call.requestId === event.requestId &&
        call.userId === event.userId &&
        call.runId === event.runId,
    );
    if (!toolCall) throw new Error('Cannot update an unknown tool call audit record');
    toolCall.status = event.status;
    toolCall.resultCode = event.resultCode;
  }
}

async function startServer(t) {
  const instance = await startControlServer(t);
  return instance.baseUrl;
}

async function startControlServer(
  t,
  store = new MemoryConversationStore(),
  toolRouter = new LocalToolRouter(store),
) {
  const server = createControlServer({
    store,
    toolRouter,
    authenticate: (header) => {
      if (header === 'Bearer test-user') return 'user-a';
      if (header === 'Bearer machine-list-test-token') return 'user-a';
      if (header === 'Bearer routing-test-token') return 'user-a';
      return ({
      'Bearer user-a': 'user-a',
      'Bearer user-b': 'user-b',
    }[header] ?? null);
    },
    authenticateRuntime: createRuntimeTokenAuthenticator({
    CLOUD_RUNTIME_TOKENS_JSON: JSON.stringify({
      [RUNTIME_TOKEN]: { userId: 'user-a', podId: 'pod-a' },
    }),
    }),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    server,
    store,
    toolRouter,
  };
}

async function waitFor(condition) {
  const deadline = Date.now() + 1000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Condition did not become true');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function eventWithin(emitter, event, timeoutMs = 1000) {
  let timer;
  try {
    return await Promise.race([
      once(emitter, event),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('session API rejects requests without a valid bearer token', async (t) => {
  const baseUrl = await startServer(t);
  const response = await fetch(`${baseUrl}/v1/sessions`);

  assert.equal(response.status, 401);
});

test('session messages are accepted as queued runs and returned in history', async (t) => {
  const baseUrl = await startServer(t);
  const headers = {
    authorization: 'Bearer user-a',
    'content-type': 'application/json',
  };
  const sessionResponse = await fetch(`${baseUrl}/v1/sessions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title: 'My conversation' }),
  });
  const session = await sessionResponse.json();
  assert.equal(sessionResponse.status, 201);

  const messageResponse = await fetch(`${baseUrl}/v1/sessions/${session.id}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ text: 'Remember this message' }),
  });
  const accepted = await messageResponse.json();
  assert.equal(messageResponse.status, 202);
  assert.equal(accepted.message.text, 'Remember this message');
  assert.equal(accepted.run.status, 'queued');

  const runResponse = await fetch(`${baseUrl}/v1/runs/${accepted.run.id}`, {
    headers,
  });
  assert.equal(runResponse.status, 200);
  assert.equal((await runResponse.json()).status, 'queued');

  const historyResponse = await fetch(`${baseUrl}/v1/sessions/${session.id}/messages`, {
    headers,
  });
  const history = await historyResponse.json();
  assert.equal(history.messages.length, 1);
  assert.equal(history.messages[0].text, 'Remember this message');
});

test('users cannot inspect another user run', async (t) => {
  const baseUrl = await startServer(t);
  const headers = {
    authorization: 'Bearer user-a',
    'content-type': 'application/json',
  };
  const created = await fetch(`${baseUrl}/v1/sessions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title: 'Private' }),
  });
  const session = await created.json();
  const posted = await fetch(`${baseUrl}/v1/sessions/${session.id}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ text: 'Private message' }),
  });
  assert.equal(posted.status, 202);
  const { run } = await posted.json();

  const response = await fetch(`${baseUrl}/v1/runs/${run.id}`, {
    headers: { authorization: 'Bearer user-b' },
  });
  assert.equal(response.status, 404);
});

test('a session rejects a second message while an agent run is active', async (t) => {
  const baseUrl = await startServer(t);
  const headers = {
    authorization: 'Bearer user-a',
    'content-type': 'application/json',
  };
  const created = await fetch(`${baseUrl}/v1/sessions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title: 'Serial turns' }),
  });
  const session = await created.json();
  const first = await fetch(`${baseUrl}/v1/sessions/${session.id}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ text: 'First' }),
  });
  assert.equal(first.status, 202);

  const second = await fetch(`${baseUrl}/v1/sessions/${session.id}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ text: 'Second' }),
  });
  assert.equal(second.status, 409);
});

test('users can cancel their queued run and cannot cancel another user run', async (t) => {
  const baseUrl = await startServer(t);
  const headers = {
    authorization: 'Bearer user-a',
    'content-type': 'application/json',
  };
  const created = await fetch(`${baseUrl}/v1/sessions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title: 'Cancelable' }),
  });
  const session = await created.json();
  const posted = await fetch(`${baseUrl}/v1/sessions/${session.id}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ text: 'Cancel me' }),
  });
  assert.equal(posted.status, 202);
  const { run } = await posted.json();

  const denied = await fetch(`${baseUrl}/v1/runs/${run.id}/cancel`, {
    method: 'POST',
    headers: { authorization: 'Bearer user-b' },
  });
  assert.equal(denied.status, 404);

  const cancelled = await fetch(`${baseUrl}/v1/runs/${run.id}/cancel`, {
    method: 'POST',
    headers: { authorization: 'Bearer user-a' },
  });
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json()).status, 'cancelled');
});

test('users cannot read another user conversation', async (t) => {
  const baseUrl = await startServer(t);
  const headers = {
    authorization: 'Bearer user-a',
    'content-type': 'application/json',
  };
  const created = await fetch(`${baseUrl}/v1/sessions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title: 'Private' }),
  });
  const session = await created.json();

  const response = await fetch(`${baseUrl}/v1/sessions/${session.id}/messages`, {
    headers: { authorization: 'Bearer user-b' },
  });
  assert.equal(response.status, 404);
});

test('authenticated Electron clients can open the control WebSocket', async (t) => {
  const baseUrl = await startServer(t);
  const url = new URL(baseUrl);
  url.protocol = 'ws:';
  url.pathname = '/v1/ws';
  const socket = new WebSocket(url, {
    headers: { authorization: 'Bearer user-a' },
  });
  t.after(() => socket.terminate());
  await once(socket, 'open');
  socket.close();
  await once(socket, 'close');
});

test('only the credential-bound Cloud Runtime can register its pod identity', async (t) => {
  const { baseUrl, store } = await startControlServer(t);
  const url = new URL(baseUrl);
  url.protocol = 'ws:';
  url.pathname = '/v1/ws';
  const socket = new WebSocket(url, {
    headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
  });
  t.after(() => socket.terminate());
  await eventWithin(socket, 'open');
  socket.send(JSON.stringify({
    type: 'runtime.hello',
    podId: 'pod-a',
    capabilities: ['fs'],
    protocolVersion: 1,
  }));
  await waitFor(() => store.runtimes.has('user-a:pod-a'));
  socket.send(JSON.stringify({ type: 'ping', ts: 123 }));
  const [pongData] = await eventWithin(socket, 'message');
  assert.deepEqual(JSON.parse(pongData.toString()), { type: 'pong', ts: 123 });
  await waitFor(() => store.runtimeHeartbeats.length === 1);
  assert.deepEqual(store.runtimeHeartbeats[0], { userId: 'user-a', podId: 'pod-a' });
  socket.close();
  await once(socket, 'close');

  const userSocket = new WebSocket(url, {
    headers: { authorization: 'Bearer test-user'},
  });
  t.after(() => userSocket.terminate());
  await eventWithin(userSocket, 'open');
  const closed = eventWithin(userSocket, 'close');
  userSocket.send(JSON.stringify({
    type: 'runtime.hello',
    podId: 'pod-a',
    capabilities: ['fs'],
  }));
  const [code] = await closed;
  assert.equal(code, 1008);
});

test('authenticated Electron returns approved local fs.read results to the requesting user', async (t) => {
  const { baseUrl, store, toolRouter } = await startControlServer(t);
  const url = new URL(baseUrl);
  url.protocol = 'ws:';
  url.pathname = '/v1/ws';
  const socket = new WebSocket(url, {
    headers: { authorization: 'Bearer routing-test-token' },
  });
  t.after(() => socket.terminate());
  try {
    await eventWithin(socket, 'open');

    socket.send(JSON.stringify({
      type: 'machine.hello',
      machineId: 'machine-a',
      capabilities: ['fs'],
    }));
    await waitFor(() => store.machines.has('user-a:machine-a'));

    const pending = toolRouter.requestFsRead(
      'user-a',
      { path: 'C:\\Users\\user-a\\notes.txt' },
      300,
      { runId: 'run-test', sessionId: 'session-test' },
    );
    const firstResponse = await Promise.race([
      eventWithin(socket, 'message').then(([data]) => ({ data })),
      pending.then((result) => ({ result })),
    ]);
    assert.ok(firstResponse.data, 'server should send a tool request before resolving it');
    const requestData = firstResponse.data;
    const request = JSON.parse(requestData.toString());
    assert.equal(request.type, 'tool.request');
    assert.equal(request.tool, 'fs.read');

    socket.send(JSON.stringify({
      type: 'tool.approval',
      approvalId: request.approvalId,
      requestId: request.requestId,
      approved: true,
    }));
    socket.send(JSON.stringify({
      type: 'tool.result',
      requestId: request.requestId,
      result: {
        ok: true,
        data: {
          path: 'C:\\Users\\user-a\\notes.txt',
          content: 'approved content',
          encoding: 'utf8',
          size: 16,
        },
      },
    }));

    assert.deepEqual(await pending, {
      ok: true,
      data: {
        path: 'C:\\Users\\user-a\\notes.txt',
        content: 'approved content',
        encoding: 'utf8',
        size: 16,
      },
    });
    assert.deepEqual(
      await toolRouter.requestFsRead('user-b', { path: 'private.txt' }, 1000),
      {
        ok: false,
        error: { code: 'MACHINE_OFFLINE', message: 'No eligible local machine is online' },
      },
    );
  } finally {
    socket.terminate();
  }
});

test('a WebSocket connection cannot register multiple local machine identities', async (t) => {
  const { baseUrl } = await startControlServer(t);
  const url = new URL(baseUrl);
  url.protocol = 'ws:';
  url.pathname = '/v1/ws';
  const socket = new WebSocket(url, {
    headers: { authorization: 'Bearer routing-test-token' },
  });
  t.after(() => socket.terminate());
  try {
    await eventWithin(socket, 'open');

    socket.send(JSON.stringify({
      type: 'machine.hello',
      machineId: 'machine-a',
      capabilities: ['fs'],
    }));
    socket.send(JSON.stringify({
      type: 'machine.hello',
      machineId: 'machine-b',
      capabilities: ['fs'],
    }));
    const [code] = await eventWithin(socket, 'close');
    assert.equal(code, 1008);
  } finally {
    socket.terminate();
  }
});

test('users can list only their own connected machines', async (t) => {
  const { baseUrl, toolRouter } = await startControlServer(t);
  toolRouter.registerMachine(
    'user-a',
    'machine-a',
    ['fs'],
    { readyState: WebSocket.OPEN, send() {} },
    'Workstation',
  );
  toolRouter.registerMachine(
    'user-b',
    'machine-b',
    ['fs'],
    { readyState: WebSocket.OPEN, send() {} },
    'Other user device',
  );

  const response = await fetch(`${baseUrl}/v1/machines`, {
    headers: { authorization: 'Bearer machine-list-test-token' },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    machines: [{
      machineId: 'machine-a',
      label: 'Workstation',
      capabilities: ['fs'],
    }],
    selectedMachineId: null,
  });
});

test('users can select only their own online local executor', async (t) => {
  const { baseUrl, toolRouter } = await startControlServer(t);
  const socket = { readyState: WebSocket.OPEN, send() {} };
  toolRouter.registerMachine('user-a', 'machine-a', ['fs'], socket, 'Workstation');
  toolRouter.registerMachine(
    'user-b',
    'machine-b',
    ['fs'],
    { readyState: WebSocket.OPEN, send() {} },
    'Other user device',
  );

  const selected = await fetch(`${baseUrl}/v1/machines/selection`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer machine-list-test-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ machineId: 'machine-a' }),
  });
  assert.equal(selected.status, 200);
  assert.deepEqual(await selected.json(), { selectedMachineId: 'machine-a' });
  assert.equal(await toolRouter.getSelectedMachineId('user-a'), 'machine-a');
  assert.equal(await toolRouter.getSelectedMachineId('user-b'), null);

  const machinesResponse = await fetch(`${baseUrl}/v1/machines`, {
    headers: { authorization: 'Bearer machine-list-test-token' },
  });
  assert.equal((await machinesResponse.json()).selectedMachineId, 'machine-a');

  const rejected = await fetch(`${baseUrl}/v1/machines/selection`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer machine-list-test-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ machineId: 'machine-b' }),
  });
  assert.equal(rejected.status, 404);
});

test('machine selection persistence failures do not leave a runtime-only selection', async (t) => {
  const { baseUrl, store, toolRouter } = await startControlServer(t);
  toolRouter.registerMachine(
    'user-a',
    'machine-a',
    ['fs'],
    { readyState: WebSocket.OPEN, send() {} },
  );
  store.failMachineSelectionWrite = true;

  const response = await fetch(`${baseUrl}/v1/machines/selection`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer machine-list-test-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ machineId: 'machine-a' }),
  });

  assert.equal(response.status, 500);
  assert.equal(toolRouter.getSelectedMachineId('user-a'), null);
});

test('saved machine selection is returned after its device goes offline', async (t) => {
  const { baseUrl, store, toolRouter } = await startControlServer(t);
  const socket = { readyState: WebSocket.OPEN, send() {} };
  toolRouter.registerMachine('user-a', 'machine-a', ['fs'], socket, 'Workstation');
  const selected = await fetch(`${baseUrl}/v1/machines/selection`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer machine-list-test-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ machineId: 'machine-a' }),
  });
  assert.equal(selected.status, 200);

  toolRouter.unregisterMachine(socket);
  const response = await fetch(`${baseUrl}/v1/machines`, {
    headers: { authorization: 'Bearer machine-list-test-token' },
  });

  assert.deepEqual(await response.json(), {
    machines: [],
    selectedMachineId: 'machine-a',
  });
  assert.equal(await store.getSelectedMachineId('user-a'), 'machine-a');
});

test('a saved machine selection is restored when its device reconnects', async (t) => {
  const { baseUrl, store, toolRouter } = await startControlServer(t);
  await store.setSelectedMachineId('user-a', 'machine-a');
  const url = new URL(baseUrl);
  url.protocol = 'ws:';
  url.pathname = '/v1/ws';
  const socket = new WebSocket(url, {
    headers: { authorization: 'Bearer machine-list-test-token' },
  });
  t.after(() => socket.terminate());

  await eventWithin(socket, 'open');
  socket.send(JSON.stringify({
    type: 'machine.hello',
    machineId: 'machine-a',
    label: 'Workstation',
    capabilities: ['fs'],
  }));
  await waitFor(() => toolRouter.getSelectedMachineId('user-a') === 'machine-a');

  assert.equal(await store.getSelectedMachineId('user-a'), 'machine-a');
  socket.close();
  await eventWithin(socket, 'close');
});

test('authenticated Cloud Runtime registers, appears in GET /v1/runtimes, and completes cloud fs.read', async (t) => {
  const { baseUrl, store, toolRouter } = await startControlServer(t);
  const url = new URL(baseUrl);
  url.protocol = 'ws:';
  url.pathname = '/v1/ws';
  const socket = new WebSocket(url, {
    headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
  });
  t.after(() => socket.terminate());
  try {
    await eventWithin(socket, 'open');

    socket.send(JSON.stringify({
      type: 'runtime.hello',
      podId: 'pod-a',
      capabilities: ['fs'],
      protocolVersion: 1,
    }));
    await waitFor(() => toolRouter.listConnectedRuntimes('user-a').length === 1);

    // 验证 GET /v1/runtimes
    const runtimesRes = await fetch(`${baseUrl}/v1/runtimes`, {
      headers: { authorization: 'Bearer user-a' },
    });
    assert.equal(runtimesRes.status, 200);
    const { runtimes } = await runtimesRes.json();
    assert.deepEqual(runtimes, [{ podId: 'pod-a', capabilities: ['fs'] }]);

    // 发起云端工具调用
    const pending = toolRouter.requestCloudFsRead(
      'user-a',
      { path: 'workspace/project.json' },
      500,
      { runId: 'run-cloud-test', sessionId: 'session-cloud-test' },
    );

    const firstResponse = await Promise.race([
      eventWithin(socket, 'message').then(([data]) => ({ data })),
      pending.then((result) => ({ result })),
    ]);
    assert.ok(firstResponse.data, 'server should send a tool request before resolving it');
    const request = JSON.parse(firstResponse.data.toString());
    assert.equal(request.type, 'tool.request');
    assert.equal(request.tool, 'fs.read');
    assert.equal(request.requiresApproval, false);

    socket.send(JSON.stringify({
      type: 'tool.result',
      requestId: request.requestId,
      result: {
        ok: true,
        data: {
          path: 'workspace/project.json',
          content: '{"ok":true}',
          encoding: 'utf8',
          size: 11,
        },
      },
    }));

    const res = await pending;
    assert.equal(res.ok, true);
    assert.equal(res.data.content, '{"ok":true}');
  } finally {
    socket.terminate();
  }
});

test('PATCH /v1/sessions/:id updates session title for owner', async (t) => {
  const { baseUrl, store } = await startControlServer(t);
  const session = await store.createSession('user-a', '旧标题');

  const response = await fetch(`${baseUrl}/v1/sessions/${session.id}`, {
    method: 'PATCH',
    headers: {
      authorization: 'Bearer user-a',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ title: '新对话标题' }),
  });

  assert.equal(response.status, 200);
  const updated = await response.json();
  assert.equal(updated.title, '新对话标题');
  assert.equal(store.sessions.get(session.id).title, '新对话标题');
});

test('GET and POST /v1/models/config manage user model configurations', async (t) => {
  const { baseUrl, store } = await startControlServer(t);

  // 默认读取初始配置
  const getInitial = await fetch(`${baseUrl}/v1/models/config`, {
    headers: { authorization: 'Bearer user-a' },
  });
  assert.equal(getInitial.status, 200);
  const initialData = await getInitial.json();
  assert.equal(initialData.model, 'glm-5.3-flash');

  // 保存新的模型配置
  const postConfig = await fetch(`${baseUrl}/v1/models/config`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer user-a',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      provider: 'openai-compatible',
      apiBaseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-test-key-123456',
      model: 'deepseek-chat',
    }),
  });
  assert.equal(postConfig.status, 200);
  const postRes = await postConfig.json();
  assert.equal(postRes.status, 'ok');
  assert.equal(postRes.model, 'deepseek-chat');

  // 再次读取验证持久化
  const getUpdated = await fetch(`${baseUrl}/v1/models/config`, {
    headers: { authorization: 'Bearer user-a' },
  });
  assert.equal(getUpdated.status, 200);
  const updatedData = await getUpdated.json();
  assert.equal(updatedData.model, 'deepseek-chat');
  assert.equal(updatedData.apiBaseUrl, 'https://api.deepseek.com/v1');
  assert.equal(updatedData.apiKeyMasked, true);
  assert.equal(updatedData.hasApiKey, true);
  assert.notEqual(updatedData.apiKey, 'sk-test-key-123456');
  assert.match(updatedData.apiKey, /\*\*\*\*/);
});

test('DELETE /v1/sessions/:id removes the owner session and its records', async (t) => {
  const { baseUrl, store } = await startControlServer(t);
  const session = await store.createSession('user-a', '待删除');
  store.messages.set(session.id, [{ id: 'm1', role: 'user', text: 'hi' }]);

  const response = await fetch(`${baseUrl}/v1/sessions/${session.id}`, {
    method: 'DELETE',
    headers: { authorization: 'Bearer user-a' },
  });
  assert.equal(response.status, 204);
  assert.equal(store.sessions.has(session.id), false);
  assert.equal(store.messages.has(session.id), false);

  const list = await fetch(`${baseUrl}/v1/sessions`, {
    headers: { authorization: 'Bearer user-a' },
  });
  const { sessions } = await list.json();
  assert.equal(sessions.some((item) => item.id === session.id), false);
});

test('DELETE /v1/sessions/:id is scoped to the owner and rejects active runs', async (t) => {
  const { baseUrl, store } = await startControlServer(t);
  const session = await store.createSession('user-a', 'user-a 的会话');
  const foreign = await store.createSession('user-b', 'user-b 的会话');

  // 跨用户删除一律 404，不泄露存在性
  const foreignResponse = await fetch(`${baseUrl}/v1/sessions/${foreign.id}`, {
    method: 'DELETE',
    headers: { authorization: 'Bearer user-a' },
  });
  assert.equal(foreignResponse.status, 404);
  assert.equal(store.sessions.has(foreign.id), true);

  // 不存在的会话 404
  const missingResponse = await fetch(`${baseUrl}/v1/sessions/00000000-0000-0000-0000-000000000000`, {
    method: 'DELETE',
    headers: { authorization: 'Bearer user-a' },
  });
  assert.equal(missingResponse.status, 404);

  // 有排队中任务时拒绝删除
  store.runs.set('run-active', { id: 'run-active', status: 'queued', userId: 'user-a', sessionId: session.id });
  const busyResponse = await fetch(`${baseUrl}/v1/sessions/${session.id}`, {
    method: 'DELETE',
    headers: { authorization: 'Bearer user-a' },
  });
  assert.equal(busyResponse.status, 409);
  const busyBody = await busyResponse.json();
  assert.equal(busyBody.error, 'SESSION_RUN_IN_PROGRESS');
  assert.equal(store.sessions.has(session.id), true);
});

test('model profiles CRUD and activation feed the active agent config', async (t) => {
  const { baseUrl, store } = await startControlServer(t);
  const authHeaders = { authorization: 'Bearer user-a', 'content-type': 'application/json' };

  // 新建档案
  const createResponse = await fetch(`${baseUrl}/v1/models/configs`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      name: 'DeepSeek V3',
      provider: 'openai-compatible',
      apiBaseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-test-deepseek',
      model: 'deepseek-chat',
    }),
  });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json();
  assert.equal(created.name, 'DeepSeek V3');

  // 同名保存走更新而不是新增
  await fetch(`${baseUrl}/v1/models/configs`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      name: 'DeepSeek V3',
      provider: 'openai-compatible',
      apiBaseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-test-deepseek-2',
      model: 'deepseek-chat',
    }),
  });
  const listResponse = await fetch(`${baseUrl}/v1/models/configs`, {
    headers: { authorization: 'Bearer user-a' },
  });
  const { profiles } = await listResponse.json();
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].apiKeyMasked, true);
  assert.notEqual(profiles[0].apiKey, 'sk-test-deepseek-2');
  assert.match(profiles[0].apiKey, /\*\*\*\*/);

  // 激活档案 → 当前生效配置同步更新（云端 Agent 读取的即为此配置）
  const activateResponse = await fetch(`${baseUrl}/v1/models/configs/${created.id}/activate`, {
    method: 'POST',
    headers: { authorization: 'Bearer user-a' },
  });
  assert.equal(activateResponse.status, 200);
  const activeConfig = await store.getUserModelConfig('user-a');
  assert.equal(activeConfig.model, 'deepseek-chat');
  assert.equal(activeConfig.apiKey, 'sk-test-deepseek-2');

  // 删除档案；重复删除 404
  const deleteResponse = await fetch(`${baseUrl}/v1/models/configs/${created.id}`, {
    method: 'DELETE',
    headers: { authorization: 'Bearer user-a' },
  });
  assert.equal(deleteResponse.status, 204);
  const repeatResponse = await fetch(`${baseUrl}/v1/models/configs/${created.id}`, {
    method: 'DELETE',
    headers: { authorization: 'Bearer user-a' },
  });
  assert.equal(repeatResponse.status, 404);
});

test('model profiles are scoped to their owner', async (t) => {
  const { baseUrl, store } = await startControlServer(t);
  const created = await store.saveModelProfile('user-a', {
    name: 'user-a 的档案',
    provider: 'openai-compatible',
    apiBaseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-user-a',
    model: 'model-a',
  });

  // user-b 无法激活或删除 user-a 的档案
  const activateResponse = await fetch(`${baseUrl}/v1/models/configs/${created.id}/activate`, {
    method: 'POST',
    headers: { authorization: 'Bearer user-b' },
  });
  assert.equal(activateResponse.status, 404);
  const deleteResponse = await fetch(`${baseUrl}/v1/models/configs/${created.id}`, {
    method: 'DELETE',
    headers: { authorization: 'Bearer user-b' },
  });
  assert.equal(deleteResponse.status, 404);
  assert.equal(await store.activateModelProfile('user-b', created.id), null);
});

test('model profile creation validates required fields', async (t) => {
  const { baseUrl } = await startControlServer(t);
  const response = await fetch(`${baseUrl}/v1/models/configs`, {
    method: 'POST',
    headers: { authorization: 'Bearer user-a', 'content-type': 'application/json' },
    body: JSON.stringify({ name: '缺 Key', provider: 'openai-compatible', apiBaseUrl: 'https://x', model: 'm' }),
  });
  assert.equal(response.status, 400);
});

class PreviewFakeRuntimeSocket {
  constructor() {
    this.readyState = 1;
    this.sent = [];
  }
  send(message) {
    this.sent.push(JSON.parse(message));
  }
}

test('POST /v1/tools/execute rejects tools outside the read-only whitelist', async (t) => {
  const { baseUrl } = await startControlServer(t);
  const response = await fetch(`${baseUrl}/v1/tools/execute`, {
    method: 'POST',
    headers: { authorization: 'Bearer user-a', 'content-type': 'application/json' },
    body: JSON.stringify({ tool: 'fs.write', args: { path: 'x.txt', content: 'nope' } }),
  });
  assert.equal(response.status, 400);
});

test('POST /v1/tools/execute routes read-only tools to the pod and audits them', async (t) => {
  const { baseUrl, store, toolRouter } = await startControlServer(t);
  const runtimeSocket = new PreviewFakeRuntimeSocket();
  toolRouter.registerRuntime('user-a', 'pod-a', ['fs'], runtimeSocket);

  const pending = fetch(`${baseUrl}/v1/tools/execute`, {
    method: 'POST',
    headers: { authorization: 'Bearer user-a', 'content-type': 'application/json' },
    body: JSON.stringify({ tool: 'fs.list', args: { path: '.' } }),
  });

  const deadline = Date.now() + 1000;
  while (runtimeSocket.sent.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(runtimeSocket.sent[0].type, 'tool.request');
  assert.equal(runtimeSocket.sent[0].tool, 'fs.list');
  assert.equal(runtimeSocket.sent[0].requiresApproval, false);

  await toolRouter.handleResult(runtimeSocket, {
    type: 'tool.result',
    requestId: runtimeSocket.sent[0].requestId,
    result: {
      ok: true,
      data: { path: '.', entries: [{ name: '.port', path: '.port', type: 'file', size: 6 }] },
    },
  });

  const response = await pending;
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.entries[0].name, '.port');

  // UI 审计：completed 终态
  const audits = [...(store.uiToolCalls?.values() ?? [])];
  assert.equal(audits.length, 1);
  assert.equal(audits[0].tool, 'fs.list');
  assert.equal(audits[0].status, 'completed');
});

test('POST /v1/tools/execute reports RUNTIME_OFFLINE when no pod is online', async (t) => {
  const { baseUrl, store } = await startControlServer(t);
  const response = await fetch(`${baseUrl}/v1/tools/execute`, {
    method: 'POST',
    headers: { authorization: 'Bearer user-a', 'content-type': 'application/json' },
    body: JSON.stringify({ tool: 'fs.read', args: { path: '.port' } }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'RUNTIME_OFFLINE');
  const audits = [...(store.uiToolCalls?.values() ?? [])];
  assert.equal(audits[0].status, 'failed');
  assert.equal(audits[0].resultCode, 'RUNTIME_OFFLINE');
});
