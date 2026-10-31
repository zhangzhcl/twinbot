export const INITIAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS app_users (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  title text NOT NULL,
  next_sequence integer NOT NULL DEFAULT 1 CHECK (next_sequence > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sessions_owner_updated_idx
  ON sessions (owner_user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS machines (
  owner_user_id text NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  machine_id text NOT NULL,
  label text NOT NULL DEFAULT '',
  capabilities text[] NOT NULL DEFAULT '{}',
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (owner_user_id, machine_id)
);

CREATE TABLE IF NOT EXISTS cloud_runtimes (
  owner_user_id text NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  pod_id text NOT NULL,
  capabilities text[] NOT NULL DEFAULT '{}',
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (owner_user_id, pod_id)
);

CREATE TABLE IF NOT EXISTS machine_selections (
  owner_user_id text PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
  machine_id text NOT NULL,
  selected_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (owner_user_id, machine_id)
    REFERENCES machines(owner_user_id, machine_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id uuid PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (
    status IN ('queued', 'running', 'completed', 'failed', 'cancelled')
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  error text
);

CREATE INDEX IF NOT EXISTS agent_runs_queue_idx
  ON agent_runs (status, created_at);

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  sequence integer NOT NULL CHECK (sequence > 0),
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, sequence)
);

CREATE INDEX IF NOT EXISTS messages_owner_session_sequence_idx
  ON messages (owner_user_id, session_id, sequence);

CREATE TABLE IF NOT EXISTS tool_calls (
  request_id uuid PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  machine_id text NOT NULL,
  tool text NOT NULL CHECK (tool IN ('fs.read', 'fs.list')),
  status text NOT NULL CHECK (
    status IN ('requested', 'approved', 'denied', 'completed', 'failed', 'timed_out', 'cancelled')
  ),
  result_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tool_calls
  DROP CONSTRAINT IF EXISTS tool_calls_tool_check;
ALTER TABLE tool_calls
  ADD CONSTRAINT tool_calls_tool_check CHECK (tool IN (
    'fs.read', 'fs.list', 'fs.write', 'fs.edit', 'fs.glob', 'fs.grep',
    'shell.exec', 'files.copy', 'code.run', 'web.fetch', 'web.search',
    'browser.use', 'user.ask', 'notebook.read', 'notebook.edit',
    'lsp.query', 'vcs.checkpoint'
  ));

CREATE INDEX IF NOT EXISTS tool_calls_run_created_idx
  ON tool_calls (owner_user_id, run_id, created_at);

CREATE TABLE IF NOT EXISTS task_outbox (
  id uuid PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  UNIQUE (run_id, event_type)
);

ALTER TABLE task_outbox
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
ALTER TABLE task_outbox
  ADD COLUMN IF NOT EXISTS locked_at timestamptz;

CREATE TABLE IF NOT EXISTS user_model_configs (
  owner_user_id text PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'openai-compatible',
  api_base_url text NOT NULL,
  api_key text NOT NULL,
  model text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 多套模型配置档案：保存多组供应商/密钥/模型，启用时同步到 user_model_configs 供云端 Agent 使用
CREATE TABLE IF NOT EXISTS user_model_profiles (
  id uuid PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  name text NOT NULL,
  provider text NOT NULL DEFAULT 'openai-compatible',
  api_base_url text NOT NULL DEFAULT '',
  api_key text NOT NULL,
  model text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, name)
);

-- 桌面端 UI 直连的只读工具调用审计（与 Agent 的 tool_calls 分开，不挂 agent run）
CREATE TABLE IF NOT EXISTS ui_tool_calls (
  request_id uuid PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  tool text NOT NULL,
  status text NOT NULL CHECK (status IN ('requested', 'completed', 'failed', 'timed_out', 'cancelled')),
  result_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS runtime_selections (
  owner_user_id text PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
  pod_id text NOT NULL,
  selected_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (owner_user_id, pod_id)
    REFERENCES cloud_runtimes(owner_user_id, pod_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_memories (
  id uuid PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  key text NOT NULL,
  content text NOT NULL,
  importance integer NOT NULL DEFAULT 0 CHECK (importance >= 0 AND importance <= 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, key)
);

CREATE INDEX IF NOT EXISTS user_memories_owner_updated_idx
  ON user_memories (owner_user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS routines (
  id uuid PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  name text NOT NULL,
  prompt text NOT NULL,
  session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  schedule_kind text NOT NULL CHECK (schedule_kind IN ('cron', 'interval', 'event')),
  cron_expr text,
  interval_ms integer CHECK (interval_ms IS NULL OR interval_ms >= 60000),
  event_type text,
  enabled boolean NOT NULL DEFAULT true,
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, name)
);

CREATE INDEX IF NOT EXISTS routines_due_idx
  ON routines (enabled, schedule_kind, next_run_at)
  WHERE enabled = true AND schedule_kind IN ('cron', 'interval');

CREATE INDEX IF NOT EXISTS routines_event_idx
  ON routines (owner_user_id, event_type)
  WHERE enabled = true AND schedule_kind = 'event';
`;
