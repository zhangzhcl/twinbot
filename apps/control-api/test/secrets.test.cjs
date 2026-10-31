const assert = require('node:assert/strict');
const test = require('node:test');
const {
  maskSecret,
  hasSecret,
  encryptSecret,
  decryptSecret,
  getSecretsKey,
} = require('../dist/secrets.js');

test('maskSecret never echoes the full secret', () => {
  assert.equal(maskSecret(''), '');
  assert.equal(maskSecret('abcd'), '****');
  assert.equal(maskSecret('sk-test-key-123456'), '****3456');
  assert.notEqual(maskSecret('sk-test-key-123456'), 'sk-test-key-123456');
});

test('encrypt/decrypt round-trip with MODEL_SECRETS_KEY', () => {
  const key = getSecretsKey({ MODEL_SECRETS_KEY: 'a'.repeat(64) });
  assert.ok(key);
  const enc = encryptSecret('super-secret-api-key', key);
  assert.match(enc, /^enc:v1:/);
  assert.equal(decryptSecret(enc, key), 'super-secret-api-key');
  assert.equal(encryptSecret('plain', null), 'plain');
  assert.equal(hasSecret('x'), true);
  assert.equal(hasSecret(''), false);
});
