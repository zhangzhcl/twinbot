const assert = require('node:assert/strict');
const { once } = require('node:events');
const test = require('node:test');
const WebSocket = require('ws');
const { ControlWsClient } = require('../dist/wsClient.js');
const { getReconnectDelay } = require('../dist/wsClient.js');

test('WebSocket reconnect delay exponentially backs off with bounded jitter', () => {
  assert.equal(typeof getReconnectDelay, 'function');
  assert.equal(getReconnectDelay(1, () => 0), 2400);
  assert.equal(getReconnectDelay(2, () => 0.5), 6000);
  assert.equal(getReconnectDelay(10, () => 1), 60_000);
});

test('WebSocket reconnect delay rejects an invalid attempt number', () => {
  assert.equal(typeof getReconnectDelay, 'function');
  assert.throws(() => getReconnectDelay(0, () => 0.5), /attempt must be positive/);
});

test('client rejects unencrypted remote WebSocket endpoints', () => {
  assert.throws(
    () => new ControlWsClient({
      machineId: 'machine-1',
      token: 'test-token',
      url: 'ws://control.example.com/v1/ws',
      localAgent: {},
    }),
    /must use WSS/,
  );
});

test('client requires an explicit token for remote endpoints', () => {
  const previousToken = process.env.CONTROL_TOKEN;
  delete process.env.CONTROL_TOKEN;

  try {
    assert.throws(
      () => new ControlWsClient({
        machineId: 'machine-1',
        url: 'wss://control.example.com/v1/ws',
        localAgent: {},
      }),
      /CONTROL_TOKEN is required/,
    );
  } finally {
    if (previousToken !== undefined) process.env.CONTROL_TOKEN = previousToken;
  }
});

test('client sends its token in the authorization header, not the URL', async () => {
  const server = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  const token = 'secret-test-token';
  let serverSocket;
  let request;
  const connectionPromise = new Promise((resolve) => {
    server.once('connection', (socket, upgradeRequest) => {
      serverSocket = socket;
      request = upgradeRequest;
      resolve();
    });
  });
  const client = new ControlWsClient({
    machineId: 'machine-1',
    token,
    url: `ws://127.0.0.1:${address.port}/v1/ws`,
    localAgent: {},
  });

  try {
    client.start();
    await connectionPromise;
    const [rawMessage] = await once(serverSocket, 'message');

    assert.equal(request.headers.authorization, `Bearer ${token}`);
    assert.equal(request.url.includes(token), false);
    assert.equal(new URL(request.url, 'http://localhost').searchParams.get('machineId'), 'machine-1');

    const hello = JSON.parse(rawMessage.toString());
    assert.deepEqual(hello.capabilities, ['fs', 'shell', 'ask']);
  } finally {
    client.stop();
    serverSocket?.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('client reports approval and the local tool result for the same request ID', async () => {
  const server = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  const messages = [];
  let serverSocket;
  const client = new ControlWsClient({
    machineId: 'machine-1',
    token: 'test-token',
    url: `ws://127.0.0.1:${address.port}/v1/ws`,
    localAgent: {
      async askApproval() { return true; },
      async runTool(request) {
        return {
          ok: true,
          data: {
            path: request.args.path,
            content: 'approved content',
            encoding: 'utf8',
            size: 16,
          },
        };
      },
    },
  });

  try {
    const connected = new Promise((resolve) => {
      server.once('connection', (socket) => {
        serverSocket = socket;
        socket.on('message', (data) => {
          messages.push(JSON.parse(data.toString()));
        });
        resolve();
      });
    });
    client.start();
    await connected;
    await once(serverSocket, 'message');

    serverSocket.send(JSON.stringify({
      type: 'tool.request',
      requestId: 'request-1',
      tool: 'fs.read',
      args: { path: 'C:\\Users\\user-a\\notes.txt' },
      requiresApproval: true,
      approvalId: 'approval-1',
      timeoutMs: 1000,
    }));

    const deadline = Date.now() + 1000;
    while (messages.length < 3 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    assert.deepEqual(messages.slice(1), [
      {
        type: 'tool.approval',
        approvalId: 'approval-1',
        requestId: 'request-1',
        approved: true,
      },
      {
        type: 'tool.result',
        requestId: 'request-1',
        result: {
          ok: true,
          data: {
            path: 'C:\\Users\\user-a\\notes.txt',
            content: 'approved content',
            encoding: 'utf8',
            size: 16,
          },
        },
      },
    ]);
  } finally {
    client.stop();
    serverSocket?.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
});
