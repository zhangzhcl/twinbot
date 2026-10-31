import WebSocket from 'ws';
import {
  ServerToClientMessageSchema,
  type CloudRuntimeCapability,
  type PreviewHttpResponseMessage,
  type RuntimeHelloMessage,
  type ServerToClientMessage,
  type ToolRequestMessage,
  type ToolResultMessage,
} from '@lca/ws-protocol';
import { errResult, type ToolName, type ToolResult } from '@lca/tool-protocol';
import type { CloudRuntimeToolHandler } from './runtimeFileTools';
import { PreviewRelay } from './runtimePreviewRelay';

export interface CloudRuntimeClientOptions {
  controlWsUrl: string;
  token: string;
  podId: string;
  heartbeatIntervalMs?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  /** 兼容旧用法：传入文件工具时自动注册 fs.read / fs.list 处理器 */
  fileTools?: { read(args: unknown): Promise<ToolResult<unknown>>; list(args: unknown): Promise<ToolResult<unknown>> };
  /** 工具名 → 处理器注册表；能力上报默认由注册表键推导 */
  toolHandlers?: Partial<Record<ToolName, CloudRuntimeToolHandler>>;
  /** 显式指定能力上报；缺省时由 toolHandlers 推导 */
  capabilities?: CloudRuntimeCapability[];
  /** 注入点：测试时替换 preview 中继的 fetch */
  previewRelayDeps?: { fetchImpl?: typeof fetch };
}

/**
 * 从工具注册表推导 Pod 能力上报：
 * fs 类工具 → fs；shell.exec → shell；code.run → code；web.* → web；
 * browser.use → browser；lsp.query → lsp；vcs.checkpoint → vcs。
 */
export function deriveRuntimeCapabilities(
  toolHandlers: Partial<Record<ToolName, CloudRuntimeToolHandler>>,
): CloudRuntimeCapability[] {
  const has = (tool: ToolName): boolean => Boolean(toolHandlers[tool]);
  const capabilities = new Set<CloudRuntimeCapability>();
  if (has('fs.read') || has('fs.list') || has('fs.write')) capabilities.add('fs');
  if (has('shell.exec')) capabilities.add('shell');
  if (has('code.run')) capabilities.add('code');
  if (has('web.fetch') || has('web.search')) capabilities.add('web');
  if (has('browser.use')) capabilities.add('browser');
  if (has('lsp.query')) capabilities.add('lsp');
  if (has('vcs.checkpoint')) capabilities.add('vcs');
  return [...capabilities];
}

export class CloudRuntimeClient {
  private readonly toolHandlers: Partial<Record<ToolName, CloudRuntimeToolHandler>>;
  private readonly previewRelay: PreviewRelay;
  private socket: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private everConnected = false;
  private reconnectAttempt = 0;
  private startup:
    | { resolve: () => void; reject: (error: Error) => void }
    | null = null;

  constructor(private readonly options: CloudRuntimeClientOptions) {
    const url = new URL(options.controlWsUrl);
    if (
      url.protocol !== 'wss:' &&
      !(url.protocol === 'ws:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname))
    ) {
      throw new Error('Cloud Runtime Control API URL must use WSS');
    }
    if (!options.token || !options.podId) {
      throw new Error('Cloud Runtime token and pod ID are required');
    }
    if (
      options.heartbeatIntervalMs !== undefined &&
      (!Number.isInteger(options.heartbeatIntervalMs) ||
        options.heartbeatIntervalMs < 1000)
    ) {
      throw new Error('Cloud Runtime heartbeat interval must be at least 1000ms');
    }

    const handlers: Partial<Record<ToolName, CloudRuntimeToolHandler>> = {};
    if (options.fileTools) {
      handlers['fs.read'] = (args) => options.fileTools!.read(args);
      handlers['fs.list'] = (args) => options.fileTools!.list(args);
    }
    this.toolHandlers = { ...handlers, ...(options.toolHandlers ?? {}) };
    this.previewRelay = new PreviewRelay(options.previewRelayDeps ?? {});
  }

  start(): Promise<void> {
    if (!this.stopped) {
      return Promise.reject(new Error('Cloud Runtime client is already started'));
    }
    this.stopped = false;
    this.everConnected = false;
    this.reconnectAttempt = 0;
    const started = new Promise<void>((resolve, reject) => {
      this.startup = { resolve, reject };
    });
    this.connect();
    return started;
  }

  stop(): void {
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, 'Runtime stopping');
  }

  private connect(): void {
    if (this.stopped) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.options.controlWsUrl, {
        headers: { authorization: `Bearer ${this.options.token}` },
      });
    } catch (error) {
      this.failStartup(error);
      this.stop();
      return;
    }
    this.socket = socket;

    socket.once('open', () => {
      if (this.stopped || this.socket !== socket) {
        socket.close();
        return;
      }
      this.reconnectAttempt = 0;
      const capabilities = this.options.capabilities ?? deriveRuntimeCapabilities(this.toolHandlers);
      const registration: RuntimeHelloMessage = {
        type: 'runtime.hello',
        podId: this.options.podId,
        capabilities,
        protocolVersion: 1,
      };
      socket.send(JSON.stringify(registration));
      this.heartbeatTimer = setInterval(
        () => this.sendHeartbeat(socket),
        this.options.heartbeatIntervalMs ?? 15_000,
      );
      this.everConnected = true;
      this.startup?.resolve();
      this.startup = null;
    });

    socket.on('message', (data) => {
      void this.handleMessage(socket, data.toString());
    });

    socket.on('error', (error) => {
      if (!this.everConnected) {
        this.failStartup(error);
        this.stop();
      }
    });

    socket.once('close', () => {
      if (this.socket === socket) this.socket = null;
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      if (!this.everConnected) this.failStartup(new Error('Runtime connection closed before opening'));
      this.scheduleReconnect();
    });
  }

  private sendHeartbeat(socket: WebSocket): void {
    if (this.stopped || this.socket !== socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
  }

  private async handleMessage(socket: WebSocket, raw: string): Promise<void> {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return;
    }
    const parsed = ServerToClientMessageSchema.safeParse(value);
    if (!parsed.success) return;

    const message = parsed.data as ServerToClientMessage;
    if (message.type === 'tool.request') {
      await this.handleToolRequest(socket, message);
    } else if (message.type === 'preview.request') {
      // 产物预览中继：fetch Pod 自身 loopback 后原路回传
      const response: PreviewHttpResponseMessage = await this.previewRelay.handle(message);
      if (socket.readyState === WebSocket.OPEN && !this.stopped) {
        socket.send(JSON.stringify(response));
      }
    }
  }

  private async handleToolRequest(
    socket: WebSocket,
    req: ToolRequestMessage,
  ): Promise<void> {
    const handler = this.toolHandlers[req.tool];
    const result: ToolResult<unknown> = handler
      ? await handler(req.args).catch((error: unknown) => errResult(
          'INTERNAL',
          error instanceof Error ? error.message : String(error),
        ))
      : errResult(
          'NOT_IMPLEMENTED',
          `Tool ${req.tool} is not supported in cloud runtime`,
        );

    if (socket.readyState === WebSocket.OPEN && !this.stopped) {
      const response: ToolResultMessage = {
        type: 'tool.result',
        requestId: req.requestId,
        result,
      };
      socket.send(JSON.stringify(response));
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const minimum = this.options.reconnectMinMs ?? 1000;
    const maximum = this.options.reconnectMaxMs ?? 30_000;
    const delay = Math.min(maximum, minimum * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private failStartup(error: unknown): void {
    const startup = this.startup;
    if (!startup) return;
    this.startup = null;
    startup.reject(error instanceof Error ? error : new Error(String(error)));
  }
}
