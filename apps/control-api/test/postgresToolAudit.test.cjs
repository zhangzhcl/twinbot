const assert = require('node:assert/strict');
const test = require('node:test');
const { PostgresConversationStore } = require('../dist/postgresConversationStore.js');
const { INITIAL_SCHEMA_SQL } = require('../dist/schema.js');

test('tool audit schema stores lifecycle metadata without file paths or results', () => {
  assert.match(INITIAL_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS tool_calls/);
  assert.match(INITIAL_SCHEMA_SQL, /tool IN \('fs\.read', 'fs\.list'\)/);
  assert.match(INITIAL_SCHEMA_SQL, /DROP CONSTRAINT IF EXISTS tool_calls_tool_check/);
  assert.match(INITIAL_SCHEMA_SQL, /'requested', 'approved', 'denied', 'completed', 'failed', 'timed_out', 'cancelled'/);
  assert.match(INITIAL_SCHEMA_SQL, /result_code text/);
  assert.doesNotMatch(INITIAL_SCHEMA_SQL, /arguments jsonb|result jsonb|file_content/i);
});

test('machine selection schema persists one selected executor per user', () => {
  assert.match(INITIAL_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS machine_selections/);
  assert.match(
    INITIAL_SCHEMA_SQL,
    /FOREIGN KEY \(owner_user_id, machine_id\)\s+REFERENCES machines/,
  );
  assert.match(INITIAL_SCHEMA_SQL, /ON DELETE CASCADE/);
});

test('cloud runtime schema and repository persist owner-scoped pod identity', async () => {
  assert.match(INITIAL_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS cloud_runtimes/);
  assert.match(INITIAL_SCHEMA_SQL, /PRIMARY KEY \(owner_user_id, pod_id\)/);
  const statements = [];
  const store = new PostgresConversationStore({
    async query(text, values) {
      statements.push({ text, values });
      return { rowCount: 1, rows: [] };
    },
  });

  await store.registerRuntime('user-a', 'pod-a', ['fs']);

  assert.match(statements[0].text, /INSERT INTO app_users/);
  assert.deepEqual(statements[0].values, ['user-a']);
  assert.match(statements[1].text, /INSERT INTO cloud_runtimes/);
  assert.match(statements[1].text, /ON CONFLICT \(owner_user_id, pod_id\) DO UPDATE/);
  assert.deepEqual(statements[1].values, ['user-a', 'pod-a', ['fs']]);
});

test('cloud runtime heartbeat refresh is scoped to the credential owner and pod', async () => {
  const statements = [];
  const store = new PostgresConversationStore({
    async query(text, values) {
      statements.push({ text, values });
      return { rowCount: 1, rows: [] };
    },
  });

  await store.touchRuntime('user-a', 'pod-a');

  assert.match(statements[0].text, /UPDATE cloud_runtimes/);
  assert.match(statements[0].text, /owner_user_id = \$1 AND pod_id = \$2/);
  assert.match(statements[0].text, /revoked_at IS NULL/);
  assert.deepEqual(statements[0].values, ['user-a', 'pod-a']);
});

test('machine selection repository persists and returns the owner-scoped selection', async () => {
  const queries = [];
  const store = new PostgresConversationStore({
    async query(text, values) {
      queries.push({ text, values });
      if (/SELECT machine_id FROM machine_selections/.test(text)) {
        return { rowCount: 1, rows: [{ machine_id: 'machine-a' }] };
      }
      return { rowCount: 1, rows: [] };
    },
  });

  await store.setSelectedMachineId('user-a', 'machine-a');
  assert.equal(await store.getSelectedMachineId('user-a'), 'machine-a');
  await store.setSelectedMachineId('user-a', null);

  assert.match(queries[0].text, /INSERT INTO machine_selections/);
  assert.deepEqual(queries[0].values, ['user-a', 'machine-a']);
  assert.match(queries[1].text, /owner_user_id = \$1/);
  assert.deepEqual(queries[1].values, ['user-a']);
  assert.match(queries[2].text, /DELETE FROM machine_selections/);
  assert.deepEqual(queries[2].values, ['user-a']);
});

test('machine selection repository fails when the selected machine is unavailable', async () => {
  const store = new PostgresConversationStore({
    async query() {
      return { rowCount: 0, rows: [] };
    },
  });

  await assert.rejects(
    () => store.setSelectedMachineId('user-a', 'machine-offline'),
    /unknown local machine/,
  );
});

test('run cancellation is owner-scoped and removes queued work from the outbox', async () => {
  const statements = [];
  const client = {
    async query(text, values) {
      statements.push({ text, values });
      if (/UPDATE agent_runs/.test(text)) {
        return {
          rowCount: 1,
          rows: [{ id: 'run-1', status: 'cancelled', error: 'Cancelled by user' }],
        };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  const store = new PostgresConversationStore({
    async connect() {
      return client;
    },
    async query() {
      throw new Error('fallback lookup should not be used');
    },
  });

  assert.deepEqual(await store.cancelRun('user-a', 'run-1'), {
    id: 'run-1',
    status: 'cancelled',
    error: 'Cancelled by user',
  });
  const outboxLock = statements.findIndex(({ text }) =>
    /SELECT .*FROM task_outbox/.test(text),
  );
  const runUpdate = statements.findIndex(({ text }) => /UPDATE agent_runs/.test(text));
  const outboxUpdate = statements.findIndex(({ text }) => /UPDATE task_outbox/.test(text));
  assert.ok(outboxLock >= 0);
  assert.ok(runUpdate > outboxLock);
  assert.ok(outboxUpdate > runUpdate);
  assert.match(statements[runUpdate].text, /owner_user_id = \$2/);
  assert.match(statements[runUpdate].text, /status IN \('queued', 'running'\)/);
  assert.deepEqual(statements[runUpdate].values, ['run-1', 'user-a']);
});

test('a cancelled run cannot persist a late assistant response', async () => {
  const statements = [];
  const client = {
    async query(text) {
      statements.push(text);
      if (/SELECT .*FROM task_outbox/.test(text)) {
        return { rowCount: 1, rows: [{ id: 'outbox-1' }] };
      }
      if (/SELECT status FROM agent_runs/.test(text)) {
        return { rowCount: 1, rows: [{ status: 'cancelled' }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  const store = new PostgresConversationStore({
    async connect() {
      return client;
    },
  });

  await store.completeRun({
    id: 'run-1',
    userId: 'user-a',
    sessionId: 'session-1',
  }, 'late response');

  assert.equal(statements.includes('COMMIT'), true);
  assert.equal(statements.some((statement) => /INSERT INTO messages/.test(statement)), false);
  assert.ok(
    statements.findIndex((statement) => /FROM task_outbox/.test(statement)) <
      statements.findIndex((statement) => /FROM agent_runs/.test(statement)),
  );
});

test('run failure locks outbox before run to match claim and cancellation lock ordering', async () => {
  const statements = [];
  const client = {
    async query(text) {
      statements.push(text);
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  const store = new PostgresConversationStore({
    async connect() {
      return client;
    },
  });

  await store.failRun({
    id: 'run-1',
    userId: 'user-a',
    sessionId: 'session-1',
  }, 'provider failure');

  const outboxLock = statements.findIndex((statement) =>
    /SELECT .*FROM task_outbox/.test(statement),
  );
  const runUpdate = statements.findIndex((statement) =>
    /UPDATE agent_runs/.test(statement),
  );
  assert.ok(outboxLock >= 0);
  assert.ok(runUpdate > outboxLock);
});

test('run claim locks only the outbox row before locking the run', async () => {
  const statements = [];
  const client = {
    async query(text) {
      statements.push(text);
      if (/SELECT outbox\.run_id AS id/.test(text)) {
        return { rowCount: 1, rows: [{ id: 'run-1' }] };
      }
      if (/SELECT id, owner_user_id, session_id/.test(text)) {
        return {
          rowCount: 1,
          rows: [{ id: 'run-1', owner_user_id: 'user-a', session_id: 'session-1' }],
        };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  const store = new PostgresConversationStore({
    async connect() {
      return client;
    },
  });

  assert.deepEqual(await store.claimNextRun(30_000), {
    id: 'run-1',
    userId: 'user-a',
    sessionId: 'session-1',
  });
  const outboxClaim = statements.findIndex((statement) =>
    /SELECT outbox\.run_id AS id/.test(statement),
  );
  const runLock = statements.findIndex((statement) =>
    /SELECT id, owner_user_id, session_id/.test(statement),
  );
  assert.ok(outboxClaim >= 0);
  assert.match(statements[outboxClaim], /FOR UPDATE OF outbox SKIP LOCKED/);
  assert.doesNotMatch(statements[outboxClaim], /FOR UPDATE OF outbox,\s*runs/);
  assert.ok(runLock > outboxClaim);
  assert.match(statements[runLock], /FOR UPDATE/);
});

test('tool audit writes are correlated to a run and machine without persisting payload content', async () => {
  const queries = [];
  const store = new PostgresConversationStore({
    async query(text, values) {
      queries.push({ text, values });
      return { rowCount: 1, rows: [] };
    },
  });

  await store.recordToolCallStarted({
    requestId: 'request-1',
    userId: 'user-1',
    sessionId: 'session-1',
    runId: 'run-1',
    machineId: 'machine-1',
    tool: 'fs.read',
  });
  await store.recordToolCallStatus({
    requestId: 'request-1',
    userId: 'user-1',
    runId: 'run-1',
    status: 'completed',
  });

  assert.match(queries[0].text, /owner_user_id = \$2 AND session_id = \$3/);
  assert.match(queries[0].text, /owner_user_id = \$2 AND machine_id = \$5 AND revoked_at IS NULL/);
  assert.deepEqual(queries[0].values, [
    'request-1',
    'user-1',
    'session-1',
    'run-1',
    'machine-1',
    'fs.read',
  ]);
  assert.deepEqual(queries[1].values, [
    'request-1',
    'user-1',
    'run-1',
    'completed',
    null,
  ]);
  assert.doesNotMatch(queries.map((query) => query.text).join('\n'), /content|path|args/i);
});

test('tool audit updates fail explicitly when the owner/run/request tuple is unknown', async () => {
  const store = new PostgresConversationStore({
    async query() {
      return { rowCount: 0, rows: [] };
    },
  });

  await assert.rejects(
    () => store.recordToolCallStatus({
      requestId: 'request-other',
      userId: 'user-1',
      runId: 'run-1',
      status: 'completed',
    }),
    /unknown tool call audit record/,
  );
});

test('startup recovery closes tool calls left in flight by a prior process', async () => {
  const queries = [];
  const store = new PostgresConversationStore({
    async query(text, values) {
      queries.push({ text, values });
      return { rowCount: 2, rows: [] };
    },
  });

  const recovered = await store.failInterruptedToolCalls();

  assert.equal(recovered, 2);
  assert.match(queries[0].text, /SET status = 'failed'/);
  assert.match(queries[0].text, /result_code = 'SERVICE_RESTARTED'/);
  assert.match(queries[0].text, /status IN \('requested', 'approved'\)/);
});
