const assert = require('node:assert/strict');
const test = require('node:test');
const { loadConfig } = require('../dist/config.js');

test('configuration loads the database and development tokens from one environment object', () => {
  const runtimeToken = 'r'.repeat(48);
  const config = loadConfig({
    NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/twinbot',
    CONTROL_DEV_TOKENS_JSON: '{"token-a":"user-a"}',
    CONTROL_HOST: '0.0.0.0',
    CONTROL_PORT: '9000',
    AGENT_CONCURRENCY: '3',
    CLOUD_RUNTIME_TOKENS_JSON: JSON.stringify({
      [runtimeToken]: { userId: 'user-a', podId: 'pod-a' },
    }),
  });

  assert.equal(config.databaseUrl, 'postgresql://test:test@localhost:5432/twinbot');
  assert.deepEqual(config.tokenUsers, { 'token-a': 'user-a' });
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.port, 9000);
  assert.equal(config.agentConcurrency, 3);
  assert.deepEqual(config.runtimeTokenUsers, {
    [runtimeToken]: { userId: 'user-a', podId: 'pod-a' },
  });
  assert.equal(config.agentProvider, 'openai-compatible');
});

test('configuration rejects invalid ports instead of silently defaulting', () => {
  assert.throws(
    () => loadConfig({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgresql://test:test@localhost:5432/twinbot',
      CONTROL_PORT: 'not-a-port',
    }),
    /CONTROL_PORT/,
  );
});

test('production configuration requires explicit strong user tokens', () => {
  assert.throws(
    () => loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://test:test@localhost:5432/twinbot',
    }),
    /CONTROL_TOKENS_JSON is required/,
  );

  const token = 'a'.repeat(64);
  const config = loadConfig({
    NODE_ENV: 'production',
    DATABASE_URL: `postgres://localhost:5432/twinbot`,
    CONTROL_TOKENS_JSON: JSON.stringify({ [token]: 'user-a' }),
  });
  assert.deepEqual(config.tokenUsers, { [token]: 'user-a' });
});

test('configuration enables the agent only when provider key and model are configured together', () => {
  const config = loadConfig({
    NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/twinbot',
    AGENT_API_KEY: 'test-key',
    AGENT_MODEL: 'test-model',
  });

  assert.equal(config.agentApiBaseUrl, 'https://api.openai.com/v1');
  assert.equal(config.agentApiKey, 'test-key');
  assert.equal(config.agentModel, 'test-model');
  assert.throws(
    () => loadConfig({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgresql://test:test@localhost:5432/twinbot',
      AGENT_API_KEY: 'test-key',
    }),
    /must be configured together/,
  );
});

test('configuration parses and validates serverRole', () => {
  const defaultRole = loadConfig({
    NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/twinbot',
  });
  assert.equal(defaultRole.serverRole, 'all');

  const gatewayRole = loadConfig({
    NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/twinbot',
    SERVER_ROLE: 'gateway',
  });
  assert.equal(gatewayRole.serverRole, 'gateway');

  const workerRole = loadConfig({
    NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/twinbot',
    SERVER_ROLE: 'worker',
  });
  assert.equal(workerRole.serverRole, 'worker');

  assert.throws(
    () => loadConfig({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgresql://test:test@localhost:5432/twinbot',
      SERVER_ROLE: 'invalid-role',
    }),
    /SERVER_ROLE must be one of/,
  );
});
