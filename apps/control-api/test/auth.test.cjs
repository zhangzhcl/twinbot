const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createDevTokenAuthenticator,
  createRuntimeTokenAuthenticator,
  createTokenAuthenticator,
} = require('../dist/auth.js');

test('runtime credentials resolve to one configured user and pod identity', () => {
  const token = 'r'.repeat(48);
  const authenticate = createRuntimeTokenAuthenticator({
    CLOUD_RUNTIME_TOKENS_JSON: JSON.stringify({
      [token]: { userId: 'user-a', podId: 'pod-a' },
    }),
  });

  assert.deepEqual(authenticate(`Bearer ${token}`), {
    userId: 'user-a',
    podId: 'pod-a',
  });
  assert.equal(authenticate('Bearer unknown-token'), null);
});

test('runtime credentials reject short tokens and empty identities', () => {
  assert.throws(
    () => createRuntimeTokenAuthenticator({
      CLOUD_RUNTIME_TOKENS_JSON: JSON.stringify({
        short: { userId: 'user-a', podId: 'pod-a' },
      }),
    }),
    /at least 32 characters/,
  );
  assert.throws(
    () => createRuntimeTokenAuthenticator({
      CLOUD_RUNTIME_TOKENS_JSON: JSON.stringify({
        ['r'.repeat(48)]: { userId: '', podId: 'pod-a' },
      }),
    }),
    /userId and podId/,
  );
});

test('development token maps each bearer credential to its configured user', () => {
  const authenticate = createDevTokenAuthenticator({
    NODE_ENV: 'development',
    CONTROL_DEV_TOKENS_JSON: JSON.stringify({
      'dev-token-a': 'user-a',
      'dev-token-b': 'user-b',
    }),
  });

  assert.equal(authenticate('Bearer dev-token-a'), 'user-a');
  assert.equal(authenticate('Bearer dev-token-b'), 'user-b');
  assert.equal(authenticate('Bearer unknown-token'), null);
});

test('development token auth refuses production mode', () => {
  assert.throws(
    () => createDevTokenAuthenticator({ NODE_ENV: 'production' }),
    /disabled in production/,
  );
});

test('development token auth provides a local single-user default', () => {
  const authenticate = createDevTokenAuthenticator({ NODE_ENV: 'development' });

  assert.equal(authenticate('Bearer dev-token'), 'local-dev-user');
  assert.equal(authenticate('Bearer toString'), null);
  assert.equal(authenticate('Bearer constructor'), null);
});

test('production token authentication maps long configured tokens to users', () => {
  assert.equal(typeof createTokenAuthenticator, 'function');
  const tokenA = 'a'.repeat(64);
  const tokenB = 'b'.repeat(64);
  const authenticate = createTokenAuthenticator({
    NODE_ENV: 'production',
    CONTROL_TOKENS_JSON: JSON.stringify({
      [tokenA]: 'user-a',
      [tokenB]: 'user-b',
    }),
  });

  assert.equal(authenticate(`Bearer ${tokenA}`), 'user-a');
  assert.equal(authenticate(`Bearer ${tokenB}`), 'user-b');
  assert.equal(authenticate('Bearer dev-token'), null);
});

test('production authentication refuses missing or weak configured tokens', () => {
  assert.equal(typeof createTokenAuthenticator, 'function');
  assert.throws(
    () => createTokenAuthenticator({ NODE_ENV: 'production' }),
    /CONTROL_TOKENS_JSON is required/,
  );
  assert.throws(
    () => createTokenAuthenticator({
      NODE_ENV: 'production',
      CONTROL_DEV_TOKENS_JSON: JSON.stringify({
        'dev-token': 'local-dev-user',
      }),
    }),
    /CONTROL_TOKENS_JSON is required/,
  );
  assert.throws(
    () => createTokenAuthenticator({
      NODE_ENV: 'production',
      CONTROL_TOKENS_JSON: JSON.stringify({ 'short-token': 'user-a' }),
    }),
    /at least 32 characters/,
  );
});
