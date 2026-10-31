const assert = require('node:assert/strict');
const { once } = require('node:events');
const http = require('node:http');
const test = require('node:test');
const { PiAgentEngine } = require('../dist/piAgent.js');

test('Pi agent uses persisted history and exposes no host built-in tools', async (t) => {
  let requestBody;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      for (const payload of [
        { choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { content: 'Pi response' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ]) {
        response.write(`data: ${JSON.stringify(payload)}\n\n`);
      }
      response.end('data: [DONE]\n\n');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const engine = new PiAgentEngine({
    provider: 'openai-compatible',
    model: 'gpt-4o-mini',
    apiKey: 'test-key',
    apiBaseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    timeoutMs: 2000,
  });
  const reply = await engine.generate([
    { role: 'user', text: 'Earlier question' },
    { role: 'assistant', text: 'Earlier answer' },
    { role: 'user', text: 'Current question' },
  ]);

  assert.equal(reply, 'Pi response');
  assert.deepEqual(
    requestBody.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role,
        content: Array.isArray(message.content)
          ? message.content.map((part) => part.text).join('')
          : message.content,
      })),
    [
      { role: 'user', content: 'Earlier question' },
      { role: 'assistant', content: 'Earlier answer' },
      { role: 'user', content: 'Current question' },
    ],
  );
  assert.equal(requestBody.tools?.length ?? 0, 0);
});

test('Pi agent routes local fs.read through the authenticated user tool router', async (t) => {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const payloads = requests.length === 1
        ? [
            { choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
            {
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: 'call-fs-read',
                    type: 'function',
                    function: {
                      name: 'local_fs_read',
                      arguments: '{"path":"C:\\\\Users\\\\user-a\\\\notes.txt"}',
                    },
                  }],
                },
                finish_reason: null,
              }],
            },
            { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
          ]
        : [
            { choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
            { choices: [{ index: 0, delta: { content: 'I read the approved file.' }, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
          ];
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });

      for (const payload of payloads) {
        response.write(`data: ${JSON.stringify(payload)}\n\n`);
      }
      response.end('data: [DONE]\n\n');
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));

  const routedCalls = [];
  const engine = new PiAgentEngine({
    provider: 'openai-compatible',
    model: 'gpt-4o-mini',
    apiKey: 'test-key',
    apiBaseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    timeoutMs: 2000,
    toolRouter: {
      listConnectedMachines: () => [{ machineId: 'machine-a', capabilities: ['fs'] }],
      listConnectedRuntimes: () => [],
      requestLocalTool: async (userId, tool, args) => {
        routedCalls.push({ userId, tool, args });
        return {
          ok: true,
          data: {
            path: args.path,
            content: 'approved content',
            encoding: 'utf8',
            size: 16,
          },
        };
      },
      requestCloudTool: async () => ({ ok: false, error: { code: 'INTERNAL', message: 'unused' } }),
      requestFilesCopy: async () => ({ ok: false, error: { code: 'INTERNAL', message: 'unused' } }),
    },
  });

  const reply = await engine.generate(
    [{ role: 'user', text: 'Read my notes file' }],
    { userId: 'user-a', sessionId: 'session-a', runId: 'run-a' },
  );

  assert.equal(reply, 'I read the approved file.');
  assert.deepEqual(routedCalls, [{
    userId: 'user-a',
    tool: 'fs.read',
    args: { path: 'C:\\Users\\user-a\\notes.txt' },
  }]);
  assert.deepEqual(
    requests[0].tools.map((tool) => tool.function.name).sort(),
    [
      'local_fs_edit',
      'local_fs_glob',
      'local_fs_grep',
      'local_fs_list',
      'local_fs_read',
      'local_fs_write',
      'local_notebook_edit',
      'local_notebook_read',
    ],
  );
  assert.deepEqual(requests[1].messages.at(-1), {
    role: 'tool',
    tool_call_id: 'call-fs-read',
    content: JSON.stringify({
      path: 'C:\\Users\\user-a\\notes.txt',
      content: 'approved content',
      encoding: 'utf8',
      size: 16,
    }),
  });
});

test('Pi agent exposes the local fs.list tool only when a run-scoped router is available', async (t) => {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const payloads = requests.length === 1
        ? [
            { choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
            {
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: 'call-fs-list',
                    type: 'function',
                    function: {
                      name: 'local_fs_list',
                      arguments: '{"path":"C:\\\\Users\\\\user-a\\\\Documents"}',
                    },
                  }],
                },
                finish_reason: null,
              }],
            },
            { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
          ]
        : [
            { choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
            { choices: [{ index: 0, delta: { content: 'Done' }, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
          ];
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      for (const payload of payloads) {
        response.write(`data: ${JSON.stringify(payload)}\n\n`);
      }
      response.end('data: [DONE]\n\n');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));

  const routedCalls = [];
  const engine = new PiAgentEngine({
    provider: 'openai-compatible',
    model: 'gpt-4o-mini',
    apiKey: 'test-key',
    apiBaseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    timeoutMs: 2000,
    toolRouter: {
      listConnectedMachines: () => [{ machineId: 'machine-a', capabilities: ['fs'] }],
      listConnectedRuntimes: () => [],
      requestLocalTool: async (userId, tool, args) => {
        routedCalls.push({ userId, tool, args });
        return {
          ok: true,
          data: {
            path: args.path,
            entries: [{
              name: 'notes.txt',
              path: 'C:\\Users\\user-a\\Documents\\notes.txt',
              type: 'file',
            }],
          },
        };
      },
      requestCloudTool: async () => ({ ok: false, error: { code: 'INTERNAL', message: 'unused' } }),
      requestFilesCopy: async () => ({ ok: false, error: { code: 'INTERNAL', message: 'unused' } }),
    },
  });

  assert.equal(await engine.generate(
    [{ role: 'user', text: 'List my documents' }],
    { userId: 'user-a', sessionId: 'session-a', runId: 'run-a' },
  ), 'Done');
  assert.deepEqual(routedCalls, [{
    userId: 'user-a',
    tool: 'fs.list',
    args: { path: 'C:\\Users\\user-a\\Documents' },
  }]);
  assert.deepEqual(
    requests[0].tools.map((tool) => tool.function.name).sort(),
    [
      'local_fs_edit',
      'local_fs_glob',
      'local_fs_grep',
      'local_fs_list',
      'local_fs_read',
      'local_fs_write',
      'local_notebook_edit',
      'local_notebook_read',
    ],
  );
  assert.deepEqual(requests[1].messages.at(-1), {
    role: 'tool',
    tool_call_id: 'call-fs-list',
    content: JSON.stringify({
      path: 'C:\\Users\\user-a\\Documents',
      entries: [{
        name: 'notes.txt',
        path: 'C:\\Users\\user-a\\Documents\\notes.txt',
        type: 'file',
      }],
    }),
  });
});

test('Pi agent exposes cloud tools when a capable runtime is online', async (t) => {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      for (const payload of [
        { choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { content: 'Cloud ready' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ]) {
        response.write(`data: ${JSON.stringify(payload)}\n\n`);
      }
      response.end('data: [DONE]\n\n');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));

  const engine = new PiAgentEngine({
    provider: 'openai-compatible',
    model: 'gpt-4o-mini',
    apiKey: 'test-key',
    apiBaseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    timeoutMs: 2000,
    toolRouter: {
      listConnectedMachines: () => [],
      listConnectedRuntimes: () => [{
        podId: 'pod-a',
        capabilities: ['fs', 'shell', 'code', 'web', 'browser', 'lsp', 'vcs'],
      }],
      requestLocalTool: async () => ({ ok: false, error: { code: 'INTERNAL', message: 'unused' } }),
      requestCloudTool: async () => ({ ok: false, error: { code: 'INTERNAL', message: 'unused' } }),
      requestFilesCopy: async () => ({ ok: false, error: { code: 'INTERNAL', message: 'unused' } }),
    },
  });

  const reply = await engine.generate(
    [{ role: 'user', text: 'What can you do in the cloud?' }],
    { userId: 'user-a', sessionId: 'session-a', runId: 'run-a' },
  );

  assert.equal(reply, 'Cloud ready');
  const toolNames = requests[0].tools.map((tool) => tool.function.name).sort();
  // 云端全能力在线：15 个 cloud_* 工具全部暴露，且不含 local_* 与 files_copy
  assert.equal(toolNames.filter((name) => name.startsWith('cloud_')).length, 15);
  assert.equal(toolNames.some((name) => name.startsWith('local_')), false);
  assert.equal(toolNames.includes('files_copy'), false);
});
