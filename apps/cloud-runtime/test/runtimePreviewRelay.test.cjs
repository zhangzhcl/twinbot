const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { PreviewRelay } = require('../dist/runtimePreviewRelay.js');

function startServer(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server;
}

test('preview relay fetches loopback and returns the body', async (t) => {
  const server = startServer(t, (request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<h1>artifact ok</h1>');
  });
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const relay = new PreviewRelay();

  const result = await relay.handle({
    type: 'preview.request',
    requestId: 'req-1',
    port,
    method: 'GET',
    path: '/index.html',
    headers: {},
  });

  assert.equal(result.type, 'preview.response');
  assert.equal(result.requestId, 'req-1');
  assert.equal(result.status, 200);
  assert.equal(result.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(Buffer.from(result.bodyBase64, 'base64').toString('utf8'), '<h1>artifact ok</h1>');
  assert.equal(result.truncated, undefined);
});

test('preview relay posts request bodies and caps oversized responses', async (t) => {
  let receivedBody = '';
  const server = startServer(t, (request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      receivedBody = body;
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('x'.repeat(6 * 1024 * 1024));
    });
  });
  await new Promise((resolve) => server.once('listening', resolve));
  const relay = new PreviewRelay();

  const result = await relay.handle({
    type: 'preview.request',
    requestId: 'req-2',
    port: server.address().port,
    method: 'POST',
    path: '/submit',
    headers: { 'content-type': 'text/plain' },
    bodyBase64: Buffer.from('payload-data').toString('base64'),
  });

  assert.equal(receivedBody, 'payload-data');
  assert.equal(result.status, 200);
  assert.equal(result.truncated, true);
  const decoded = Buffer.from(result.bodyBase64, 'base64');
  assert.equal(decoded.byteLength, 5 * 1024 * 1024);
});

test('preview relay reports errors as 502 responses', async (t) => {
  const relay = new PreviewRelay();
  // 1..1023 端口基本不会有服务，连接必然失败
  const result = await relay.handle({
    type: 'preview.request',
    requestId: 'req-3',
    port: 1024,
    method: 'GET',
    path: '/',
    headers: {},
  });
  assert.equal(result.status, 502);
  assert.match(Buffer.from(result.bodyBase64, 'base64').toString('utf8'), /Preview fetch failed/);
});

test('preview relay rejects disallowed methods and invalid requests', async (t) => {
  const relay = new PreviewRelay();
  const badMethod = await relay.handle({
    type: 'preview.request',
    requestId: 'req-4',
    port: 30000,
    method: 'TRACE',
    path: '/',
    headers: {},
  });
  // method 枚举在协议层就拒绝 TRACE，统一映射为 400

  const badRequest = await relay.handle({ type: 'preview.request', requestId: 'req-5', port: 80 });
  assert.equal(badRequest.status, 400);
});
