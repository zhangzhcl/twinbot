// 端到端中继验证：模拟桌面 WSS 客户端发送 preview.request，断言收到 200 与产物内容
const WebSocket = require('/app/node_modules/ws');
const fs = require('node:fs');

const env = fs.readFileSync('/app/.env', 'utf8');
const line = env.split('\n').find((l) => l.startsWith('CONTROL_TOKENS_JSON='));
const mapping = JSON.parse(line.split('=').slice(1).join('='));
const token = Object.keys(mapping)[0];

const ws = new WebSocket('ws://127.0.0.1:8787/v1/ws', {
  headers: { authorization: `Bearer ${token}` },
});

ws.on('open', () => {
  ws.send(JSON.stringify({
    type: 'machine.hello',
    machineId: 'relay-verify-machine',
    capabilities: [],
    label: 'relay-verify',
    protocolVersion: 1,
  }));
  setTimeout(() => {
    ws.send(JSON.stringify({
      type: 'preview.request',
      requestId: 'relay-verify-1',
      port: 34567,
      method: 'GET',
      path: '/index.html',
      headers: {},
    }));
  }, 500);
});

ws.on('message', (data) => {
  const message = JSON.parse(data.toString());
  if (message.type === 'preview.response') {
    const body = Buffer.from(message.bodyBase64 || '', 'base64').toString('utf8');
    console.log('STATUS:', message.status);
    console.log('BODY:', body.trim());
    const pass = message.status === 200 && body.includes('artifact-ok');
    console.log(pass ? 'RELAY-VERIFY-PASS' : 'RELAY-VERIFY-FAIL');
    process.exit(pass ? 0 : 1);
  }
});

ws.on('error', (error) => {
  console.log('WS-ERROR:', error.message);
  process.exit(1);
});

setTimeout(() => {
  console.log('RELAY-VERIFY-TIMEOUT');
  process.exit(1);
}, 15000);
