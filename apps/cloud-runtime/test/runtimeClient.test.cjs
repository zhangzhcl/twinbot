const assert = require('node:assert/strict');
const { once } = require('node:events');
const test = require('node:test');
const WebSocket = require('ws');
const { WebSocketServer } = WebSocket;
const { CloudRuntimeClient } = require('../dist/runtimeClient.js');

test('runtime authenticates, registers its pod identity, and sends heartbeats', async (t) => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  t.after(() => {
    for (const socket of server.clients) socket.terminate();
    return new Promise((resolve) => server.close(resolve));
  });
  const messages = [];
  let resolvePing;
  const receivedPing = new Promise((resolve) => {
    resolvePing = resolve;
  });
  server.on('connection', (socket, request) => {
    assert.equal(request.headers.authorization, 'Bearer runtime-test-token');
    socket.on('message', (message) => {
      const parsed = JSON.parse(message.toString());
      messages.push(parsed);
      if (parsed.type === 'ping') resolvePing();
    });
  });

  const client = new CloudRuntimeClient({
    controlWsUrl: `ws://127.0.0.1:${server.address().port}/v1/ws`,
    token: 'runtime-test-token',
    podId: 'pod-a',
    heartbeatIntervalMs: 1000,
    reconnectMinMs: 10,
    reconnectMaxMs: 20,
  });
  t.after(() => client.stop());

  await client.start();
  let pingTimeout;
  try {
    await Promise.race([
      receivedPing,
      new Promise((_, reject) => {
        pingTimeout = setTimeout(
          () => reject(new Error('Runtime heartbeat was not received')),
          3000,
        );
      }),
    ]);
  } finally {
    clearTimeout(pingTimeout);
  }

  assert.deepEqual(messages[0], {
    type: 'runtime.hello',
    podId: 'pod-a',
    capabilities: [],
    protocolVersion: 1,
  });
  assert.ok(messages.some((message) => message.type === 'ping'));
});

test('runtime registers fs capability when fileTools is provided and responds to tool.request', async (t) => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  t.after(() => {
    for (const socket of server.clients) socket.terminate();
    return new Promise((resolve) => server.close(resolve));
  });

  let serverSocket;
  let resolveResult;
  const receivedResult = new Promise((resolve) => {
    resolveResult = resolve;
  });

  server.on('connection', (socket) => {
    serverSocket = socket;
    socket.on('message', (message) => {
      const parsed = JSON.parse(message.toString());
      if (parsed.type === 'tool.result') {
        resolveResult(parsed);
      }
    });
  });

  const mockFileTools = {
    read: async (args) => ({
      ok: true,
      data: {
        path: args.path,
        content: 'mock cloud file content',
        encoding: 'utf8',
        size: 23,
      },
    }),
    list: async () => ({
      ok: true,
      data: { path: '.', entries: [] },
    }),
  };

  const client = new CloudRuntimeClient({
    controlWsUrl: `ws://127.0.0.1:${server.address().port}/v1/ws`,
    token: 'runtime-test-token',
    podId: 'pod-tool-test',
    heartbeatIntervalMs: 10_000,
    fileTools: mockFileTools,
  });
  t.after(() => client.stop());

  await client.start();

  // 向 runtime 发送 tool.request
  serverSocket.send(JSON.stringify({
    type: 'tool.request',
    requestId: 'req-cloud-1',
    tool: 'fs.read',
    args: { path: 'README.md' },
    requiresApproval: false,
  }));

  const result = await receivedResult;
  assert.equal(result.type, 'tool.result');
  assert.equal(result.requestId, 'req-cloud-1');
  assert.equal(result.result.ok, true);
  assert.equal(result.result.data.content, 'mock cloud file content');
});
