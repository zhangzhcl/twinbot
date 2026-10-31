import type { MachineCapability } from '@lca/ws-protocol';

export interface ModelConfigProfile {
  id: string;
  name: string;
  provider: string;
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  createdAt: string;
  updatedAt: string;
}

/** 桌面端 UI 直连通道允许的只读工具（与控制面白名单一致，双重防线） */
export const UI_ALLOWED_CLOUD_TOOLS = new Set([
  'fs.read',
  'fs.list',
  'fs.glob',
  'fs.grep',
  'notebook.read',
  'lsp.query',
  'browser.use',
  'shell.exec',
]);

export interface ToolCallResult {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

export interface SessionRecord {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface MachineRecord {
  machineId: string;
  label?: string;
  capabilities: MachineCapability[];
}

export interface MachineList {
  machines: MachineRecord[];
  selectedMachineId: string | null;
}

export interface MessageRecord {
  id: string;
  sequence: number;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  createdAt: string;
}

export interface AcceptedMessage {
  message: MessageRecord;
  run: {
    id: string;
    status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
    error?: string;
  };
}

export interface RunRecord {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  error?: string;
}

export interface ModelConfigRecord {
  provider: string;
  apiBaseUrl: string;
  apiKey: string;
  apiKeyMasked?: boolean;
  hasApiKey?: boolean;
  model: string;
  isConfigured?: boolean;
}

export interface ControlApiClientOptions {
  baseUrl: string;
  token: string;
}

export class ControlApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`Control API request failed (${status}): ${code}`);
    this.name = 'ControlApiError';
  }
}

export class ControlApiClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(options: ControlApiClientOptions) {
    const url = new URL(options.baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Control API URL must use HTTP or HTTPS');
    }
    const isLoopback =
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '[::1]';
    if (url.protocol !== 'https:' && !isLoopback) {
      throw new Error('Control API must use HTTPS outside loopback');
    }
    if (url.username || url.password) {
      throw new Error('Control API URL must not contain credentials');
    }
    if (!options.token.trim()) {
      throw new Error('Control API token is required');
    }
    this.baseUrl = url.toString().replace(/\/+$/, '');
    this.token = options.token;
  }

  async listSessions(): Promise<SessionRecord[]> {
    const response = await this.request<{ sessions: SessionRecord[] }>('/v1/sessions');
    return response.sessions;
  }

  async listMachines(): Promise<MachineList> {
    return this.request<MachineList>('/v1/machines');
  }

  async listRuntimes(): Promise<{
    runtimes: Array<{ podId: string; capabilities: string[] }>;
    selectedRuntimeId: string | null;
  }> {
    return this.request<{
      runtimes: Array<{ podId: string; capabilities: string[] }>;
      selectedRuntimeId: string | null;
    }>('/v1/runtimes');
  }

  async selectRuntime(
    podId: string | null,
  ): Promise<{ selectedRuntimeId: string | null }> {
    return this.request<{ selectedRuntimeId: string | null }>(
      '/v1/runtimes/selection',
      {
        method: 'POST',
        body: JSON.stringify({ podId }),
      },
    );
  }

  async selectMachine(
    machineId: string | null,
  ): Promise<{ selectedMachineId: string | null }> {
    return this.request<{ selectedMachineId: string | null }>(
      '/v1/machines/selection',
      {
        method: 'POST',
        body: JSON.stringify({ machineId }),
      },
    );
  }

  async createSession(title = 'New conversation'): Promise<SessionRecord> {
    return this.request<SessionRecord>('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ title }),
    });
  }

  async updateSessionTitle(sessionId: string, title: string): Promise<SessionRecord> {
    return this.request<SessionRecord>(`/v1/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.request<void>(`/v1/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    });
  }

  async listModelProfiles(): Promise<{ profiles: ModelConfigProfile[] }> {
    return this.request<{ profiles: ModelConfigProfile[] }>('/v1/models/configs');
  }

  async saveModelProfile(profile: {
    name: string;
    provider: string;
    apiBaseUrl: string;
    apiKey: string;
    model: string;
  }): Promise<ModelConfigProfile> {
    return this.request<ModelConfigProfile>('/v1/models/configs', {
      method: 'POST',
      body: JSON.stringify(profile),
    });
  }

  async deleteModelProfile(profileId: string): Promise<void> {
    await this.request<void>(`/v1/models/configs/${encodeURIComponent(profileId)}`, {
      method: 'DELETE',
    });
  }

  async activateModelProfile(profileId: string): Promise<{
    status: string;
    profile: ModelConfigProfile;
  }> {
    return this.request<{ status: string; profile: ModelConfigProfile }>(
      `/v1/models/configs/${encodeURIComponent(profileId)}/activate`,
      { method: 'POST' },
    );
  }

  /** 打开产物：为当前会话生成公网预览路由令牌，返回可在浏览器直接访问的 URL */
  async openPreviewRoute(sessionId: string): Promise<{ url: string; port: number }> {
    return this.request<{ url: string; port: number }>('/v1/preview/open', {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    });
  }

  /** UI 直连的只读工具调用（工具名需在 UI_ALLOWED_CLOUD_TOOLS 白名单内） */
  async executeCloudTool(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<ToolCallResult> {
    return this.request<ToolCallResult>('/v1/tools/execute', {
      method: 'POST',
      body: JSON.stringify({ tool, args }),
    });
  }

  async getModelConfig(): Promise<ModelConfigRecord> {
    return this.request<ModelConfigRecord>('/v1/models/config');
  }

  async saveModelConfig(config: {
    provider: string;
    apiBaseUrl: string;
    apiKey: string;
    model: string;
  }): Promise<{ status: string; provider: string; model: string }> {
    return this.request<{ status: string; provider: string; model: string }>('/v1/models/config', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  }

  async listMessages(sessionId: string): Promise<MessageRecord[]> {
    const response = await this.request<{ messages: MessageRecord[] }>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
    );
    return response.messages;
  }

  async sendMessage(sessionId: string, text: string): Promise<AcceptedMessage> {
    return this.request<AcceptedMessage>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
      { method: 'POST', body: JSON.stringify({ text }) },
    );
  }

  async getRun(runId: string): Promise<RunRecord> {
    return this.request<RunRecord>(`/v1/runs/${encodeURIComponent(runId)}`);
  }

  async cancelRun(runId: string): Promise<RunRecord> {
    return this.request<RunRecord>(
      `/v1/runs/${encodeURIComponent(runId)}/cancel`,
      { method: 'POST' },
    );
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${this.token}`);
    if (init.body !== undefined) headers.set('content-type', 'application/json');

    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers,
    });
    if (!response.ok) {
      const body: unknown = await response.json();
      const code = typeof body === 'object' && body !== null && 'error' in body &&
        typeof body.error === 'string'
        ? body.error
        : 'UNKNOWN_API_ERROR';
      throw new ControlApiError(response.status, code);
    }
    // 204 无响应体：删除会话等操作仅关心成功状态
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }
}
