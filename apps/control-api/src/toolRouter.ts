import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type {
  BrowserUseArgs,
  BrowserUseResult,
  CodeRunArgs,
  CodeRunResult,
  FilesCopyArgs,
  FilesCopyResult,
  FsEditArgs,
  FsEditResult,
  FsGlobArgs,
  FsGlobResult,
  FsGrepArgs,
  FsGrepResult,
  FsListArgs,
  FsListResult,
  FsReadArgs,
  FsReadResult,
  FsWriteArgs,
  FsWriteResult,
  LspQueryArgs,
  LspQueryResult,
  NotebookEditArgs,
  NotebookEditResult,
  NotebookReadArgs,
  NotebookReadResult,
  ToolName,
  ToolResult,
  UserAskArgs,
  UserAskResult,
  VcsCheckpointArgs,
  VcsCheckpointResult,
  WebFetchArgs,
  WebFetchResult,
  WebSearchArgs,
  WebSearchResult,
} from '@lca/tool-protocol';
import {
  errResult,
  ToolArgsSchemasByName,
  ToolResultSchemasByName,
} from '@lca/tool-protocol';
import type {
  CloudRuntimeCapability,
  MachineCapability,
  PreviewHttpRequestMessage,
  PreviewHttpResponseMessage,
  ToolApprovalMessage,
  ToolResultMessage,
  ToolRequestMessage,
} from '@lca/ws-protocol';
import type {
  ToolCallAuditStart,
  ToolCallAuditStatus,
} from './conversationStore';

export type {
  BrowserUseArgs,
  BrowserUseResult,
  CodeRunArgs,
  CodeRunResult,
  FilesCopyArgs,
  FilesCopyResult,
  FsEditArgs,
  FsEditResult,
  FsGlobArgs,
  FsGlobResult,
  FsGrepArgs,
  FsGrepResult,
  FsListArgs,
  FsListResult,
  FsReadArgs,
  FsReadResult,
  FsWriteArgs,
  FsWriteResult,
  LspQueryArgs,
  LspQueryResult,
  NotebookEditArgs,
  NotebookEditResult,
  NotebookReadArgs,
  NotebookReadResult,
  UserAskArgs,
  UserAskResult,
  VcsCheckpointArgs,
  VcsCheckpointResult,
  WebFetchArgs,
  WebFetchResult,
  WebSearchArgs,
  WebSearchResult,
};

interface ToolClientSocket {
  readyState: number;
  send(data: string): void;
}

interface ToolCallAuditStore {
  recordToolCallStarted(event: ToolCallAuditStart): Promise<void>;
  recordToolCallStatus(event: ToolCallAuditStatus): Promise<void>;
}

interface ToolCallContext {
  runId: string;
  sessionId: string;
}

interface RegisteredMachine {
  userId: string;
  machineId: string;
  label?: string;
  capabilities: MachineCapability[];
  socket: ToolClientSocket;
}

interface RegisteredRuntime {
  userId: string;
  podId: string;
  capabilities: CloudRuntimeCapability[];
  socket: ToolClientSocket;
}

export interface ConnectedMachine {
  machineId: string;
  label?: string;
  capabilities: MachineCapability[];
}

export interface ConnectedRuntime {
  podId: string;
  capabilities: CloudRuntimeCapability[];
}

/** 本地工具 → 桌面端能力映射；不在表内的工具不能路由到本地执行面 */
export const LOCAL_TOOL_CAPABILITY: Partial<Record<ToolName, MachineCapability>> = {
  'fs.read': 'fs',
  'fs.list': 'fs',
  'fs.write': 'fs',
  'fs.edit': 'fs',
  'fs.glob': 'fs',
  'fs.grep': 'fs',
  'shell.exec': 'shell',
  'user.ask': 'ask',
  'notebook.read': 'fs',
  'notebook.edit': 'fs',
};

/** 云端工具 → Pod 能力映射；不在表内的工具不能路由到云端执行面 */
export const CLOUD_TOOL_CAPABILITY: Partial<Record<ToolName, CloudRuntimeCapability>> = {
  'fs.read': 'fs',
  'fs.list': 'fs',
  'fs.write': 'fs',
  'fs.edit': 'fs',
  'fs.glob': 'fs',
  'fs.grep': 'fs',
  'shell.exec': 'shell',
  'code.run': 'code',
  'web.fetch': 'web',
  'web.search': 'web',
  'browser.use': 'browser',
  'notebook.read': 'fs',
  'notebook.edit': 'fs',
  'lsp.query': 'lsp',
  'vcs.checkpoint': 'vcs',
};

/** fs.read / fs.list 回包必须原样回显请求路径，防止执行端越权读别的路径 */
const PATH_ECHO_TOOLS = new Set<ToolName>(['fs.read', 'fs.list']);

function timeoutMessage(tool: ToolName, plane: 'local' | 'cloud'): string {
  return `${plane === 'local' ? 'Local' : 'Cloud'} ${tool} request timed out`;
}

function cancelMessage(tool: ToolName, plane: 'local' | 'cloud'): string {
  return `${plane === 'local' ? 'Local' : 'Cloud'} ${tool} request was cancelled`;
}

const PREVIEW_RELAY_TIMEOUT_MS = 20_000;

/** 构造一条错误形态的预览响应（网关侧直接回复，无需到 Pod 折返） */
function previewErrorResponse(requestId: string, status: number, message: string): PreviewHttpResponseMessage {
  return {
    type: 'preview.response',
    requestId,
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    bodyBase64: Buffer.from(message, 'utf8').toString('base64'),
  };
}

function sendPreviewResponse(
  socket: ToolClientSocket,
  message: PreviewHttpResponseMessage,
): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

interface PendingToolRequest {
  socket: ToolClientSocket;
  userId: string;
  runId: string;
  approvalId: string;
  approvalState: 'pending' | 'approved';
  tool: ToolName;
  requestedPath?: string;
  auditQueue: Promise<void>;
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: ToolResult<unknown>) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  /** UI 直连调用：终态不再写 tool_calls 审计 */
  auditDisabled?: boolean;
}

export interface LocalToolRequestOptions {
  /** 默认本地工具一律需审批；user.ask 的对话框本身就是交互，无需重复审批 */
  requiresApproval?: boolean;
}

export interface CloudToolRequestOptions {
  /** 跳过 tool_calls 审计（UI 直连通道使用，审计走独立的 ui_tool_calls 表） */
  skipAudit?: boolean;
}

export class LocalToolRouter {
  private readonly machines = new Map<string, RegisteredMachine>();
  private readonly socketMachines = new WeakMap<ToolClientSocket, RegisteredMachine>();
  private readonly runtimes = new Map<string, RegisteredRuntime>();
  private readonly socketRuntimes = new WeakMap<ToolClientSocket, RegisteredRuntime>();
  private readonly pending = new Map<string, PendingToolRequest>();
  private readonly selectedMachines = new Map<string, string>();
  private readonly selectedRuntimes = new Map<string, string>();
  /** Desktop/user sockets that should receive session.delta (machine connections). */
  private readonly userDeltaSockets = new Map<string, Set<ToolClientSocket>>();
  private readonly pendingPreviews = new Map<string, {
    desktopSocket: ToolClientSocket;
    runtimeSocket: ToolClientSocket;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private readonly pendingHttpPreviews = new Map<string, {
    resolve: (message: PreviewHttpResponseMessage) => void;
    runtimeSocket: ToolClientSocket;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(private readonly auditStore: ToolCallAuditStore) {}

  get pendingRequestCount(): number {
    return this.pending.size;
  }

  registerMachine(
    userId: string,
    machineId: string,
    capabilities: MachineCapability[],
    socket: ToolClientSocket,
    label?: string,
  ): void {
    const machine: RegisteredMachine = {
      userId,
      machineId,
      label,
      capabilities,
      socket,
    };
    this.machines.set(this.machineKey(userId, machineId), machine);
    this.socketMachines.set(socket, machine);
    this.trackUserDeltaSocket(userId, socket);
  }

  registerRuntime(
    userId: string,
    podId: string,
    capabilities: CloudRuntimeCapability[],
    socket: ToolClientSocket,
  ): void {
    const runtime: RegisteredRuntime = {
      userId,
      podId,
      capabilities,
      socket,
    };
    this.runtimes.set(this.runtimeKey(userId, podId), runtime);
    this.socketRuntimes.set(socket, runtime);
  }

  listConnectedMachines(userId: string): ConnectedMachine[] {
    return [...this.machines.values()]
      .filter(
        (machine) =>
          machine.userId === userId &&
          machine.socket.readyState === WebSocket.OPEN,
      )
      .map(({ machineId, label, capabilities }) => ({
        machineId,
        ...(label ? { label } : {}),
        capabilities: [...capabilities],
      }))
      .sort((left, right) => left.machineId.localeCompare(right.machineId));
  }

  listConnectedRuntimes(userId: string): ConnectedRuntime[] {
    return [...this.runtimes.values()]
      .filter(
        (runtime) =>
          runtime.userId === userId &&
          runtime.socket.readyState === WebSocket.OPEN,
      )
      .map(({ podId, capabilities }) => ({
        podId,
        capabilities: [...capabilities],
      }))
      .sort((left, right) => left.podId.localeCompare(right.podId));
  }

  getSelectedMachineId(userId: string): string | null {
    return this.selectedMachines.get(userId) ?? null;
  }

  restoreMachineSelection(userId: string, machineId: string | null): void {
    if (machineId === null) {
      this.selectedMachines.delete(userId);
      return;
    }
    this.selectedMachines.set(userId, machineId);
  }

  selectMachine(userId: string, machineId: string | null): boolean {
    if (machineId === null) {
      this.selectedMachines.delete(userId);
      return true;
    }

    const machine = this.machines.get(this.machineKey(userId, machineId));
    if (
      !machine ||
      machine.socket.readyState !== WebSocket.OPEN ||
      !machine.capabilities.includes('fs')
    ) {
      return false;
    }
    this.selectedMachines.set(userId, machineId);
    return true;
  }

  getSelectedRuntimeId(userId: string): string | null {
    return this.selectedRuntimes.get(userId) ?? null;
  }

  restoreRuntimeSelection(userId: string, podId: string | null): void {
    if (podId === null) {
      this.selectedRuntimes.delete(userId);
      return;
    }
    this.selectedRuntimes.set(userId, podId);
  }

  selectRuntime(userId: string, podId: string | null): boolean {
    if (podId === null) {
      this.selectedRuntimes.delete(userId);
      return true;
    }
    const runtime = this.runtimes.get(this.runtimeKey(userId, podId));
    if (!runtime || runtime.socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    this.selectedRuntimes.set(userId, podId);
    return true;
  }

  /** Push session.delta to all open desktop sockets for this user. */
  publishSessionDelta(
    userId: string,
    sessionId: string,
    delta: unknown,
  ): void {
    const sockets = this.userDeltaSockets.get(userId);
    if (!sockets || sockets.size === 0) return;
    const message = JSON.stringify({
      type: 'session.delta',
      sessionId,
      delta,
    });
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(message);
        } catch (error) {
          console.warn(
            '[tool-router] session.delta send failed:',
            error instanceof Error ? error.message : 'unknown error',
          );
        }
      }
    }
  }

  private trackUserDeltaSocket(userId: string, socket: ToolClientSocket): void {
    let set = this.userDeltaSockets.get(userId);
    if (!set) {
      set = new Set();
      this.userDeltaSockets.set(userId, set);
    }
    set.add(socket);
  }

  private untrackUserDeltaSocket(userId: string, socket: ToolClientSocket): void {
    const set = this.userDeltaSockets.get(userId);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) this.userDeltaSockets.delete(userId);
  }

  unregisterMachine(socket: ToolClientSocket): void {
    const machine = this.socketMachines.get(socket);
    if (!machine) return;
    this.socketMachines.delete(socket);
    const key = this.machineKey(machine.userId, machine.machineId);
    if (this.machines.get(key) === machine) this.machines.delete(key);

    // 桌面断线：丢弃其挂起的预览请求（对端已不可达，无需回包）
    for (const [requestId, pending] of this.pendingPreviews) {
      if (pending.desktopSocket === socket) {
        clearTimeout(pending.timer);
        this.pendingPreviews.delete(requestId);
      }
    }

    for (const [requestId, request] of this.pending) {
      if (request.socket === socket) {
        void this.finish(
          requestId,
          request,
          errResult('MACHINE_OFFLINE', 'The target local machine disconnected'),
          'failed',
          'MACHINE_OFFLINE',
        );
      }
    }
  }

  unregisterRuntime(socket: ToolClientSocket): void {
    const runtime = this.socketRuntimes.get(socket);
    if (!runtime) return;
    this.socketRuntimes.delete(socket);
    const key = this.runtimeKey(runtime.userId, runtime.podId);
    if (this.runtimes.get(key) === runtime) this.runtimes.delete(key);

    for (const [requestId, request] of this.pending) {
      if (request.socket === socket) {
        void this.finish(
          requestId,
          request,
          errResult('RUNTIME_OFFLINE', 'The target cloud runtime disconnected'),
          'failed',
          'RUNTIME_OFFLINE',
        );
      }
    }

    // 该 Runtime 断线时，挂起中的预览请求向桌面端回 502
    for (const [requestId, pending] of this.pendingPreviews) {
      if (pending.runtimeSocket === socket) {
        clearTimeout(pending.timer);
        this.pendingPreviews.delete(requestId);
        sendPreviewResponse(pending.desktopSocket, {
          type: 'preview.response',
          requestId,
          status: 502,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
          bodyBase64: Buffer.from('Preview runtime disconnected', 'utf8').toString('base64'),
        });
      }
    }

    // HTTP 路由模式挂起的预览请求同样回 502
    for (const [requestId, awaited] of this.pendingHttpPreviews) {
      if (awaited.runtimeSocket === socket) {
        clearTimeout(awaited.timer);
        this.pendingHttpPreviews.delete(requestId);
        awaited.resolve(previewErrorResponse(requestId, 502, 'Preview runtime disconnected'));
      }
    }
  }

  /**
   * 产物预览中继：把桌面本地代理的 HTTP 请求转发给该用户的在线 Runtime，
   * 响应经 handlePreviewResponse 原路回传。无在线 Runtime 时直接回 503。
   */
  relayPreviewRequest(
    userId: string,
    request: PreviewHttpRequestMessage,
    desktopSocket: ToolClientSocket,
  ): void {
    const failFast = (status: number, message: string): void => {
      sendPreviewResponse(desktopSocket, {
        type: 'preview.response',
        requestId: request.requestId,
        status,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        bodyBase64: Buffer.from(message, 'utf8').toString('base64'),
      });
    };

    const eligible = [...this.runtimes.values()].filter(
      (runtime) =>
        runtime.userId === userId &&
        runtime.socket.readyState === WebSocket.OPEN,
    );
    if (eligible.length === 0) {
      failFast(503, 'No cloud runtime is online for this user');
      return;
    }

    const runtime = eligible[0];
    if (this.pendingPreviews.has(request.requestId)) {
      failFast(409, 'Duplicate preview requestId');
      return;
    }
    const timer = setTimeout(() => {
      if (this.pendingPreviews.delete(request.requestId)) {
        failFast(504, 'Preview relay timed out');
      }
    }, PREVIEW_RELAY_TIMEOUT_MS);
    this.pendingPreviews.set(request.requestId, {
      desktopSocket,
      runtimeSocket: runtime.socket,
      timer,
    });
    runtime.socket.send(JSON.stringify(request));
  }

  /** Runtime 回传预览响应：分发给桌面连接（推送模式）或等待中的 HTTP 路由（Promise 模式） */
  handlePreviewResponse(
    runtimeSocket: ToolClientSocket,
    message: PreviewHttpResponseMessage,
  ): boolean {
    const pushed = this.pendingPreviews.get(message.requestId);
    if (pushed) {
      if (pushed.runtimeSocket !== runtimeSocket) return false;
      clearTimeout(pushed.timer);
      this.pendingPreviews.delete(message.requestId);
      sendPreviewResponse(pushed.desktopSocket, message);
      return true;
    }
    const awaited = this.pendingHttpPreviews.get(message.requestId);
    if (awaited) {
      if (awaited.runtimeSocket !== runtimeSocket) return false;
      clearTimeout(awaited.timer);
      this.pendingHttpPreviews.delete(message.requestId);
      awaited.resolve(message);
      return true;
    }
    return false;
  }

  /**
   * Promise 版预览中继：供控制面公网 HTTP 路由 /p/<token> 使用。
   * 浏览器请求控制面 → 这里经 Runtime WSS 访问 Pod loopback → 响应回给浏览器。
   */
  async previewFetch(
    userId: string,
    request: Omit<PreviewHttpRequestMessage, 'type'>,
  ): Promise<PreviewHttpResponseMessage> {
    const eligible = [...this.runtimes.values()].filter(
      (runtime) =>
        runtime.userId === userId &&
        runtime.socket.readyState === WebSocket.OPEN,
    );
    if (eligible.length === 0) {
      return previewErrorResponse(request.requestId, 503, 'No cloud runtime is online for this user');
    }
    if (this.pendingHttpPreviews.has(request.requestId)) {
      return previewErrorResponse(request.requestId, 409, 'Duplicate preview requestId');
    }

    const runtime = eligible[0];
    const promise = new Promise<PreviewHttpResponseMessage>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingHttpPreviews.delete(request.requestId)) {
          resolve(previewErrorResponse(request.requestId, 504, 'Preview relay timed out'));
        }
      }, PREVIEW_RELAY_TIMEOUT_MS);
      this.pendingHttpPreviews.set(request.requestId, { resolve, timer, runtimeSocket: runtime.socket });
    });
    runtime.socket.send(JSON.stringify({ type: 'preview.request', ...request }));
    return promise;
  }

  /** 泛化的本地工具请求：按工具能力筛选在线桌面端，路径回显类工具校验回包 */
  async requestLocalTool(
    userId: string,
    tool: ToolName,
    args: unknown,
    timeoutMs: number,
    context: ToolCallContext,
    signal?: AbortSignal,
    options?: LocalToolRequestOptions,
  ): Promise<ToolResult<unknown>> {
    return this.routeToolRequest({
      userId,
      tool,
      args,
      timeoutMs,
      context,
      signal,
      plane: 'local',
      requiresApproval: options?.requiresApproval ?? tool !== 'user.ask',
    });
  }

  /** 泛化的云端工具请求：按工具能力筛选在线 Pod，云端执行面免审批（沙箱边界即信任边界） */
  async requestCloudTool(
    userId: string,
    tool: ToolName,
    args: unknown,
    timeoutMs: number,
    context: ToolCallContext,
    signal?: AbortSignal,
    options?: CloudToolRequestOptions,
  ): Promise<ToolResult<unknown>> {
    return this.routeToolRequest({
      userId,
      tool,
      args,
      timeoutMs,
      context,
      signal,
      plane: 'cloud',
      requiresApproval: false,
      skipAudit: options?.skipAudit,
    });
  }

  /** 兼容封装：本地 fs.read（原 requestFsRead） */
  async requestFsRead(
    userId: string,
    args: FsReadArgs,
    timeoutMs: number,
    context: ToolCallContext,
    signal?: AbortSignal,
  ): Promise<ToolResult<FsReadResult>> {
    const result = await this.requestLocalTool(userId, 'fs.read', args, timeoutMs, context, signal);
    return result.ok ? { ok: true, data: result.data as FsReadResult } : result;
  }

  /** 兼容封装：本地 fs.list（原 requestFsList） */
  async requestFsList(
    userId: string,
    args: FsListArgs,
    timeoutMs: number,
    context: ToolCallContext,
    signal?: AbortSignal,
  ): Promise<ToolResult<FsListResult>> {
    const result = await this.requestLocalTool(userId, 'fs.list', args, timeoutMs, context, signal);
    return result.ok ? { ok: true, data: result.data as FsListResult } : result;
  }

  /** 兼容封装：云端 fs.read（原 requestCloudFsRead） */
  async requestCloudFsRead(
    userId: string,
    args: FsReadArgs,
    timeoutMs: number,
    context: ToolCallContext,
    signal?: AbortSignal,
  ): Promise<ToolResult<FsReadResult>> {
    const result = await this.requestCloudTool(userId, 'fs.read', args, timeoutMs, context, signal);
    return result.ok ? { ok: true, data: result.data as FsReadResult } : result;
  }

  /** 兼容封装：云端 fs.list（原 requestCloudFsList） */
  async requestCloudFsList(
    userId: string,
    args: FsListArgs,
    timeoutMs: number,
    context: ToolCallContext,
    signal?: AbortSignal,
  ): Promise<ToolResult<FsListResult>> {
    const result = await this.requestCloudTool(userId, 'fs.list', args, timeoutMs, context, signal);
    return result.ok ? { ok: true, data: result.data as FsListResult } : result;
  }

  /**
   * files.copy 复合编排：源端 fs.read(base64) → 目标端 fs.write。
   * 不写独立的复合审计行（审计库要求 machineId 真实存在），
   * 两次子调用各自产生带真实目标 machineId/podId 的完整审计记录。
   */
  async requestFilesCopy(
    userId: string,
    args: FilesCopyArgs,
    timeoutMs: number,
    context: ToolCallContext,
    signal?: AbortSignal,
  ): Promise<ToolResult<FilesCopyResult>> {
    if (signal?.aborted) {
      return errResult('ABORTED', 'files.copy request was cancelled');
    }

    const readResult =
      args.direction === 'local-to-cloud'
        ? await this.requestLocalTool(
            userId,
            'fs.read',
            { path: args.source, encoding: 'base64' } satisfies FsReadArgs,
            timeoutMs,
            context,
            signal,
          )
        : await this.requestCloudTool(
            userId,
            'fs.read',
            { path: args.source, encoding: 'base64' } satisfies FsReadArgs,
            timeoutMs,
            context,
            signal,
          );
    if (!readResult.ok) {
      return errResult(
        readResult.error.code,
        `Copy source read failed: ${readResult.error.message}`,
      );
    }
    const source = readResult.data as FsReadResult;

    const writeResult =
      args.direction === 'local-to-cloud'
        ? await this.requestCloudTool(
            userId,
            'fs.write',
            {
              path: args.destination,
              content: source.content,
              encoding: 'base64',
              createDirs: true,
            } satisfies FsWriteArgs,
            timeoutMs,
            context,
            signal,
          )
        : await this.requestLocalTool(
            userId,
            'fs.write',
            {
              path: args.destination,
              content: source.content,
              encoding: 'base64',
              createDirs: true,
            } satisfies FsWriteArgs,
            timeoutMs,
            context,
            signal,
          );
    if (!writeResult.ok) {
      return errResult(
        writeResult.error.code,
        `Copy destination write failed: ${writeResult.error.message}`,
      );
    }
    const destination = writeResult.data as FsWriteResult;

    return {
      ok: true,
      data: {
        source: args.source,
        destination: args.destination,
        bytesCopied: destination.bytesWritten,
      },
    };
  }

  private async routeToolRequest(options: {
    userId: string;
    tool: ToolName;
    args: unknown;
    timeoutMs: number;
    context: ToolCallContext;
    signal?: AbortSignal;
    plane: 'local' | 'cloud';
    requiresApproval: boolean;
    skipAudit?: boolean;
  }): Promise<ToolResult<unknown>> {
    const { userId, tool, args, timeoutMs, context, signal, plane } = options;

    if (plane === 'cloud') {
      const capability = CLOUD_TOOL_CAPABILITY[tool];
      if (!capability) {
        return errResult(
          'NOT_IMPLEMENTED',
          `Tool ${tool} is not routable to the cloud plane`,
        );
      }
      return this.sendToolRequest({
        userId,
        tool,
        args,
        timeoutMs,
        context,
        signal,
        requiresApproval: false,
        capability,
        skipAudit: options.skipAudit,
      });
    }

    const capability = LOCAL_TOOL_CAPABILITY[tool];
    if (!capability) {
      return errResult(
        'NOT_IMPLEMENTED',
        `Tool ${tool} is not routable to the local plane`,
      );
    }
    return this.sendLocalToolRequest({
      userId,
      tool,
      args,
      timeoutMs,
      context,
      signal,
      capability,
      requiresApproval: options.requiresApproval,
    });
  }

  private async sendLocalToolRequest(options: {
    userId: string;
    tool: ToolName;
    args: unknown;
    timeoutMs: number;
    context: ToolCallContext;
    signal?: AbortSignal;
    capability: MachineCapability;
    requiresApproval: boolean;
  }): Promise<ToolResult<unknown>> {
    const { userId, tool, args, timeoutMs, context, signal, capability } = options;
    const eligible = [...this.machines.values()].filter(
      (machine) =>
        machine.userId === userId &&
        machine.capabilities.includes(capability) &&
        machine.socket.readyState === WebSocket.OPEN,
    );
    const selectedMachineId = this.selectedMachines.get(userId);
    const targets = selectedMachineId
      ? eligible.filter((machine) => machine.machineId === selectedMachineId)
      : eligible;
    if (selectedMachineId && targets.length === 0) {
      return errResult(
        'MACHINE_OFFLINE',
        `The selected local machine is offline or does not support ${capability}`,
      );
    }
    if (targets.length === 0) {
      return errResult('MACHINE_OFFLINE', 'No eligible local machine is online');
    }
    if (!selectedMachineId && targets.length > 1) {
      return errResult(
        'TARGET_SELECTION_REQUIRED',
        'More than one local machine is online; select a target machine',
      );
    }
    if (signal?.aborted) {
      return errResult('ABORTED', `Local ${tool} request was cancelled`);
    }

    const machine = targets[0];
    return this.dispatchToolRequest({
      socket: machine.socket,
      userId,
      tool,
      args,
      timeoutMs,
      context,
      signal,
      requiresApproval: options.requiresApproval,
      auditMachineId: machine.machineId,
      plane: 'local',
    });
  }

  private sendToolRequest(options: {
    userId: string;
    tool: ToolName;
    args: unknown;
    timeoutMs: number;
    context: ToolCallContext;
    signal?: AbortSignal;
    requiresApproval: boolean;
    capability: CloudRuntimeCapability;
    skipAudit?: boolean;
  }): Promise<ToolResult<unknown>> {
    const { userId, tool, args, timeoutMs, context, signal, capability } = options;
    const eligible = [...this.runtimes.values()].filter(
      (runtime) =>
        runtime.userId === userId &&
        runtime.capabilities.includes(capability) &&
        runtime.socket.readyState === WebSocket.OPEN,
    );
    const selectedRuntimeId = this.selectedRuntimes.get(userId);
    const targets = selectedRuntimeId
      ? eligible.filter((runtime) => runtime.podId === selectedRuntimeId)
      : eligible;
    if (selectedRuntimeId && targets.length === 0) {
      return Promise.resolve(
        errResult(
          'RUNTIME_OFFLINE',
          `The selected cloud runtime is offline or does not support ${capability}`,
        ),
      );
    }
    if (targets.length === 0) {
      return Promise.resolve(
        errResult('RUNTIME_OFFLINE', 'No eligible cloud runtime is online'),
      );
    }
    if (!selectedRuntimeId && targets.length > 1) {
      return Promise.resolve(
        errResult(
          'TARGET_SELECTION_REQUIRED',
          'More than one cloud runtime is online; select a target runtime',
        ),
      );
    }
    if (signal?.aborted) {
      return Promise.resolve(
        errResult('ABORTED', `Cloud ${tool} request was cancelled`),
      );
    }

    const runtime = targets[0];
    return this.dispatchToolRequest({
      socket: runtime.socket,
      userId,
      tool,
      args,
      timeoutMs,
      context,
      signal,
      requiresApproval: false,
      auditMachineId: runtime.podId,
      plane: 'cloud',
      skipAudit: options.skipAudit,
    });
  }

  private async dispatchToolRequest(options: {
    socket: ToolClientSocket;
    userId: string;
    tool: ToolName;
    args: unknown;
    timeoutMs: number;
    context: ToolCallContext;
    signal?: AbortSignal;
    requiresApproval: boolean;
    auditMachineId: string;
    plane: 'local' | 'cloud';
    skipAudit?: boolean;
  }): Promise<ToolResult<unknown>> {
    const {
      socket,
      userId,
      tool,
      args,
      timeoutMs,
      context,
      signal,
      requiresApproval,
      auditMachineId,
      plane,
      skipAudit,
    } = options;
    const requestId = randomUUID();
    const approvalId = requiresApproval ? randomUUID() : requestId;

    // 发送前先按协议校验参数：客户端对非法消息会静默丢弃，必须在网关侧拦下
    const parsedArgs = ToolArgsSchemasByName[tool].safeParse(args);
    if (!parsedArgs.success) {
      return errResult('INVALID_ARGS', parsedArgs.error.message);
    }
    // 下发解析后的参数：让 zod default（如 encoding）与其他归一化结果一起生效
    const normalizedArgs = parsedArgs.data;

    if (!skipAudit) {
      await this.auditStore.recordToolCallStarted({
        requestId,
        userId,
        sessionId: context.sessionId,
        runId: context.runId,
        machineId: auditMachineId,
        tool,
      });
      if (!requiresApproval) {
        // 云端沙箱免审批：审计直接进入 approved，与旧的云端 fs 流程一致
        await this.auditStore.recordToolCallStatus({
          requestId,
          userId,
          runId: context.runId,
          status: 'approved',
        });
      }
    }

    const requestedPath =
      typeof (args as { path?: unknown })?.path === 'string'
        ? (args as { path: string }).path
        : undefined;

    const message: ToolRequestMessage = {
      type: 'tool.request',
      requestId,
      tool,
      args: normalizedArgs as never,
      timeoutMs,
      requiresApproval,
      ...(requiresApproval ? { approvalId } : {}),
    };

    return new Promise((resolve, reject) => {
      const request: PendingToolRequest = {
        socket,
        userId,
        runId: context.runId,
        approvalId,
        // 云端免审批请求视同已批准：结果回包无需先经 tool.approval
        approvalState: requiresApproval ? 'pending' : 'approved',
        auditDisabled: Boolean(skipAudit),
        tool,
        requestedPath,
        auditQueue: Promise.resolve(),
        timer: setTimeout(() => {
          void this.finish(
            requestId,
            request,
            errResult('TIMEOUT', timeoutMessage(tool, plane)),
            'timed_out',
            'TIMEOUT',
          );
        }, timeoutMs),
        resolve: (result) => resolve(
          result.ok
            ? { ok: true, data: this.parseToolResult(tool, result.data, requestedPath) }
            : result,
        ),
        reject,
        signal,
      };
      if (signal) {
        request.onAbort = () => {
          void this.finish(
            requestId,
            request,
            errResult('ABORTED', cancelMessage(tool, plane)),
            'cancelled',
            'ABORTED',
          );
        };
        signal.addEventListener('abort', request.onAbort, { once: true });
      }
      this.pending.set(requestId, request);

      try {
        socket.send(JSON.stringify(message));
      } catch (error) {
        void this.finish(
          requestId,
          request,
          errResult(
            'MACHINE_OFFLINE',
            error instanceof Error ? error.message : 'Unable to send tool request',
          ),
          'failed',
          'MACHINE_OFFLINE',
        );
      }
    });
  }

  /** 回包校验：按工具 Result Schema 解析，路径回显类工具额外校验路径一致 */
  private parseToolResult(
    tool: ToolName,
    data: unknown,
    requestedPath?: string,
  ): unknown {
    const schema = ToolResultSchemasByName[tool];
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      throw new Error(`${tool} returned an invalid result`);
    }
    if (
      requestedPath !== undefined &&
      PATH_ECHO_TOOLS.has(tool) &&
      (parsed.data as { path?: string }).path !== requestedPath
    ) {
      throw new Error(`${tool} returned an invalid result`);
    }
    return parsed.data;
  }

  async handleApproval(
    socket: ToolClientSocket,
    message: ToolApprovalMessage,
  ): Promise<boolean> {
    const request = this.pending.get(message.requestId);
    if (
      !request ||
      request.socket !== socket ||
      request.approvalId !== message.approvalId ||
      request.approvalState !== 'pending'
    ) {
      return false;
    }

    if (!message.approved) {
      await this.finish(
        message.requestId,
        request,
        errResult('ABORTED', message.reason ?? 'User denied the tool request'),
        'denied',
        'ABORTED',
      );
      return true;
    }

    request.approvalState = 'approved';
    await this.enqueueStatus(request, {
      requestId: message.requestId,
      userId: request.userId,
      runId: request.runId,
      status: 'approved',
    });
    return true;
  }

  async handleResult(
    socket: ToolClientSocket,
    message: ToolResultMessage,
  ): Promise<boolean> {
    const request = this.pending.get(message.requestId);
    if (!request || request.socket !== socket || request.approvalState !== 'approved') {
      return false;
    }

    let result: ToolResult<unknown>;
    if (message.result.ok) {
      try {
        result = { ok: true, data: this.parseToolResult(request.tool, message.result.data, request.requestedPath) };
      } catch (error) {
        result = errResult(
          'INTERNAL',
          error instanceof Error ? error.message : String(error),
        );
      }
    } else {
      result = message.result;
    }
    await this.finish(
      message.requestId,
      request,
      result,
      result.ok ? 'completed' : 'failed',
      result.ok ? undefined : result.error.code,
    );
    return true;
  }

  private async finish(
    requestId: string,
    request: PendingToolRequest,
    result: ToolResult<unknown>,
    status: ToolCallAuditStatus['status'],
    resultCode?: string,
  ): Promise<void> {
    if (this.pending.get(requestId) !== request) return;
    this.pending.delete(requestId);
    clearTimeout(request.timer);
    if (request.signal && request.onAbort) {
      request.signal.removeEventListener('abort', request.onAbort);
    }

    try {
      await this.enqueueStatus(request, {
        requestId,
        userId: request.userId,
        runId: request.runId,
        status,
        resultCode,
      });
      request.resolve(result);
    } catch (error) {
      request.reject(error);
    }
  }

  private enqueueStatus(
    request: PendingToolRequest,
    event: ToolCallAuditStatus,
  ): Promise<void> {
    if (request.auditDisabled) {
      return request.auditQueue;
    }
    request.auditQueue = request.auditQueue.then(() =>
      this.auditStore.recordToolCallStatus(event),
    );
    return request.auditQueue;
  }

  private machineKey(userId: string, machineId: string): string {
    return `${userId}\u0000${machineId}`;
  }

  private runtimeKey(userId: string, podId: string): string {
    return `${userId}\u0000${podId}`;
  }
}
