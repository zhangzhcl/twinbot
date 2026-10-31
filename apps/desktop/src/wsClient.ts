import WebSocket from 'ws';
import os from 'node:os';
import type {
  ClientToServerMessage,
  ServerToClientMessage,
  ToolRequestMessage,
} from '@lca/ws-protocol';
import { ServerToClientMessageSchema } from '@lca/ws-protocol';
import type { ToolResult } from '@lca/tool-protocol';
import type { LocalAgent } from './localAgent';

const DEFAULT_WS_URL = 'ws://127.0.0.1:8787/v1/ws';
const RECONNECT_BASE_MS = 3000;
const RECONNECT_MAX_MS = 60_000;
const CONNECTION_STABLE_MS = 30_000;

export function getReconnectDelay(
  attempt: number,
  random: () => number = Math.random,
): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error('Reconnect attempt must be positive');
  }
  const randomValue = random();
  if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue > 1) {
    throw new Error('Reconnect jitter source must return a value between 0 and 1');
  }

  const exponentialDelay = Math.min(
    RECONNECT_MAX_MS,
    RECONNECT_BASE_MS * 2 ** Math.min(attempt - 1, 30),
  );
  const jitteredDelay = exponentialDelay * (0.8 + randomValue * 0.4);
  return Math.min(RECONNECT_MAX_MS, Math.round(jitteredDelay));
}

export interface WsClientOptions {
  machineId: string;
  token?: string;
  url?: string;
  localAgent: LocalAgent;
  onSessionDelta?: (sessionId: string, delta: unknown) => void;
}

/**
 * Stub WebSocket client: connect → machine.hello → handle tool.request.
 * Reconnects every 3s on close/error.
 */
export class ControlWsClient {
  private ws: WebSocket | null = null;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stableConnectionTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private readonly url: string;
  private readonly machineId: string;
  private readonly token: string;
  private readonly localAgent: LocalAgent;
  private readonly onSessionDelta?: (sessionId: string, delta: unknown) => void;

  constructor(opts: WsClientOptions) {
    this.machineId = opts.machineId;
    this.localAgent = opts.localAgent;
    this.onSessionDelta = opts.onSessionDelta;
    const base = opts.url ?? process.env.CONTROL_WS_URL ?? DEFAULT_WS_URL;
    const u = new URL(base);
    const isLoopback =
      u.hostname === 'localhost' ||
      u.hostname === '127.0.0.1' ||
      u.hostname === '[::1]';
    if (u.protocol !== 'wss:' && !(u.protocol === 'ws:' && isLoopback)) {
      throw new Error('Control WebSocket must use WSS outside loopback');
    }
    const token =
      opts.token ??
      process.env.CONTROL_TOKEN ??
      (isLoopback ? 'dev-token' : undefined);
    if (!token) {
      throw new Error('CONTROL_TOKEN is required for remote Control WebSocket');
    }
    this.token = token;
    u.searchParams.set('machineId', this.machineId);
    this.url = u.toString();
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.stableConnectionTimer) {
      clearTimeout(this.stableConnectionTimer);
      this.stableConnectionTimer = null;
    }
    this.reconnectAttempts = 0;
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
  }

  private connect(): void {
    if (this.stopped) return;

    console.log(`[ws] connecting to ${new URL(this.url).origin}`);
    const ws = new WebSocket(this.url, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    this.ws = ws;

    ws.on('open', () => {
      if (this.stableConnectionTimer) clearTimeout(this.stableConnectionTimer);
      this.stableConnectionTimer = setTimeout(() => {
        this.reconnectAttempts = 0;
        this.stableConnectionTimer = null;
      }, CONNECTION_STABLE_MS);
      console.log('[ws] connected');
      this.send({
        type: 'machine.hello',
        machineId: this.machineId,
        // fs：文件读写检索；shell：命令执行；ask：可向用户提问
        capabilities: ['fs', 'shell', 'ask'],
        label: os.hostname(),
        protocolVersion: 1,
      });
    });

    ws.on('message', (data) => {
      void this.onMessage(data.toString());
    });

    ws.on('close', (code, reason) => {
      if (this.stableConnectionTimer) {
        clearTimeout(this.stableConnectionTimer);
        this.stableConnectionTimer = null;
      }
      console.log(`[ws] closed code=${code} reason=${reason.toString()}`);
      this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      console.warn('[ws] error:', err.message);
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) return;
    const delayMs = getReconnectDelay(++this.reconnectAttempts);
    console.log(`[ws] reconnecting in ${delayMs}ms…`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }

  private send(msg: ClientToServerMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[ws] send skipped — not open:', msg.type);
      return;
    }
    this.ws.send(JSON.stringify(msg));
  }

  private async onMessage(raw: string): Promise<void> {
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      console.warn('[ws] invalid JSON message');
      return;
    }

    const parsed = ServerToClientMessageSchema.safeParse(value);
    if (!parsed.success) {
      console.warn('[ws] invalid server message:', parsed.error.issues);
      return;
    }
    const msg = parsed.data as ServerToClientMessage;

    switch (msg.type) {
      case 'tool.request':
        await this.handleToolRequest(msg);
        break;
      case 'pong':
        console.log('[ws] pong', msg.ts);
        break;
      case 'session.delta':
        console.log('[ws] session.delta', msg.sessionId);
        this.onSessionDelta?.(msg.sessionId, msg.delta);
        break;
      default:
        console.log('[ws] unknown message', (msg as { type: string }).type);
    }
  }


  private async handleToolRequest(req: ToolRequestMessage): Promise<void> {
    console.log(
      `[ws] tool.request id=${req.requestId} tool=${req.tool} approval=${req.requiresApproval}`,
    );

    let result: ToolResult;

    try {
      if (req.requiresApproval) {
        const approved = await this.localAgent.askApproval(req);
        if (req.approvalId) {
          this.send({
            type: 'tool.approval',
            approvalId: req.approvalId,
            requestId: req.requestId,
            approved,
            reason: approved ? undefined : 'User denied the tool request',
          });
        }
        if (!approved) {
          result = {
            ok: false,
            error: { code: 'ABORTED', message: 'User denied the tool request' },
          };
          this.send({ type: 'tool.result', requestId: req.requestId, result });
          return;
        }
        result = await this.localAgent.runTool(req);
      } else {
        result = await this.localAgent.handleToolRequest(req);
      }
    } catch (err) {
      result = {
        ok: false,
        error: {
          code: 'INTERNAL',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }

    this.send({
      type: 'tool.result',
      requestId: req.requestId,
      result,
    });
  }
}
