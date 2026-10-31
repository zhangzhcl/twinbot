import type {
  CloudRuntimeCapability,
  MachineCapability,
} from '@lca/ws-protocol';
import type { ToolName } from '@lca/tool-protocol';

export interface SessionRecord {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface MessageRecord {
  id: string;
  sequence: number;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  createdAt: string;
}

export interface AgentRunRecord {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  error?: string;
}

export interface AcceptedMessage {
  message: MessageRecord;
  run: AgentRunRecord;
}

export interface QueuedAgentRun {
  id: string;
  userId: string;
  sessionId: string;
}

export interface AgentPromptMessage {
  role: 'user' | 'assistant';
  text: string;
}

export type ToolCallStatus =
  | 'requested'
  | 'approved'
  | 'denied'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'cancelled';

export interface ToolCallAuditStart {
  requestId: string;
  userId: string;
  sessionId: string;
  runId: string;
  machineId: string;
  tool: ToolName;
}

export interface ToolCallAuditStatus {
  requestId: string;
  userId: string;
  runId: string;
  status: Exclude<ToolCallStatus, 'requested'>;
  resultCode?: string;
}

export interface UserModelConfig {
  provider: string;
  apiBaseUrl: string;
  apiKey: string;
  model: string;
}

/** 一套可复用的模型配置档案（多套保存，启用一套供云端 Agent 使用） */
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

export interface ModelProfileInput {
  name: string;
  provider: string;
  apiBaseUrl: string;
  apiKey: string;
  model: string;
}

/** 桌面端 UI 直连工具调用的审计事件 */
export interface UiToolCallAuditStart {
  requestId: string;
  userId: string;
  tool: ToolName;
}

export interface UiToolCallAuditStatus {
  requestId: string;
  userId: string;
  status: 'completed' | 'failed' | 'timed_out' | 'cancelled';
  resultCode?: string;
}


export interface MemoryRecord {
  id: string;
  key: string;
  content: string;
  importance: number;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryInput {
  key: string;
  content: string;
  importance?: number;
}

export type RoutineScheduleKind = 'cron' | 'interval' | 'event';

export interface RoutineRecord {
  id: string;
  ownerUserId: string;
  name: string;
  prompt: string;
  sessionId: string | null;
  scheduleKind: RoutineScheduleKind;
  cronExpr: string | null;
  intervalMs: number | null;
  eventType: string | null;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RoutineInput {
  name: string;
  prompt: string;
  sessionId?: string | null;
  scheduleKind: RoutineScheduleKind;
  cronExpr?: string | null;
  intervalMs?: number | null;
  eventType?: string | null;
  enabled?: boolean;
}

export interface RoutineFireUpdate {
  nextRunAt: string | null;
  lastError?: string | null;
  bindSessionId?: string;
}

export class SessionBusyError extends Error {
  constructor() {
    super('A run is already active for this session');
  }
}

export interface ConversationStore {
  registerMachine(
    userId: string,
    machineId: string,
    label: string | undefined,
    capabilities: MachineCapability[],
  ): Promise<void>;
  registerRuntime(
    userId: string,
    podId: string,
    capabilities: CloudRuntimeCapability[],
  ): Promise<void>;
  touchRuntime(userId: string, podId: string): Promise<void>;
  setSelectedMachineId(userId: string, machineId: string | null): Promise<void>;
  getSelectedMachineId(userId: string): Promise<string | null>;
  createSession(userId: string, title: string): Promise<SessionRecord>;
  updateSessionTitle(
    userId: string,
    sessionId: string,
    title: string,
  ): Promise<SessionRecord | null>;
  /**
   * 删除会话并级联清理其消息、运行与工具审计记录（外键 ON DELETE CASCADE）。
   * 会话存在排队/运行中任务时抛出 SessionBusyError；会话不存在或不属于该用户返回 false。
   */
  deleteSession(userId: string, sessionId: string): Promise<boolean>;
  setUserModelConfig?(
    userId: string,
    config: UserModelConfig,
  ): Promise<void>;
  getUserModelConfig?(
    userId: string,
  ): Promise<UserModelConfig | null>;
  /** 列出当前用户保存的全部模型配置档案（按更新时间倒序） */
  listModelProfiles(userId: string): Promise<ModelConfigProfile[]>;
  /** 按名称新增或更新一套配置档案 */
  saveModelProfile(
    userId: string,
    profile: ModelProfileInput,
  ): Promise<ModelConfigProfile>;
  /** 删除一套配置档案；不存在或不属于该用户返回 false */
  deleteModelProfile(userId: string, profileId: string): Promise<boolean>;
  /** 启用一套档案：将其值写入当前生效配置（user_model_configs），云端 Agent 下一次运行即生效 */
  activateModelProfile(
    userId: string,
    profileId: string,
  ): Promise<ModelConfigProfile | null>;
  /** 记录 UI 直连工具调用的开始 */
  recordUiToolCallStarted(event: UiToolCallAuditStart): Promise<void>;
  /** 记录 UI 直连工具调用的终态 */
  recordUiToolCallStatus(event: UiToolCallAuditStatus): Promise<void>;
  listSessions(userId: string): Promise<SessionRecord[]>;
  listMessages(
    userId: string,
    sessionId: string,
  ): Promise<MessageRecord[] | null>;
  appendUserMessage(
    userId: string,
    sessionId: string,
    text: string,
  ): Promise<AcceptedMessage | null>;
  getRun(userId: string, runId: string): Promise<AgentRunRecord | null>;
  cancelRun(userId: string, runId: string): Promise<AgentRunRecord | null>;
  claimNextRun(leaseMs: number): Promise<QueuedAgentRun | null>;
  getRunMessages(run: QueuedAgentRun): Promise<AgentPromptMessage[]>;
  completeRun(run: QueuedAgentRun, text: string): Promise<void>;
  failRun(run: QueuedAgentRun, error: string): Promise<void>;
  recordToolCallStarted(event: ToolCallAuditStart): Promise<void>;
  recordToolCallStatus(event: ToolCallAuditStatus): Promise<void>;

  setSelectedRuntimeId(userId: string, podId: string | null): Promise<void>;
  getSelectedRuntimeId(userId: string): Promise<string | null>;
  listMemories(userId: string): Promise<MemoryRecord[]>;
  upsertMemory(userId: string, input: MemoryInput): Promise<MemoryRecord>;
  deleteMemory(userId: string, memoryId: string): Promise<boolean>;
  getMemoryByKey(userId: string, key: string): Promise<MemoryRecord | null>;
  listRoutines(userId: string): Promise<RoutineRecord[]>;
  createRoutine(userId: string, input: RoutineInput): Promise<RoutineRecord>;
  updateRoutine(userId: string, routineId: string, patch: Partial<RoutineInput>): Promise<RoutineRecord | null>;
  deleteRoutine(userId: string, routineId: string): Promise<boolean>;
  listDueRoutines(
    nowMs: number,
    filter?: { userId?: string; eventType?: string },
  ): Promise<RoutineRecord[]>;
  markRoutineFired(routineId: string, update: RoutineFireUpdate): Promise<void>;

}
