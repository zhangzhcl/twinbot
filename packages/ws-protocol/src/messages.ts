import { z } from 'zod';
import type {
  ToolArgs,
  ToolName,
  ToolResult,
} from '@lca/tool-protocol';
import {
  ToolArgsSchemasByName,
  ToolNameSchema,
  ToolResultSchema,
} from '@lca/tool-protocol';

/**
 * Capabilities a local machine advertises.
 * fs：文件读写与检索；shell：命令执行；files：跨端文件搬运（保留值）；ask：可向用户提问。
 */
export type MachineCapability = 'fs' | 'shell' | 'files' | 'ask';
export const MachineCapabilitySchema = z.enum(['fs', 'shell', 'files', 'ask']);
/**
 * Capabilities a cloud runtime advertises，按 Pod 内可用模块动态上报。
 * fs：文件与检索；shell：命令与脚本；code：code.run；web：web.fetch/search；
 * browser：无头 Chromium；lsp：TS/JS 语言查询；vcs：工作区快照。
 */
export type CloudRuntimeCapability =
  | 'fs'
  | 'shell'
  | 'code'
  | 'web'
  | 'browser'
  | 'lsp'
  | 'vcs';
export const CloudRuntimeCapabilitySchema = z.enum([
  'fs',
  'shell',
  'code',
  'web',
  'browser',
  'lsp',
  'vcs',
]);

/** ---------- Client → Server ---------- */

export interface RuntimeHelloMessage {
  type: 'runtime.hello';
  podId: string;
  capabilities: CloudRuntimeCapability[];
  protocolVersion?: number;
}

export interface MachineHelloMessage {
  type: 'machine.hello';
  machineId: string;
  capabilities: MachineCapability[];
  /** Optional human-readable label, e.g. hostname */
  label?: string;
  /** Protocol version the client speaks */
  protocolVersion?: number;
}

export interface ToolApprovalMessage {
  type: 'tool.approval';
  approvalId: string;
  requestId: string;
  approved: boolean;
  /** Optional reason when denied */
  reason?: string;
}

export interface ToolResultMessage {
  type: 'tool.result';
  requestId: string;
  result: ToolResult;
}

export interface PingMessage {
  type: 'ping';
  ts: number;
}

export type ClientToServerMessage =
  | RuntimeHelloMessage
  | MachineHelloMessage
  | ToolApprovalMessage
  | ToolResultMessage
  | PreviewHttpRequestMessage
  | PreviewHttpResponseMessage
  | PingMessage;

export const RuntimeHelloMessageSchema = z.object({
  type: z.literal('runtime.hello'),
  podId: z.string().min(1),
  capabilities: z.array(CloudRuntimeCapabilitySchema),
  protocolVersion: z.number().int().positive().optional(),
});

export const MachineHelloMessageSchema = z.object({
  type: z.literal('machine.hello'),
  machineId: z.string().min(1),
  capabilities: z.array(MachineCapabilitySchema),
  label: z.string().optional(),
  protocolVersion: z.number().int().positive().optional(),
});

export const ToolApprovalMessageSchema = z.object({
  type: z.literal('tool.approval'),
  approvalId: z.string().min(1),
  requestId: z.string().min(1),
  approved: z.boolean(),
  reason: z.string().optional(),
});

export const ToolResultMessageSchema = z.object({
  type: z.literal('tool.result'),
  requestId: z.string().min(1),
  result: ToolResultSchema,
});

export const PingMessageSchema = z.object({
  type: z.literal('ping'),
  ts: z.number().finite(),
});

export const PreviewHttpRequestMessageSchema = z.object({
  type: z.literal('preview.request'),
  requestId: z.string().min(1),
  port: z.number().int().min(1024).max(65535),
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']),
  path: z.string().max(2048).regex(/^\//, 'path must start with /'),
  headers: z.record(z.string().min(1).max(256), z.string().max(4096)).default({}),
  bodyBase64: z.string().max(10_000_000).optional(),
});

export const PreviewHttpResponseMessageSchema = z.object({
  type: z.literal('preview.response'),
  requestId: z.string().min(1),
  status: z.number().int().min(100).max(599),
  headers: z.record(z.string().min(1).max(256), z.string().max(4096)).default({}),
  bodyBase64: z.string().max(10_000_000).optional(),
  truncated: z.boolean().optional(),
});

export const ClientToServerMessageSchema = z.discriminatedUnion('type', [
  RuntimeHelloMessageSchema,
  MachineHelloMessageSchema,
  ToolApprovalMessageSchema,
  ToolResultMessageSchema,
  PreviewHttpRequestMessageSchema,
  PreviewHttpResponseMessageSchema,
  PingMessageSchema,
]);

/** ---------- 产物预览：HTTP-over-WSS 反向中继 ----------
 * 桌面本地代理把浏览器请求封装成 preview.request 发给控制面；
 * 控制面按 user→runtime 绑定转发给 Pod；Runtime fetch 自身 loopback 后
 * 以 preview.response 原路回传。同一对消息类型在两个方向复用，
 * 由控制面按连接主体（user / runtime）区分流向。 */

export interface PreviewHttpRequestMessage {
  type: 'preview.request';
  requestId: string;
  /** Pod 内 loopback 目标端口（约定 30000-39999，但不强制） */
  port: number;
  method: string;
  /** 以 / 开头的路径，含 query */
  path: string;
  headers: Record<string, string>;
  bodyBase64?: string;
}

export interface PreviewHttpResponseMessage {
  type: 'preview.response';
  requestId: string;
  status: number;
  headers: Record<string, string>;
  bodyBase64?: string;
  /** 响应体超过单条消息上限被截断时为 true */
  truncated?: boolean;
}

/** ---------- Server → Client ---------- */

export interface ToolRequestMessage {
  type: 'tool.request';
  requestId: string;
  tool: ToolName;
  args: ToolArgs;
  /** Soft deadline for the local agent */
  timeoutMs?: number;
  /** If true, local agent must get user approval before running */
  requiresApproval: boolean;
  /** Present when requiresApproval is true; used in tool.approval replies */
  approvalId?: string;
}

export interface SessionDeltaMessage {
  type: 'session.delta';
  sessionId: string;
  /** Opaque chat/session patch payload */
  delta: unknown;
}

export interface PongMessage {
  type: 'pong';
  ts: number;
}

export type ServerToClientMessage =
  | ToolRequestMessage
  | PreviewHttpRequestMessage
  | PreviewHttpResponseMessage
  | SessionDeltaMessage
  | PongMessage;

const ToolRequestCommonSchema = {
  type: z.literal('tool.request'),
  requestId: z.string().min(1),
  timeoutMs: z.number().int().positive().optional(),
  requiresApproval: z.boolean(),
  approvalId: z.string().min(1).optional(),
};

/**
 * 由 tool-protocol 的参数注册表生成每个工具的判别分支，
 * 新增工具时只需扩展 ToolArgsSchemasByName，本文件无需再改。
 */
type ToolRequestBranchShape = {
  type: z.ZodLiteral<'tool.request'>;
  requestId: z.ZodString;
  timeoutMs: z.ZodOptional<z.ZodNumber>;
  requiresApproval: z.ZodBoolean;
  approvalId: z.ZodOptional<z.ZodString>;
  tool: z.ZodLiteral<ToolName>;
  args: z.ZodTypeAny;
};
type ToolRequestBranch = z.ZodObject<ToolRequestBranchShape>;

const ToolRequestBranches = (Object.keys(ToolArgsSchemasByName) as ToolName[]).map(
  (tool) =>
    z.object({
      ...ToolRequestCommonSchema,
      tool: z.literal(tool),
      args: ToolArgsSchemasByName[tool],
    }) as unknown as ToolRequestBranch,
);

export const ToolRequestMessageSchema = z
  .discriminatedUnion('tool', [
    ToolRequestBranches[0],
    ...ToolRequestBranches.slice(1),
  ] as [ToolRequestBranch, ...ToolRequestBranch[]])
  .superRefine((message, context) => {
    if (message.requiresApproval && !message.approvalId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['approvalId'],
        message: 'approvalId is required when approval is requested',
      });
    }
  });

export const SessionDeltaMessageSchema = z.object({
  type: z.literal('session.delta'),
  sessionId: z.string().min(1),
  delta: z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(z.unknown()),
    z.record(z.unknown()),
  ]),
});

export const PongMessageSchema = z.object({
  type: z.literal('pong'),
  ts: z.number().finite(),
});

export const ServerToClientMessageSchema = z.union([
  ToolRequestMessageSchema,
  PreviewHttpRequestMessageSchema,
  PreviewHttpResponseMessageSchema,
  SessionDeltaMessageSchema,
  PongMessageSchema,
]);

export const WsMessageSchema = z.union([
  ClientToServerMessageSchema,
  ServerToClientMessageSchema,
]);

/** Any framed WS message */
export type WsMessage = ClientToServerMessage | ServerToClientMessage;

export function isClientToServerMessage(
  msg: unknown,
): msg is ClientToServerMessage {
  return ClientToServerMessageSchema.safeParse(msg).success;
}

export function isServerToClientMessage(
  msg: unknown,
): msg is ServerToClientMessage {
  return ServerToClientMessageSchema.safeParse(msg).success;
}
