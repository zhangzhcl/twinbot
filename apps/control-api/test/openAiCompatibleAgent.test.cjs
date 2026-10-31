const assert = require('node:assert/strict');
const { once } = require('node:events');
const http = require('node:http');
const test = require('node:test');
const { OpenAiCompatibleAgent } = require('../dist/openAiCompatibleAgent.js');

test('agent sends persisted conversation messages and returns provider content', async (t) => {
  let requestBody;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'Persisted reply' } }],
      }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  const agent = new OpenAiCompatibleAgent({
    apiBaseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: 'test-key',
    model: 'test-model',
    timeoutMs: 2000,
  });
  const reply = await agent.generate([
    { role: 'user', text: 'Hello' },
    { role: 'assistant', text: 'Hi' },
    { role: 'user', text: 'Continue' },
  ]);

  assert.equal(reply, 'Persisted reply');
  assert.equal(requestBody.model, 'test-model');
  assert.deepEqual(requestBody.messages, [
    { role: 'system', content: 'You are a helpful assistant. Respond concisely and accurately.' },
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi' },
    { role: 'user', content: 'Continue' },
  ]);
});

test('agent reports provider responses without assistant text', async (t) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const agent = new OpenAiCompatibleAgent({
    apiBaseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    apiKey: 'test-key',
    model: 'test-model',
    timeoutMs: 2000,
  });

  await assert.rejects(() => agent.generate([]), /no assistant content/);
});
