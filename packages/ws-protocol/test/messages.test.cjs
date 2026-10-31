const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ClientToServerMessageSchema,
  ServerToClientMessageSchema,
} = require('../dist/messages.js');

test('client-to-server schema accepts a cloud runtime registration', () => {
  const result = ClientToServerMessageSchema.safeParse({
    type: 'runtime.hello',
    podId: 'pod-a',
    capabilities: ['fs'],
    protocolVersion: 1,
  });

  assert.equal(result.success, true);
});

test('client-to-server schema rejects unsupported cloud runtime capabilities', () => {
  const result = ClientToServerMessageSchema.safeParse({
    type: 'runtime.hello',
    podId: 'pod-a',
    capabilities: ['unsupported-capability'],
  });

  assert.equal(result.success, false);
});

test('server-to-client schema rejects malformed tool requests', () => {
  const result = ServerToClientMessageSchema.safeParse({
    type: 'tool.request',
    requestId: 'req-1',
    tool: 'fs.read',
    args: { path: '' },
    requiresApproval: false,
  });

  assert.equal(result.success, false);
});

test('server-to-client schema accepts valid tool requests', () => {
  const result = ServerToClientMessageSchema.safeParse({
    type: 'tool.request',
    requestId: 'req-1',
    tool: 'fs.read',
    args: { path: 'notes.txt' },
    requiresApproval: false,
    timeoutMs: 5000,
  });

  test('server-to-client schema accepts a valid fs.list request', () => {
    const result = ServerToClientMessageSchema.safeParse({
      type: 'tool.request',
      requestId: 'req-list',
      tool: 'fs.list',
      args: { path: 'C:\\Users\\user-a\\Documents' },
      requiresApproval: true,
      approvalId: 'approval-list',
    });

    assert.equal(result.success, true);
  });

  assert.equal(result.success, true);
});

test('server-to-client schema rejects arguments for a different tool', () => {
  const result = ServerToClientMessageSchema.safeParse({
    type: 'tool.request',
    requestId: 'req-2',
    tool: 'fs.read',
    args: { command: 'whoami' },
    requiresApproval: false,
  });

  assert.equal(result.success, false);
});

test('client-to-server schema rejects unknown message types', () => {
  const result = ClientToServerMessageSchema.safeParse({
    type: 'machine.admin',
    machineId: 'machine-1',
  });

  assert.equal(result.success, false);
});

test('client-to-server schema requires result data for successful tool results', () => {
  const result = ClientToServerMessageSchema.safeParse({
    type: 'tool.result',
    requestId: 'req-3',
    result: { ok: true },
  });

  assert.equal(result.success, false);
});
