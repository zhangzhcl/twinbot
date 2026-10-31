const assert = require('node:assert/strict');
const { once } = require('node:events');
const http = require('node:http');
const test = require('node:test');
const { ControlApiClient, ControlApiError } = require('../dist/controlApiClient.js');

test('Control API client rejects plaintext connections to remote hosts', () => {
  assert.throws(
    () => new ControlApiClient({
      baseUrl: 'http://control.example.com',
      token: 'test-token',
    }),
    /must use HTTPS outside loopback/,
  );
});

test('Control API client authenticates and sends a user message', async (t) => {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null,
    });
    response.writeHead(202, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      message: { id: 'message-1', sequence: 1, role: 'user', text: 'Hello', createdAt: '2026-10-27T00:00:00Z' },
      run: { id: 'run-1', status: 'queued' },
    }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const client = new ControlApiClient({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    token: 'test-token',
  });
  const result = await client.sendMessage('session/one', 'Hello');

  assert.equal(result.run.id, 'run-1');
  assert.deepEqual(requests, [{
    method: 'POST',
    url: '/v1/sessions/session%2Fone/messages',
    authorization: 'Bearer test-token',
    body: { text: 'Hello' },
  }]);
});

test('Control API client reports non-success responses with status and API error', async (t) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(409, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'SESSION_RUN_IN_PROGRESS' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const client = new ControlApiClient({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    token: 'test-token',
  });

  await assert.rejects(
    () => client.sendMessage('session-1', 'Hello'),
    (error) => error instanceof ControlApiError &&
      error.status === 409 &&
      error.code === 'SESSION_RUN_IN_PROGRESS',
  );
});

test('Control API client reads sessions, history, and persisted run state', async (t) => {
  const requests = [];
  const machineList = {
    machines: [{
      machineId: 'machine-1',
      label: 'Workstation',
      capabilities: ['fs'],
    }],
    selectedMachineId: 'machine-1',
  };
  const session = {
    id: 'session-1',
    title: 'Planning',
    createdAt: '2026-10-27T00:00:00Z',
    updatedAt: '2026-10-27T00:00:00Z',
  };
  const cancelledRun = { id: 'run-1', status: 'cancelled' };
  const server = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.writeHead(200, { 'content-type': 'application/json' });
    if (request.url === '/v1/sessions') {
      response.end(JSON.stringify({ sessions: [session] }));
    } else if (request.url === '/v1/machines') {
      response.end(JSON.stringify(machineList));
    } else if (request.url === '/v1/machines/selection') {
      response.end(JSON.stringify({ selectedMachineId: 'machine-1' }));
    } else if (request.url === '/v1/sessions/session-1/messages') {
      response.end(JSON.stringify({ messages: [] }));
    } else if (request.url === '/v1/runs/run-1') {
      response.end(JSON.stringify({ id: 'run-1', status: 'completed' }));
    } else if (request.url === '/v1/runs/run-1/cancel') {
      response.end(JSON.stringify(cancelledRun));
    } else {
      response.writeHead(404);
      response.end(JSON.stringify({ error: 'NOT_FOUND' }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const client = new ControlApiClient({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    token: 'test-token',
  });

  assert.deepEqual(await client.listSessions(), [session]);
  assert.deepEqual(await client.listMachines(), machineList);
  assert.deepEqual(await client.selectMachine('machine-1'), {
    selectedMachineId: 'machine-1',
  });
  assert.deepEqual(await client.listMessages('session-1'), []);
  assert.deepEqual(await client.getRun('run-1'), {
    id: 'run-1',
    status: 'completed',
  });
  assert.deepEqual(await client.cancelRun('run-1'), cancelledRun);
  assert.deepEqual(requests, [
    'GET /v1/sessions',
    'GET /v1/machines',
    'POST /v1/machines/selection',
    'GET /v1/sessions/session-1/messages',
    'GET /v1/runs/run-1',
    'POST /v1/runs/run-1/cancel',
  ]);
});
