import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  CloudRuntimeCapability,
  MachineCapability,
} from '@lca/ws-protocol';
import type {
  AcceptedMessage,
  AgentRunRecord,
  AgentPromptMessage,
  ConversationStore,
  MessageRecord,
  ModelConfigProfile,
  ModelProfileInput,
  QueuedAgentRun,
  SessionRecord,
  ToolCallAuditStart,
  ToolCallAuditStatus,
  UiToolCallAuditStart,
  UiToolCallAuditStatus,
  UserModelConfig,
  MemoryRecord,
  MemoryInput,
  RoutineRecord,
  RoutineInput,
  RoutineFireUpdate,
} from './conversationStore';
import { SessionBusyError } from './conversationStore';
import { INITIAL_SCHEMA_SQL } from './schema';
import { nextCronFire } from './cron';
import {
  decryptSecret,
  encryptSecret,
  getSecretsKey,
} from './secrets';

interface SessionRow {
  id: string;
  title: string;
  created_at: Date;
  updated_at: Date;
}

interface MessageRow {
  id: string;
  sequence: number;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  created_at: Date;
}

function toSessionRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

interface ModelProfileRow {
  id: string;
  name: string;
  provider: string;
  api_base_url: string;
  api_key: string;
  model: string;
  created_at: Date;
  updated_at: Date;
}

function toModelProfile(row: ModelProfileRow): ModelConfigProfile {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    apiBaseUrl: row.api_base_url,
    apiKey: decryptSecret(row.api_key, getSecretsKey()),
    model: row.model,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toMessageRecord(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    sequence: row.sequence,
    role: row.role,
    text: row.content,
    createdAt: row.created_at.toISOString(),
  };
}

export class PostgresConversationStore implements ConversationStore {
  constructor(private readonly pool: Pool) {}

  async migrate(): Promise<void> {
    await this.pool.query(INITIAL_SCHEMA_SQL);
  }

  async failInterruptedToolCalls(): Promise<number> {
    const result = await this.pool.query(
      `UPDATE tool_calls
       SET status = 'failed',
           result_code = 'SERVICE_RESTARTED',
           updated_at = now()
       WHERE status IN ('requested', 'approved')`,
    );
    return result.rowCount ?? 0;
  }

  async registerMachine(
    userId: string,
    machineId: string,
    label: string | undefined,
    capabilities: MachineCapability[],
  ): Promise<void> {
    await this.pool.query(
      'INSERT INTO app_users (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
      [userId],
    );
    await this.pool.query(
      `INSERT INTO machines (owner_user_id, machine_id, label, capabilities)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (owner_user_id, machine_id) DO UPDATE
       SET label = EXCLUDED.label,
           capabilities = EXCLUDED.capabilities,
           last_seen_at = now(),
           revoked_at = NULL`,
      [userId, machineId, label ?? '', capabilities],
    );
  }

  async registerRuntime(
    userId: string,
    podId: string,
    capabilities: CloudRuntimeCapability[],
  ): Promise<void> {
    await this.pool.query(
      'INSERT INTO app_users (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
      [userId],
    );
    await this.pool.query(
      `INSERT INTO cloud_runtimes (owner_user_id, pod_id, capabilities)
       VALUES ($1, $2, $3)
       ON CONFLICT (owner_user_id, pod_id) DO UPDATE
       SET capabilities = EXCLUDED.capabilities,
           last_seen_at = now(),
           revoked_at = NULL`,
      [userId, podId, capabilities],
    );
  }

  async touchRuntime(userId: string, podId: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE cloud_runtimes
       SET last_seen_at = now()
       WHERE owner_user_id = $1 AND pod_id = $2 AND revoked_at IS NULL`,
      [userId, podId],
    );
    if (result.rowCount !== 1) {
      throw new Error('Cannot update an unknown or revoked cloud runtime');
    }
  }

  async setSelectedMachineId(
    userId: string,
    machineId: string | null,
  ): Promise<void> {
    if (machineId === null) {
      await this.pool.query(
        'DELETE FROM machine_selections WHERE owner_user_id = $1',
        [userId],
      );
      return;
    }

    const result = await this.pool.query(
      `INSERT INTO machine_selections (owner_user_id, machine_id)
       SELECT $1, $2
       WHERE EXISTS (
         SELECT 1 FROM machines
         WHERE owner_user_id = $1
           AND machine_id = $2
           AND revoked_at IS NULL
           AND 'fs' = ANY(capabilities)
       )
       ON CONFLICT (owner_user_id) DO UPDATE
       SET machine_id = EXCLUDED.machine_id,
           selected_at = now()`,
      [userId, machineId],
    );
    if (result.rowCount !== 1) {
      throw new Error('Cannot persist a selection for an unknown local machine');
    }
  }

  async getSelectedMachineId(userId: string): Promise<string | null> {
    const result = await this.pool.query<{ machine_id: string }>(
      'SELECT machine_id FROM machine_selections WHERE owner_user_id = $1',
      [userId],
    );
    return result.rows[0]?.machine_id ?? null;
  }

  async setSelectedRuntimeId(
    userId: string,
    podId: string | null,
  ): Promise<void> {
    if (podId === null) {
      await this.pool.query(
        'DELETE FROM runtime_selections WHERE owner_user_id = $1',
        [userId],
      );
      return;
    }

    const result = await this.pool.query(
      `INSERT INTO runtime_selections (owner_user_id, pod_id)
       SELECT $1, $2
       WHERE EXISTS (
         SELECT 1 FROM cloud_runtimes
         WHERE owner_user_id = $1
           AND pod_id = $2
           AND revoked_at IS NULL
       )
       ON CONFLICT (owner_user_id) DO UPDATE
       SET pod_id = EXCLUDED.pod_id,
           selected_at = now()`,
      [userId, podId],
    );
    if (result.rowCount !== 1) {
      throw new Error('Cannot persist a selection for an unknown cloud runtime');
    }
  }

  async getSelectedRuntimeId(userId: string): Promise<string | null> {
    const result = await this.pool.query<{ pod_id: string }>(
      'SELECT pod_id FROM runtime_selections WHERE owner_user_id = $1',
      [userId],
    );
    return result.rows[0]?.pod_id ?? null;
  }


  async createSession(userId: string, title: string): Promise<SessionRecord> {
    const client = await this.pool.connect();
    const sessionId = randomUUID();

    try {
      await client.query('BEGIN');
      await client.query(
        'INSERT INTO app_users (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
        [userId],
      );
      const result = await client.query<SessionRow>(
        `INSERT INTO sessions (id, owner_user_id, title)
         VALUES ($1, $2, $3)
         RETURNING id, title, created_at, updated_at`,
        [sessionId, userId, title],
      );
      await client.query('COMMIT');
      return toSessionRecord(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async listSessions(userId: string): Promise<SessionRecord[]> {
    const result = await this.pool.query<SessionRow>(
      `SELECT id, title, created_at, updated_at
       FROM sessions
       WHERE owner_user_id = $1
       ORDER BY updated_at DESC, id DESC`,
      [userId],
    );
    return result.rows.map(toSessionRecord);
  }

  /** 删除会话：先锁会话行确认归属，存在活跃任务则抛 SessionBusyError，级联清理依赖数据 */
  async deleteSession(userId: string, sessionId: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const session = await client.query(
        `SELECT id FROM sessions
         WHERE id = $1 AND owner_user_id = $2
         FOR UPDATE`,
        [sessionId, userId],
      );
      if (session.rowCount === 0) {
        await client.query('ROLLBACK');
        return false;
      }
      const activeRun = await client.query(
        `SELECT 1 FROM agent_runs
         WHERE session_id = $1 AND owner_user_id = $2
           AND status IN ('queued', 'running')
         LIMIT 1`,
        [sessionId, userId],
      );
      if (activeRun.rows.length > 0) {
        await client.query('ROLLBACK');
        throw new SessionBusyError();
      }
      // messages / agent_runs / tool_calls / task_outbox 均外键级联删除
      await client.query(
        `DELETE FROM sessions WHERE id = $1 AND owner_user_id = $2`,
        [sessionId, userId],
      );
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async updateSessionTitle(
    userId: string,
    sessionId: string,
    title: string,
  ): Promise<SessionRecord | null> {
    const result = await this.pool.query<SessionRow>(
      `UPDATE sessions
       SET title = $3, updated_at = now()
       WHERE id = $1 AND owner_user_id = $2
       RETURNING id, title, created_at, updated_at`,
      [sessionId, userId, title],
    );
    const row = result.rows[0];
    return row ? toSessionRecord(row) : null;
  }

  async setUserModelConfig(userId: string, config: UserModelConfig): Promise<void> {
    const apiKey = encryptSecret(config.apiKey, getSecretsKey());
    await this.pool.query(
      `INSERT INTO user_model_configs (owner_user_id, provider, api_base_url, api_key, model, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (owner_user_id) DO UPDATE
       SET provider = EXCLUDED.provider,
           api_base_url = EXCLUDED.api_base_url,
           api_key = EXCLUDED.api_key,
           model = EXCLUDED.model,
           updated_at = now()`,
      [userId, config.provider, config.apiBaseUrl, apiKey, config.model],
    );
  }

  async getUserModelConfig(userId: string): Promise<UserModelConfig | null> {
    const result = await this.pool.query<{
      provider: string;
      api_base_url: string;
      api_key: string;
      model: string;
    }>(
      `SELECT provider, api_base_url, api_key, model
       FROM user_model_configs
       WHERE owner_user_id = $1`,
      [userId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      provider: row.provider,
      apiBaseUrl: row.api_base_url,
      apiKey: decryptSecret(row.api_key, getSecretsKey()),
      model: row.model,
    };
  }

  async listModelProfiles(userId: string): Promise<ModelConfigProfile[]> {
    const result = await this.pool.query<{
      id: string;
      name: string;
      provider: string;
      api_base_url: string;
      api_key: string;
      model: string;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, name, provider, api_base_url, api_key, model, created_at, updated_at
       FROM user_model_profiles
       WHERE owner_user_id = $1
       ORDER BY updated_at DESC`,
      [userId],
    );
    return result.rows.map(toModelProfile);
  }

  async saveModelProfile(
    userId: string,
    profile: ModelProfileInput,
  ): Promise<ModelConfigProfile> {
    const result = await this.pool.query<ModelProfileRow>(
      `INSERT INTO user_model_profiles (id, owner_user_id, name, provider, api_base_url, api_key, model)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (owner_user_id, name) DO UPDATE
       SET provider = EXCLUDED.provider,
           api_base_url = EXCLUDED.api_base_url,
           api_key = EXCLUDED.api_key,
           model = EXCLUDED.model,
           updated_at = now()
       RETURNING id, name, provider, api_base_url, api_key, model, created_at, updated_at`,
      [randomUUID(), userId, profile.name, profile.provider, profile.apiBaseUrl, encryptSecret(profile.apiKey, getSecretsKey()), profile.model],
    );
    return toModelProfile(result.rows[0]);
  }

  async deleteModelProfile(userId: string, profileId: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM user_model_profiles
       WHERE id = $1 AND owner_user_id = $2`,
      [profileId, userId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** 启用档案：值同步到 user_model_configs，云端 Agent 从下次运行开始使用 */
  async activateModelProfile(
    userId: string,
    profileId: string,
  ): Promise<ModelConfigProfile | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query<ModelProfileRow>(
        `SELECT id, name, provider, api_base_url, api_key, model, created_at, updated_at
         FROM user_model_profiles
         WHERE id = $1 AND owner_user_id = $2
         FOR UPDATE`,
        [profileId, userId],
      );
      if (found.rows.length === 0) {
        await client.query('ROLLBACK');
        return null;
      }
      const row = found.rows[0];
      await client.query(
        `INSERT INTO user_model_configs (owner_user_id, provider, api_base_url, api_key, model, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (owner_user_id) DO UPDATE
         SET provider = EXCLUDED.provider,
             api_base_url = EXCLUDED.api_base_url,
             api_key = EXCLUDED.api_key,
             model = EXCLUDED.model,
             updated_at = now()`,
        [userId, row.provider, row.api_base_url, row.api_key, row.model],
      );
      await client.query('COMMIT');
      return toModelProfile(row);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async recordUiToolCallStarted(event: UiToolCallAuditStart): Promise<void> {
    await this.pool.query(
      `INSERT INTO ui_tool_calls (request_id, owner_user_id, tool, status)
       VALUES ($1, $2, $3, 'requested')
       ON CONFLICT (request_id) DO NOTHING`,
      [event.requestId, event.userId, event.tool],
    );
  }

  async recordUiToolCallStatus(event: UiToolCallAuditStatus): Promise<void> {
    await this.pool.query(
      `UPDATE ui_tool_calls
       SET status = $3, result_code = $4, updated_at = now()
       WHERE request_id = $1 AND owner_user_id = $2`,
      [event.requestId, event.userId, event.status, event.resultCode ?? null],
    );
  }

  async getRun(userId: string, runId: string): Promise<AgentRunRecord | null> {
    const result = await this.pool.query<{
      id: string;
      status: AgentRunRecord['status'];
      error: string | null;
    }>(
      `SELECT id, status, error FROM agent_runs
       WHERE id = $1 AND owner_user_id = $2`,
      [runId, userId],
    );
    const run = result.rows[0];
    if (!run) return null;
    return {
      id: run.id,
      status: run.status,
      ...(run.error ? { error: run.error } : {}),
    };
  }

  async cancelRun(
    userId: string,
    runId: string,
  ): Promise<AgentRunRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.lockRunOutbox(client, runId);
      const cancelled = await client.query<{
        id: string;
        status: AgentRunRecord['status'];
        error: string | null;
      }>(
        `UPDATE agent_runs
         SET status = 'cancelled', error = 'Cancelled by user', updated_at = now()
         WHERE id = $1 AND owner_user_id = $2
           AND status IN ('queued', 'running')
         RETURNING id, status, error`,
        [runId, userId],
      );
      if (cancelled.rows[0]) {
        await client.query(
          `UPDATE task_outbox SET published_at = now()
           WHERE run_id = $1 AND event_type = 'agent.run.queued'`,
          [runId],
        );
        await client.query('COMMIT');
        return {
          id: cancelled.rows[0].id,
          status: cancelled.rows[0].status,
          ...(cancelled.rows[0].error ? { error: cancelled.rows[0].error } : {}),
        };
      }

      const current = await client.query<{
        id: string;
        status: AgentRunRecord['status'];
        error: string | null;
      }>(
        `SELECT id, status, error FROM agent_runs
         WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`,
        [runId, userId],
      );
      await client.query('COMMIT');
      const run = current.rows[0];
      return run
        ? {
            id: run.id,
            status: run.status,
            ...(run.error ? { error: run.error } : {}),
          }
        : null;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async lockRunOutbox(
    client: PoolClient,
    runId: string,
  ): Promise<void> {
    await client.query(
      `SELECT id FROM task_outbox
       WHERE run_id = $1 AND event_type = 'agent.run.queued'
       FOR UPDATE`,
      [runId],
    );
  }

  async listMessages(
    userId: string,
    sessionId: string,
  ): Promise<MessageRecord[] | null> {
    const session = await this.pool.query(
      'SELECT 1 FROM sessions WHERE id = $1 AND owner_user_id = $2',
      [sessionId, userId],
    );
    if (session.rowCount === 0) return null;

    const result = await this.pool.query<MessageRow>(
      `SELECT id, sequence, role, content, created_at
       FROM messages
       WHERE session_id = $1 AND owner_user_id = $2
       ORDER BY sequence ASC`,
      [sessionId, userId],
    );
    return result.rows.map(toMessageRecord);
  }

  async appendUserMessage(
    userId: string,
    sessionId: string,
    text: string,
  ): Promise<AcceptedMessage | null> {
    const client = await this.pool.connect();
    const runId = randomUUID();
    const messageId = randomUUID();

    try {
      await client.query('BEGIN');
      const session = await client.query<{ next_sequence: number }>(
        `SELECT next_sequence
         FROM sessions
         WHERE id = $1 AND owner_user_id = $2
         FOR UPDATE`,
        [sessionId, userId],
      );
      if (session.rowCount === 0) {
        await client.query('ROLLBACK');
        return null;
      }

      const activeRun = await client.query(
        `SELECT 1 FROM agent_runs
         WHERE session_id = $1 AND owner_user_id = $2
           AND status IN ('queued', 'running')
         LIMIT 1`,
        [sessionId, userId],
      );
      if (activeRun.rows.length > 0) {
        await client.query('ROLLBACK');
        throw new SessionBusyError();
      }

      const sequence = session.rows[0].next_sequence;
      await client.query(
        `UPDATE sessions
         SET next_sequence = next_sequence + 1, updated_at = now()
         WHERE id = $1 AND owner_user_id = $2`,
        [sessionId, userId],
      );
      await client.query(
        `INSERT INTO agent_runs (id, owner_user_id, session_id, status)
         VALUES ($1, $2, $3, 'queued')`,
        [runId, userId, sessionId],
      );
      const message = await client.query<MessageRow>(
        `INSERT INTO messages
           (id, owner_user_id, session_id, run_id, sequence, role, content)
         VALUES ($1, $2, $3, $4, $5, 'user', $6)
         RETURNING id, sequence, role, content, created_at`,
        [messageId, userId, sessionId, runId, sequence, text],
      );
      await client.query(
        `INSERT INTO task_outbox (id, owner_user_id, run_id, event_type, payload)
         VALUES ($1, $2, $3, 'agent.run.queued', $4::jsonb)`,
        [randomUUID(), userId, runId, JSON.stringify({ sessionId, runId })],
      );
      await client.query('COMMIT');

      return {
        message: toMessageRecord(message.rows[0]),
        run: { id: runId, status: 'queued' },
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async claimNextRun(leaseMs: number): Promise<QueuedAgentRun | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query<{ id: string }>(
        `SELECT outbox.run_id AS id
         FROM task_outbox AS outbox
         JOIN agent_runs AS runs ON runs.id = outbox.run_id
         WHERE outbox.event_type = 'agent.run.queued'
           AND outbox.published_at IS NULL
           AND NOT EXISTS (
             SELECT 1
             FROM agent_runs AS earlier
             JOIN messages AS earlier_user
               ON earlier_user.run_id = earlier.id
              AND earlier_user.role = 'user'
             JOIN messages AS curr_user
               ON curr_user.run_id = runs.id
              AND curr_user.role = 'user'
             WHERE earlier.session_id = runs.session_id
               AND earlier.id <> runs.id
               AND earlier.status IN ('queued', 'running')
               AND earlier_user.sequence < curr_user.sequence
           )
           AND (
             runs.status = 'queued'
             OR (
               runs.status = 'running'
               AND outbox.locked_at < now() - ($1::text || ' milliseconds')::interval
             )
           )
         ORDER BY outbox.created_at ASC, outbox.id ASC
         FOR UPDATE OF outbox SKIP LOCKED
         LIMIT 1`,
        [leaseMs],
      );
      if (selected.rowCount === 0) {
        await client.query('COMMIT');
        return null;
      }

      const run = await client.query<{
        id: string;
        owner_user_id: string;
        session_id: string;
      }>(
        `SELECT id, owner_user_id, session_id
         FROM agent_runs
         WHERE id = $1 AND status IN ('queued', 'running')
         FOR UPDATE`,
        [selected.rows[0].id],
      );
      if (run.rowCount === 0) {
        await client.query('COMMIT');
        return null;
      }
      const row = run.rows[0];
      await client.query(
        `UPDATE task_outbox
         SET locked_at = now(), attempts = attempts + 1
         WHERE run_id = $1 AND event_type = 'agent.run.queued'`,
        [row.id],
      );
      await client.query(
        `UPDATE agent_runs SET status = 'running', updated_at = now()
         WHERE id = $1`,
        [row.id],
      );
      await client.query('COMMIT');
      return {
        id: row.id,
        userId: row.owner_user_id,
        sessionId: row.session_id,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getRunMessages(run: QueuedAgentRun): Promise<AgentPromptMessage[]> {
    const result = await this.pool.query<{
      role: 'user' | 'assistant';
      content: string;
    }>(
      `SELECT role, content
       FROM messages
       WHERE owner_user_id = $1
         AND session_id = $2
         AND role IN ('user', 'assistant')
         AND sequence <= (
           SELECT sequence FROM messages
           WHERE run_id = $3 AND owner_user_id = $1 AND session_id = $2
             AND role = 'user'
           LIMIT 1
         )
       ORDER BY sequence ASC`,
      [run.userId, run.sessionId, run.id],
    );
    return result.rows.map((row) => ({ role: row.role, text: row.content }));
  }

  async completeRun(run: QueuedAgentRun, text: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.lockRunOutbox(client, run.id);
      const currentRun = await client.query<{ status: AgentRunRecord['status'] }>(
        `SELECT status FROM agent_runs
         WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`,
        [run.id, run.userId],
      );
      if (currentRun.rows[0]?.status !== 'running') {
        await client.query('COMMIT');
        return;
      }

      const session = await client.query<{ next_sequence: number }>(
        `SELECT next_sequence FROM sessions
         WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`,
        [run.sessionId, run.userId],
      );
      if (session.rowCount === 0) {
        throw new Error('Cannot complete run for a missing session');
      }

      await client.query(
        `INSERT INTO messages
           (id, owner_user_id, session_id, run_id, sequence, role, content)
         VALUES ($1, $2, $3, $4, $5, 'assistant', $6)`,
        [
          randomUUID(),
          run.userId,
          run.sessionId,
          run.id,
          session.rows[0].next_sequence,
          text,
        ],
      );
      await client.query(
        `UPDATE sessions
         SET next_sequence = next_sequence + 1, updated_at = now()
         WHERE id = $1 AND owner_user_id = $2`,
        [run.sessionId, run.userId],
      );
      await client.query(
        `UPDATE agent_runs SET status = 'completed', updated_at = now(), error = NULL
         WHERE id = $1 AND owner_user_id = $2 AND status = 'running'`,
        [run.id, run.userId],
      );
      await client.query(
        `UPDATE task_outbox SET published_at = now()
         WHERE run_id = $1 AND event_type = 'agent.run.queued'`,
        [run.id],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async failRun(run: QueuedAgentRun, error: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.lockRunOutbox(client, run.id);
      await client.query(
        `UPDATE agent_runs
         SET status = 'failed', updated_at = now(), error = $3
         WHERE id = $1 AND owner_user_id = $2 AND status = 'running'`,
        [run.id, run.userId, error.slice(0, 2000)],
      );
      await client.query(
        `UPDATE task_outbox SET published_at = now()
         WHERE run_id = $1 AND event_type = 'agent.run.queued'`,
        [run.id],
      );
      await client.query('COMMIT');
    } catch (failure) {
      await client.query('ROLLBACK');
      throw failure;
    } finally {
      client.release();
    }
  }

  async recordToolCallStarted(event: ToolCallAuditStart): Promise<void> {
    const result = await this.pool.query(
        `INSERT INTO tool_calls
           (request_id, owner_user_id, session_id, run_id, machine_id, tool, status)
         SELECT $1, $2, $3, $4, $5, $6, 'requested'
         WHERE EXISTS (
           SELECT 1 FROM agent_runs
           WHERE id = $4 AND owner_user_id = $2 AND session_id = $3
         )
           AND (
             EXISTS (
               SELECT 1 FROM machines
               WHERE owner_user_id = $2 AND machine_id = $5 AND revoked_at IS NULL
             )
             OR EXISTS (
               SELECT 1 FROM cloud_runtimes
               WHERE owner_user_id = $2 AND pod_id = $5
             )
           )
         RETURNING request_id`,
        [
          event.requestId,
          event.userId,
          event.sessionId,
          event.runId,
          event.machineId,
          event.tool,
        ],
      );
    if (result.rowCount !== 1) {
      throw new Error('Cannot audit a tool call for an unknown run, machine, or runtime');
    }
  }

  async recordToolCallStatus(event: ToolCallAuditStatus): Promise<void> {
    const result = await this.pool.query(
        `UPDATE tool_calls
         SET status = $4, result_code = $5, updated_at = now()
         WHERE request_id = $1 AND owner_user_id = $2 AND run_id = $3`,
        [
          event.requestId,
          event.userId,
          event.runId,
          event.status,
          event.resultCode ?? null,
        ],
      );
    if (result.rowCount !== 1) {
      throw new Error('Cannot update an unknown tool call audit record');
    }
  }
  async listMemories(userId: string): Promise<MemoryRecord[]> {
    const result = await this.pool.query<{
      id: string;
      key: string;
      content: string;
      importance: number;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, key, content, importance, created_at, updated_at
       FROM user_memories
       WHERE owner_user_id = $1
       ORDER BY importance DESC, updated_at DESC`,
      [userId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      key: row.key,
      content: row.content,
      importance: row.importance,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    }));
  }

  async getMemoryByKey(userId: string, key: string): Promise<MemoryRecord | null> {
    const result = await this.pool.query<{
      id: string;
      key: string;
      content: string;
      importance: number;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, key, content, importance, created_at, updated_at
       FROM user_memories
       WHERE owner_user_id = $1 AND key = $2`,
      [userId, key],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      key: row.key,
      content: row.content,
      importance: row.importance,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  async upsertMemory(userId: string, input: MemoryInput): Promise<MemoryRecord> {
    await this.pool.query(
      'INSERT INTO app_users (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
      [userId],
    );
    const importance = Math.max(0, Math.min(100, input.importance ?? 0));
    const result = await this.pool.query<{
      id: string;
      key: string;
      content: string;
      importance: number;
      created_at: Date;
      updated_at: Date;
    }>(
      `INSERT INTO user_memories (id, owner_user_id, key, content, importance)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (owner_user_id, key) DO UPDATE
       SET content = EXCLUDED.content,
           importance = EXCLUDED.importance,
           updated_at = now()
       RETURNING id, key, content, importance, created_at, updated_at`,
      [randomUUID(), userId, input.key.trim(), input.content, importance],
    );
    const row = result.rows[0];
    return {
      id: row.id,
      key: row.key,
      content: row.content,
      importance: row.importance,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  async deleteMemory(userId: string, memoryId: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM user_memories WHERE id = $1 AND owner_user_id = $2`,
      [memoryId, userId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  private toRoutineRecord(row: {
    id: string;
    owner_user_id: string;
    name: string;
    prompt: string;
    session_id: string | null;
    schedule_kind: 'cron' | 'interval' | 'event';
    cron_expr: string | null;
    interval_ms: number | null;
    event_type: string | null;
    enabled: boolean;
    next_run_at: Date | null;
    last_run_at: Date | null;
    last_error: string | null;
    created_at: Date;
    updated_at: Date;
  }): RoutineRecord {
    return {
      id: row.id,
      ownerUserId: row.owner_user_id,
      name: row.name,
      prompt: row.prompt,
      sessionId: row.session_id,
      scheduleKind: row.schedule_kind,
      cronExpr: row.cron_expr,
      intervalMs: row.interval_ms,
      eventType: row.event_type,
      enabled: row.enabled,
      nextRunAt: row.next_run_at?.toISOString() ?? null,
      lastRunAt: row.last_run_at?.toISOString() ?? null,
      lastError: row.last_error,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  async listRoutines(userId: string): Promise<RoutineRecord[]> {
    const result = await this.pool.query(
      `SELECT id, owner_user_id, name, prompt, session_id, schedule_kind, cron_expr,
              interval_ms, event_type, enabled, next_run_at, last_run_at, last_error,
              created_at, updated_at
       FROM routines
       WHERE owner_user_id = $1
       ORDER BY updated_at DESC`,
      [userId],
    );
    return result.rows.map((row) => this.toRoutineRecord(row as never));
  }

  private computeInitialNextRun(input: RoutineInput): Date | null {
    if (input.scheduleKind === 'event') return null;
    const now = new Date();
    if (input.scheduleKind === 'interval') {
      const ms = Math.max(60_000, input.intervalMs ?? 3_600_000);
      return new Date(now.getTime() + ms);
    }
    if (input.scheduleKind === 'cron' && input.cronExpr) {
      return nextCronFire(input.cronExpr, now);
    }
    return new Date(now.getTime() + 3_600_000);
  }

  async createRoutine(userId: string, input: RoutineInput): Promise<RoutineRecord> {
    await this.pool.query(
      'INSERT INTO app_users (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
      [userId],
    );
    this.assertRoutineInput(input);
    const nextRunAt = this.computeInitialNextRun(input);
    const result = await this.pool.query(
      `INSERT INTO routines (
         id, owner_user_id, name, prompt, session_id, schedule_kind,
         cron_expr, interval_ms, event_type, enabled, next_run_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id, owner_user_id, name, prompt, session_id, schedule_kind, cron_expr,
                 interval_ms, event_type, enabled, next_run_at, last_run_at, last_error,
                 created_at, updated_at`,
      [
        randomUUID(),
        userId,
        input.name.trim(),
        input.prompt,
        input.sessionId ?? null,
        input.scheduleKind,
        input.cronExpr ?? null,
        input.intervalMs ?? null,
        input.eventType ?? null,
        input.enabled ?? true,
        nextRunAt,
      ],
    );
    return this.toRoutineRecord(result.rows[0] as never);
  }

  async updateRoutine(
    userId: string,
    routineId: string,
    patch: Partial<RoutineInput>,
  ): Promise<RoutineRecord | null> {
    const existing = await this.pool.query(
      `SELECT id, owner_user_id, name, prompt, session_id, schedule_kind, cron_expr,
              interval_ms, event_type, enabled, next_run_at, last_run_at, last_error,
              created_at, updated_at
       FROM routines WHERE id = $1 AND owner_user_id = $2`,
      [routineId, userId],
    );
    if (existing.rowCount === 0) return null;
    const current = this.toRoutineRecord(existing.rows[0] as never);
    const merged: RoutineInput = {
      name: patch.name ?? current.name,
      prompt: patch.prompt ?? current.prompt,
      sessionId: patch.sessionId !== undefined ? patch.sessionId : current.sessionId,
      scheduleKind: patch.scheduleKind ?? current.scheduleKind,
      cronExpr: patch.cronExpr !== undefined ? patch.cronExpr : current.cronExpr,
      intervalMs: patch.intervalMs !== undefined ? patch.intervalMs : current.intervalMs,
      eventType: patch.eventType !== undefined ? patch.eventType : current.eventType,
      enabled: patch.enabled ?? current.enabled,
    };
    this.assertRoutineInput(merged);
    const scheduleChanged =
      patch.scheduleKind !== undefined ||
      patch.cronExpr !== undefined ||
      patch.intervalMs !== undefined ||
      patch.enabled !== undefined;
    const nextRunAt = scheduleChanged
      ? this.computeInitialNextRun(merged)
      : (current.nextRunAt ? new Date(current.nextRunAt) : null);
    const result = await this.pool.query(
      `UPDATE routines SET
         name = $3, prompt = $4, session_id = $5, schedule_kind = $6,
         cron_expr = $7, interval_ms = $8, event_type = $9, enabled = $10,
         next_run_at = $11, updated_at = now()
       WHERE id = $1 AND owner_user_id = $2
       RETURNING id, owner_user_id, name, prompt, session_id, schedule_kind, cron_expr,
                 interval_ms, event_type, enabled, next_run_at, last_run_at, last_error,
                 created_at, updated_at`,
      [
        routineId,
        userId,
        merged.name.trim(),
        merged.prompt,
        merged.sessionId ?? null,
        merged.scheduleKind,
        merged.cronExpr ?? null,
        merged.intervalMs ?? null,
        merged.eventType ?? null,
        merged.enabled ?? true,
        nextRunAt,
      ],
    );
    return this.toRoutineRecord(result.rows[0] as never);
  }

  async deleteRoutine(userId: string, routineId: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM routines WHERE id = $1 AND owner_user_id = $2`,
      [routineId, userId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async listDueRoutines(
    nowMs: number,
    filter?: { userId?: string; eventType?: string },
  ): Promise<RoutineRecord[]> {
    if (filter?.eventType) {
      const result = await this.pool.query(
        `SELECT id, owner_user_id, name, prompt, session_id, schedule_kind, cron_expr,
                interval_ms, event_type, enabled, next_run_at, last_run_at, last_error,
                created_at, updated_at
         FROM routines
         WHERE enabled = true
           AND schedule_kind = 'event'
           AND event_type = $1
           AND ($2::text IS NULL OR owner_user_id = $2)
         ORDER BY updated_at ASC
         LIMIT 50`,
        [filter.eventType, filter.userId ?? null],
      );
      return result.rows.map((row) => this.toRoutineRecord(row as never));
    }

    const result = await this.pool.query(
      `SELECT id, owner_user_id, name, prompt, session_id, schedule_kind, cron_expr,
              interval_ms, event_type, enabled, next_run_at, last_run_at, last_error,
              created_at, updated_at
       FROM routines
       WHERE enabled = true
         AND schedule_kind IN ('cron', 'interval')
         AND next_run_at IS NOT NULL
         AND next_run_at <= to_timestamp($1::double precision / 1000)
         AND ($2::text IS NULL OR owner_user_id = $2)
       ORDER BY next_run_at ASC
       LIMIT 20`,
      [nowMs, filter?.userId ?? null],
    );
    return result.rows.map((row) => this.toRoutineRecord(row as never));
  }

  async markRoutineFired(routineId: string, update: RoutineFireUpdate): Promise<void> {
    await this.pool.query(
      `UPDATE routines SET
         last_run_at = now(),
         next_run_at = $2,
         last_error = $3,
         session_id = COALESCE($4, session_id),
         updated_at = now()
       WHERE id = $1`,
      [
        routineId,
        update.nextRunAt,
        update.lastError ?? null,
        update.bindSessionId ?? null,
      ],
    );
  }

  private assertRoutineInput(input: RoutineInput): void {
    if (!input.name?.trim()) throw new Error('Routine name is required');
    if (!input.prompt?.trim()) throw new Error('Routine prompt is required');
    if (input.scheduleKind === 'cron') {
      if (!input.cronExpr?.trim()) throw new Error('cronExpr is required for cron routines');
      if (!nextCronFire(input.cronExpr, new Date())) {
        throw new Error('cronExpr is invalid or has no upcoming fire time');
      }
    }
    if (input.scheduleKind === 'interval') {
      if (!input.intervalMs || input.intervalMs < 60_000) {
        throw new Error('intervalMs must be >= 60000');
      }
    }
    if (input.scheduleKind === 'event') {
      if (!input.eventType?.trim()) throw new Error('eventType is required for event routines');
    }
  }

}
