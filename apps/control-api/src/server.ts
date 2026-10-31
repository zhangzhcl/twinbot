import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import {
  ClientToServerMessageSchema,
  type ClientToServerMessage,
  type RuntimeHelloMessage,
  type MachineHelloMessage,
} from '@lca/ws-protocol';
import type { ToolName } from '@lca/tool-protocol';
import {
  SessionBusyError,
  type AcceptedMessage,
  type ConversationStore,
} from './conversationStore';
import type {
  CloudRuntimeIdentity,
  DevTokenAuthenticator,
  RuntimeTokenAuthenticator,
} from './auth';
import type { LocalToolRouter } from './toolRouter';
import { hasSecret, maskSecret } from './secrets';
import { nextCronFire } from './cron';
import type { RoutineInput } from './conversationStore';

const MAX_BODY_BYTES = 64 * 1024;
/**
 * WSS 单条消息上限：工具结果可能携带 base64 文件内容或浏览器截图，
 * 协议层 TOOL_PAYLOAD_MAX_CHARS（5,000,000 字符，base64 后约 6.7MB）加 JSON
 * 包装后必须能完整通过网关，否则 tool.result 会被断连丢弃。
 */
const MAX_WS_PAYLOAD_BYTES = 8 * 1024 * 1024;
const MAX_MESSAGE_LENGTH = 16_000;
const MAX_TITLE_LENGTH = 120;

/** 桌面端 UI 直连通道允许的只读工具白名单（与桌面端 preload 侧校验一致） */
const UI_ALLOWED_CLOUD_TOOLS = new Set([
  'fs.read',
  'fs.list',
  'fs.glob',
  'fs.grep',
  'notebook.read',
  'lsp.query',
  'browser.use',
  'shell.exec',
]);

interface ControlServerOptions {
  store: ConversationStore;
  authenticate: DevTokenAuthenticator;
  authenticateRuntime?: RuntimeTokenAuthenticator;
  toolRouter: LocalToolRouter;
  cancelRun?: (runId: string) => boolean;
  /** 产物预览公网基础地址（/p/<token> 拼在其后），如 https://your-domain:8787 */
  previewPublicBaseUrl: string;
  /** 由 createControlServer 注入的令牌路由表 */
  previewRoutes?: Map<string, PreviewRouteEntry>;
  /** Optional hook after a session is created (e.g. fire event routines). */
  onSessionCreated?: (userId: string, sessionId: string) => void | Promise<void>;
}

/** 产物预览路由令牌：token → 访问目标（随控制面重启失效，重新点「打开产物」即重新生成） */
interface PreviewRouteEntry {
  userId: string;
  sessionId: string;
  podPort: number;
  createdAt: number;
}

const PREVIEW_ROUTE_TTL_MS = 12 * 60 * 60 * 1000;
const PREVIEW_BODY_LIMIT_BYTES = 5 * 1024 * 1024;

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, 'Request body is too large');
    }
    chunks.push(buffer);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON');
  }
}

async function readRawBody(
  request: IncomingMessage,
  limitBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > limitBytes) {
      throw new HttpError(413, 'Request body is too large');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function parseRoutineBody(body: Record<string, unknown>): RoutineInput {
  if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 80) {
    throw new HttpError(400, 'name must be 1-80 characters');
  }
  if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > MAX_MESSAGE_LENGTH) {
    throw new HttpError(400, `prompt must be 1-${MAX_MESSAGE_LENGTH} characters`);
  }
  const scheduleKind = body.scheduleKind;
  if (scheduleKind !== 'cron' && scheduleKind !== 'interval' && scheduleKind !== 'event') {
    throw new HttpError(400, 'scheduleKind must be cron, interval, or event');
  }
  const input: RoutineInput = {
    name: body.name.trim(),
    prompt: body.prompt,
    scheduleKind,
    sessionId: body.sessionId === null || body.sessionId === undefined
      ? null
      : typeof body.sessionId === 'string' ? body.sessionId : (() => { throw new HttpError(400, 'sessionId must be string or null'); })(),
    enabled: body.enabled === undefined ? true : Boolean(body.enabled),
  };
  if (scheduleKind === 'cron') {
    if (typeof body.cronExpr !== 'string' || !body.cronExpr.trim()) {
      throw new HttpError(400, 'cronExpr is required for cron routines');
    }
    if (!nextCronFire(body.cronExpr, new Date())) {
      throw new HttpError(400, 'cronExpr is invalid');
    }
    input.cronExpr = body.cronExpr.trim();
  }
  if (scheduleKind === 'interval') {
    const intervalMs = Number(body.intervalMs);
    if (!Number.isInteger(intervalMs) || intervalMs < 60_000) {
      throw new HttpError(400, 'intervalMs must be an integer >= 60000');
    }
    input.intervalMs = intervalMs;
  }
  if (scheduleKind === 'event') {
    if (typeof body.eventType !== 'string' || !body.eventType.trim()) {
      throw new HttpError(400, 'eventType is required for event routines');
    }
    input.eventType = body.eventType.trim();
  }
  return input;
}

function parseRoutinePatch(body: Record<string, unknown>): Partial<RoutineInput> {
  const patch: Partial<RoutineInput> = {};
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 80) {
      throw new HttpError(400, 'name must be 1-80 characters');
    }
    patch.name = body.name.trim();
  }
  if (body.prompt !== undefined) {
    if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
      throw new HttpError(400, 'prompt must be non-empty');
    }
    patch.prompt = body.prompt;
  }
  if (body.scheduleKind !== undefined) {
    if (body.scheduleKind !== 'cron' && body.scheduleKind !== 'interval' && body.scheduleKind !== 'event') {
      throw new HttpError(400, 'scheduleKind must be cron, interval, or event');
    }
    patch.scheduleKind = body.scheduleKind;
  }
  if (body.sessionId !== undefined) {
    if (body.sessionId !== null && typeof body.sessionId !== 'string') {
      throw new HttpError(400, 'sessionId must be string or null');
    }
    patch.sessionId = body.sessionId as string | null;
  }
  if (body.cronExpr !== undefined) {
    patch.cronExpr = typeof body.cronExpr === 'string' ? body.cronExpr : null;
  }
  if (body.intervalMs !== undefined) {
    patch.intervalMs = body.intervalMs === null ? null : Number(body.intervalMs);
  }
  if (body.eventType !== undefined) {
    patch.eventType = typeof body.eventType === 'string' ? body.eventType : null;
  }
  if (body.enabled !== undefined) {
    patch.enabled = Boolean(body.enabled);
  }
  return patch;
}

function looksMaskedSecret(value: string): boolean {
  return value.includes('*') || value.startsWith('****');
}

async function resolveApiKeyForWrite(
  store: ConversationStore,
  userId: string,
  submitted: string,
): Promise<string> {
  const trimmed = submitted.trim();
  if (!looksMaskedSecret(trimmed) && trimmed.length > 0) {
    return trimmed;
  }
  const existing = await store.getUserModelConfig?.(userId);
  if (existing?.apiKey) return existing.apiKey;
  throw new HttpError(400, 'apiKey is required (masked placeholder cannot create a new key)');
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  return value as Record<string, unknown>;
}

/** 只透传对产物页面有意义的请求头 */
function pickRequestHeaders(request: IncomingMessage): Record<string, string> {
  const picked: Record<string, string> = {};
  const contentType = request.headers['content-type'];
  if (typeof contentType === 'string') picked['content-type'] = contentType;
  const accept = request.headers.accept;
  if (typeof accept === 'string') picked.accept = accept;
  return picked;
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: ControlServerOptions,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://control.local');
  if (request.method === 'GET' && url.pathname === '/healthz') {
    sendJson(response, 200, { status: 'ok' });
    return;
  }

  // 产物预览公网路由：/p/<token>/<path> → Pod loopback。
  // 凭不可猜测令牌访问（无 API 鉴权），令牌由桌面端「打开产物」动作生成。
  const previewMatch = /^\/p\/([0-9a-f]{32,128})(\/.*)?$/.exec(url.pathname);
  if (
    previewMatch &&
    (request.method === 'GET' || request.method === 'POST' || request.method === 'HEAD')
  ) {
    const route = options.previewRoutes?.get(previewMatch[1]);
    if (!route || Date.now() - route.createdAt > PREVIEW_ROUTE_TTL_MS) {
      options.previewRoutes?.delete(previewMatch[1]);
      sendJson(response, 404, { error: 'PREVIEW_ROUTE_NOT_FOUND' });
      return;
    }
    let bodyBase64: string | undefined;
    if (request.method === 'POST') {
      bodyBase64 = (await readRawBody(request, PREVIEW_BODY_LIMIT_BYTES)).toString('base64');
    }
    const previewResponse = await options.toolRouter.previewFetch(route.userId, {
      requestId: randomUUID(),
      port: route.podPort,
      method: request.method,
      path: `${previewMatch[2] ?? '/'}${url.search}`,
      headers: pickRequestHeaders(request),
      ...(bodyBase64 ? { bodyBase64 } : {}),
    });
    const body = Buffer.from(previewResponse.bodyBase64 ?? '', 'base64');
    const responseHeaders: Record<string, string> = { 'x-robots-tag': 'noindex' };
    const contentType = previewResponse.headers['content-type'];
    if (contentType) responseHeaders['content-type'] = contentType;
    responseHeaders['content-length'] = String(body.byteLength);
    response.writeHead(previewResponse.status, responseHeaders);
    response.end(request.method === 'HEAD' ? undefined : body);
    return;
  }

  const userId = options.authenticate(request.headers.authorization);
  if (!userId) {
    sendJson(response, 401, { error: 'UNAUTHENTICATED' });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/v1/machines') {
    sendJson(response, 200, {
      machines: options.toolRouter.listConnectedMachines(userId),
      selectedMachineId: await options.store.getSelectedMachineId(userId),
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/v1/runtimes') {
    sendJson(response, 200, {
      runtimes: options.toolRouter.listConnectedRuntimes(userId),
      selectedRuntimeId: await options.store.getSelectedRuntimeId(userId),
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/v1/runtimes/selection') {
    const body = asObject(await readJsonBody(request));
    if (
      body.podId !== null &&
      (typeof body.podId !== 'string' || body.podId.length === 0)
    ) {
      throw new HttpError(400, 'podId must be a non-empty string or null');
    }
    const podId = body.podId as string | null;
    const previous = options.toolRouter.getSelectedRuntimeId(userId);
    if (!options.toolRouter.selectRuntime(userId, podId)) {
      sendJson(response, 404, { error: 'RUNTIME_NOT_FOUND' });
      return;
    }
    try {
      await options.store.setSelectedRuntimeId(userId, podId);
    } catch (error) {
      options.toolRouter.restoreRuntimeSelection(userId, previous);
      throw error;
    }
    sendJson(response, 200, { selectedRuntimeId: podId });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/v1/machines/selection') {
    const body = asObject(await readJsonBody(request));
    if (
      body.machineId !== null &&
      (typeof body.machineId !== 'string' || body.machineId.length === 0)
    ) {
      throw new HttpError(400, 'machineId must be a non-empty string or null');
    }
    const machineId = body.machineId;
    const previousMachineId = options.toolRouter.getSelectedMachineId(userId);
    if (!options.toolRouter.selectMachine(userId, machineId)) {
      sendJson(response, 404, { error: 'MACHINE_NOT_FOUND' });
      return;
    }
    try {
      await options.store.setSelectedMachineId(userId, machineId);
    } catch (error) {
      options.toolRouter.restoreMachineSelection(userId, previousMachineId);
      throw error;
    }
    sendJson(response, 200, { selectedMachineId: machineId });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/v1/sessions') {
    sendJson(response, 200, { sessions: await options.store.listSessions(userId) });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/v1/sessions') {
    const body = asObject(await readJsonBody(request));
    const title = body.title === undefined ? 'New conversation' : body.title;
    if (
      typeof title !== 'string' ||
      title.trim().length === 0 ||
      title.length > MAX_TITLE_LENGTH
    ) {
      throw new HttpError(400, `title must be 1-${MAX_TITLE_LENGTH} characters`);
    }
    const session = await options.store.createSession(userId, title.trim());
    try {
      await options.onSessionCreated?.(userId, session.id);
    } catch (error) {
      console.error(
        '[control-api] onSessionCreated failed:',
        error instanceof Error ? error.message : 'unknown error',
      );
    }
    sendJson(response, 201, session);
    return;
  }

  const sessionDetail = /^\/v1\/sessions\/([^/]+)$/.exec(url.pathname);
  if (request.method === 'PATCH' && sessionDetail) {
    let sessionId: string;
    try {
      sessionId = decodeURIComponent(sessionDetail[1]);
    } catch {
      throw new HttpError(400, 'Invalid session ID');
    }
    const body = asObject(await readJsonBody(request));
    if (
      typeof body.title !== 'string' ||
      body.title.trim().length === 0 ||
      body.title.length > MAX_TITLE_LENGTH
    ) {
      throw new HttpError(400, `title must be 1-${MAX_TITLE_LENGTH} characters`);
    }
    const updated = await options.store.updateSessionTitle(userId, sessionId, body.title.trim());
    if (!updated) {
      sendJson(response, 404, { error: 'SESSION_NOT_FOUND' });
      return;
    }
    sendJson(response, 200, updated);
    return;
  }

  if (request.method === 'DELETE' && sessionDetail) {
    let sessionId: string;
    try {
      sessionId = decodeURIComponent(sessionDetail[1]);
    } catch {
      throw new HttpError(400, 'Invalid session ID');
    }
    let deleted: boolean;
    try {
      deleted = await options.store.deleteSession(userId, sessionId);
    } catch (error) {
      if (error instanceof SessionBusyError) {
        sendJson(response, 409, { error: 'SESSION_RUN_IN_PROGRESS' });
        return;
      }
      throw error;
    }
    if (!deleted) {
      sendJson(response, 404, { error: 'SESSION_NOT_FOUND' });
      return;
    }
    response.writeHead(204);
    response.end();
    return;
  }

  if (url.pathname === '/v1/models/config') {
    if (request.method === 'GET') {
      const userConfig = await options.store.getUserModelConfig?.(userId);
      const effectiveKey = userConfig?.apiKey ?? process.env.AGENT_API_KEY ?? '';
      sendJson(response, 200, {
        provider: userConfig?.provider ?? process.env.AGENT_PROVIDER ?? 'openai-compatible',
        apiBaseUrl: userConfig?.apiBaseUrl ?? process.env.AGENT_API_BASE_URL ?? 'https://open.bigmodel.cn/api/coding/paas/v4',
        apiKey: maskSecret(effectiveKey),
        apiKeyMasked: true,
        hasApiKey: hasSecret(effectiveKey),
        model: userConfig?.model ?? process.env.AGENT_MODEL ?? 'glm-5.3-flash',
        isConfigured: Boolean((userConfig?.apiKey && userConfig?.model) || (process.env.AGENT_API_KEY && process.env.AGENT_MODEL)),
      });
      return;
    }
    if (request.method === 'POST' || request.method === 'PUT') {
      const body = asObject(await readJsonBody(request));
      if (typeof body.provider !== 'string' || !body.provider) {
        throw new HttpError(400, 'provider is required');
      }
      if (typeof body.apiBaseUrl !== 'string' || !body.apiBaseUrl) {
        throw new HttpError(400, 'apiBaseUrl is required');
      }
      if (typeof body.apiKey !== 'string' || !body.apiKey) {
        throw new HttpError(400, 'apiKey is required');
      }
      if (typeof body.model !== 'string' || !body.model) {
        throw new HttpError(400, 'model is required');
      }
      const apiKey = await resolveApiKeyForWrite(options.store, userId, String(body.apiKey));
      await options.store.setUserModelConfig?.(userId, {
        provider: body.provider.trim(),
        apiBaseUrl: body.apiBaseUrl.trim(),
        apiKey,
        model: body.model.trim(),
      });
      sendJson(response, 200, {
        status: 'ok',
        provider: body.provider.trim(),
        apiBaseUrl: body.apiBaseUrl.trim(),
        model: body.model.trim(),
      });
      return;
    }
  }

  // 多套模型配置档案：保存多组供应商/密钥/模型，启用后供云端 Agent 使用
  const modelProfileAction = /^\/v1\/models\/configs\/([^/]+)\/activate$/.exec(url.pathname);
  const modelProfileDetail = /^\/v1\/models\/configs\/([^/]+)$/.exec(url.pathname);
  if (url.pathname === '/v1/models/configs' && request.method === 'GET') {
    const profiles = await options.store.listModelProfiles(userId);
    sendJson(response, 200, {
      profiles: profiles.map((profile) => ({
        ...profile,
        apiKey: maskSecret(profile.apiKey),
        apiKeyMasked: true,
        hasApiKey: hasSecret(profile.apiKey),
      })),
    });
    return;
  }
  if (url.pathname === '/v1/models/configs' && request.method === 'POST') {
    const body = asObject(await readJsonBody(request));
    for (const field of ['name', 'provider', 'apiBaseUrl', 'apiKey', 'model'] as const) {
      if (typeof body[field] !== 'string' || !(body[field] as string).trim()) {
        throw new HttpError(400, `${field} is required`);
      }
    }
    const name = (body.name as string).trim();
    if (name.length > 40) {
      throw new HttpError(400, 'name must be 1-40 characters');
    }
    let apiKey = (body.apiKey as string).trim();
    if (looksMaskedSecret(apiKey)) {
      const existingProfiles = await options.store.listModelProfiles(userId);
      const prior = existingProfiles.find((item) => item.name === name);
      if (!prior?.apiKey) {
        throw new HttpError(400, 'apiKey is required (masked placeholder cannot create a new profile)');
      }
      apiKey = prior.apiKey;
    }
    const profile = await options.store.saveModelProfile(userId, {
      name,
      provider: (body.provider as string).trim(),
      apiBaseUrl: (body.apiBaseUrl as string).trim(),
      apiKey,
      model: (body.model as string).trim(),
    });
    sendJson(response, 201, {
      ...profile,
      apiKey: maskSecret(profile.apiKey),
      apiKeyMasked: true,
      hasApiKey: hasSecret(profile.apiKey),
    });
    return;
  }
  if (request.method === 'POST' && modelProfileAction) {
    let profileId: string;
    try {
      profileId = decodeURIComponent(modelProfileAction[1]);
    } catch {
      throw new HttpError(400, 'Invalid profile ID');
    }
    const profile = await options.store.activateModelProfile(userId, profileId);
    if (!profile) {
      sendJson(response, 404, { error: 'MODEL_PROFILE_NOT_FOUND' });
      return;
    }
    sendJson(response, 200, {
      status: 'active',
      profile: {
        ...profile,
        apiKey: maskSecret(profile.apiKey),
        apiKeyMasked: true,
        hasApiKey: hasSecret(profile.apiKey),
      },
    });
    return;
  }
  if (request.method === 'DELETE' && modelProfileDetail) {
    let profileId: string;
    try {
      profileId = decodeURIComponent(modelProfileDetail[1]);
    } catch {
      throw new HttpError(400, 'Invalid profile ID');
    }
    const deleted = await options.store.deleteModelProfile(userId, profileId);
    if (!deleted) {
      sendJson(response, 404, { error: 'MODEL_PROFILE_NOT_FOUND' });
      return;
    }
    response.writeHead(204);
    response.end();
    return;
  }

  // 打开产物：读取会话工作区的 .port，生成公网预览路由令牌
  if (url.pathname === '/v1/preview/open' && request.method === 'POST') {
    const body = asObject(await readJsonBody(request));
    const sessionId = body.sessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new HttpError(400, 'sessionId is required');
    }
    const owned = (await options.store.listSessions(userId)).some((session) => session.id === sessionId);
    if (!owned) {
      sendJson(response, 404, { error: 'SESSION_NOT_FOUND' });
      return;
    }
    const portResult = await options.toolRouter.requestCloudTool(
      userId,
      'fs.read',
      { path: `sessions/${sessionId}/.port` },
      60_000,
      { runId: 'ui', sessionId: 'ui' },
      undefined,
      { skipAudit: true },
    );
    if (!portResult.ok) {
      sendJson(response, 404, {
        error: 'ARTIFACT_NOT_RUNNING',
        message: portResult.error.message,
      });
      return;
    }
    const content = typeof (portResult.data as { content?: unknown }).content === 'string'
      ? (portResult.data as { content: string }).content.trim()
      : '';
    const podPort = Number(content);
    if (!Number.isInteger(podPort) || podPort < 1024 || podPort > 65535) {
      sendJson(response, 409, { error: 'ARTIFACT_PORT_INVALID' });
      return;
    }
    const token = randomBytes(24).toString('hex');
    options.previewRoutes?.set(token, {
      userId,
      sessionId,
      podPort,
      createdAt: Date.now(),
    });
    sendJson(response, 200, {
      url: `${options.previewPublicBaseUrl}/p/${token}/`,
      port: podPort,
    });
    return;
  }

  // 桌面端 UI 直连的只读工具通道：白名单硬编码，双重防线（客户端还有一份）
  if (url.pathname === '/v1/tools/execute' && request.method === 'POST') {
    const body = asObject(await readJsonBody(request));
    const tool = body.tool;
    if (typeof tool !== 'string' || !UI_ALLOWED_CLOUD_TOOLS.has(tool)) {
      throw new HttpError(400, 'tool is not allowed on the UI channel');
    }
    const args = body.args;
    if (args === undefined || args === null || typeof args !== 'object') {
      throw new HttpError(400, 'args must be an object');
    }
    const requestId = randomUUID();
    await options.store.recordUiToolCallStarted({
      requestId,
      userId,
      tool: tool as ToolName,
    });
    const timeoutMs = tool === 'browser.use' ? 120_000 : 60_000;
    const result = await options.toolRouter.requestCloudTool(
      userId,
      tool as ToolName,
      args,
      timeoutMs,
      { runId: 'ui', sessionId: 'ui' },
      undefined,
      { skipAudit: true },
    );
    const status = result.ok
      ? 'completed'
      : result.error.code === 'TIMEOUT'
        ? 'timed_out'
        : result.error.code === 'ABORTED'
          ? 'cancelled'
          : 'failed';
    await options.store.recordUiToolCallStatus({
      requestId,
      userId,
      status,
      resultCode: result.ok ? undefined : result.error.code,
    });
    sendJson(response, 200, result);
    return;
  }

  const runStatus = /^\/v1\/runs\/([^/]+)$/.exec(url.pathname);
  const cancelRun = /^\/v1\/runs\/([^/]+)\/cancel$/.exec(url.pathname);
  if (request.method === 'POST' && cancelRun) {
    let runId: string;
    try {
      runId = decodeURIComponent(cancelRun[1]);
    } catch {
      throw new HttpError(400, 'Invalid run ID');
    }
    const run = await options.store.cancelRun(userId, runId);
    if (!run) {
      sendJson(response, 404, { error: 'RUN_NOT_FOUND' });
      return;
    }
    if (run.status === 'cancelled') {
      options.cancelRun?.(runId);
      sendJson(response, 200, run);
      return;
    }
    if (run.status === 'queued' || run.status === 'running') {
      sendJson(response, 409, { error: 'RUN_CANCELLATION_FAILED' });
      return;
    }
    sendJson(response, 409, { error: 'RUN_NOT_CANCELLABLE' });
    return;
  }

  if (request.method === 'GET' && runStatus) {
    let runId: string;
    try {
      runId = decodeURIComponent(runStatus[1]);
    } catch {
      throw new HttpError(400, 'Invalid run ID');
    }
    const run = await options.store.getRun(userId, runId);
    if (!run) {
      sendJson(response, 404, { error: 'RUN_NOT_FOUND' });
      return;
    }
    sendJson(response, 200, run);
    return;
  }

  const sessionMessages = /^\/v1\/sessions\/([^/]+)\/messages$/.exec(url.pathname);
  if (sessionMessages) {
    let sessionId: string;
    try {
      sessionId = decodeURIComponent(sessionMessages[1]);
    } catch {
      throw new HttpError(400, 'Invalid session ID');
    }

    if (request.method === 'GET') {
      const messages = await options.store.listMessages(userId, sessionId);
      if (messages === null) {
        sendJson(response, 404, { error: 'SESSION_NOT_FOUND' });
        return;
      }
      sendJson(response, 200, { messages });
      return;
    }

    if (request.method === 'POST') {
      const body = asObject(await readJsonBody(request));
      if (
        typeof body.text !== 'string' ||
        body.text.trim().length === 0 ||
        body.text.length > MAX_MESSAGE_LENGTH
      ) {
        throw new HttpError(400, `text must be 1-${MAX_MESSAGE_LENGTH} characters`);
      }
      let accepted: AcceptedMessage | null;
      try {
        accepted = await options.store.appendUserMessage(
          userId,
          sessionId,
          body.text,
        );
      } catch (error) {
        if (error instanceof SessionBusyError) {
          sendJson(response, 409, { error: 'SESSION_RUN_IN_PROGRESS' });
          return;
        }
        throw error;
      }
      if (accepted === null) {
        sendJson(response, 404, { error: 'SESSION_NOT_FOUND' });
        return;
      }
      options.toolRouter.publishSessionDelta(userId, sessionId, {
        kind: 'message.created',
        runId: accepted.run.id,
        message: {
          id: accepted.message.id,
          sequence: accepted.message.sequence,
          role: accepted.message.role,
          text: accepted.message.text,
          createdAt: accepted.message.createdAt,
        },
        at: new Date().toISOString(),
      });
      options.toolRouter.publishSessionDelta(userId, sessionId, {
        kind: 'run.status',
        runId: accepted.run.id,
        status: 'queued',
        at: new Date().toISOString(),
      });
      sendJson(response, 202, accepted);
      return;
    }
  }

  // ---- Long-term memory ----
  if (request.method === 'GET' && url.pathname === '/v1/memories') {
    sendJson(response, 200, { memories: await options.store.listMemories(userId) });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v1/memories') {
    const body = asObject(await readJsonBody(request));
    if (typeof body.key !== 'string' || !body.key.trim() || body.key.length > 120) {
      throw new HttpError(400, 'key must be 1-120 characters');
    }
    if (typeof body.content !== 'string' || !body.content.trim() || body.content.length > 8000) {
      throw new HttpError(400, 'content must be 1-8000 characters');
    }
    const importance = body.importance === undefined ? 0 : Number(body.importance);
    if (!Number.isInteger(importance) || importance < 0 || importance > 100) {
      throw new HttpError(400, 'importance must be an integer 0-100');
    }
    const memory = await options.store.upsertMemory(userId, {
      key: body.key.trim(),
      content: body.content,
      importance,
    });
    sendJson(response, 201, memory);
    return;
  }
  const memoryDetail = /^\/v1\/memories\/([^/]+)$/.exec(url.pathname);
  if (request.method === 'DELETE' && memoryDetail) {
    let memoryId: string;
    try {
      memoryId = decodeURIComponent(memoryDetail[1]);
    } catch {
      throw new HttpError(400, 'Invalid memory ID');
    }
    const deleted = await options.store.deleteMemory(userId, memoryId);
    if (!deleted) {
      sendJson(response, 404, { error: 'MEMORY_NOT_FOUND' });
      return;
    }
    response.writeHead(204);
    response.end();
    return;
  }

  // ---- Routines / scheduler ----
  if (request.method === 'GET' && url.pathname === '/v1/routines') {
    sendJson(response, 200, { routines: await options.store.listRoutines(userId) });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v1/routines') {
    const body = asObject(await readJsonBody(request));
    const input = parseRoutineBody(body);
    try {
      const routine = await options.store.createRoutine(userId, input);
      sendJson(response, 201, routine);
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : 'Invalid routine');
    }
    return;
  }
  const routineDetail = /^\/v1\/routines\/([^/]+)$/.exec(url.pathname);
  if (request.method === 'PATCH' && routineDetail) {
    let routineId: string;
    try {
      routineId = decodeURIComponent(routineDetail[1]);
    } catch {
      throw new HttpError(400, 'Invalid routine ID');
    }
    const body = asObject(await readJsonBody(request));
    try {
      const updated = await options.store.updateRoutine(userId, routineId, parseRoutinePatch(body));
      if (!updated) {
        sendJson(response, 404, { error: 'ROUTINE_NOT_FOUND' });
        return;
      }
      sendJson(response, 200, updated);
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : 'Invalid routine');
    }
    return;
  }
  if (request.method === 'DELETE' && routineDetail) {
    let routineId: string;
    try {
      routineId = decodeURIComponent(routineDetail[1]);
    } catch {
      throw new HttpError(400, 'Invalid routine ID');
    }
    const deleted = await options.store.deleteRoutine(userId, routineId);
    if (!deleted) {
      sendJson(response, 404, { error: 'ROUTINE_NOT_FOUND' });
      return;
    }
    response.writeHead(204);
    response.end();
    return;
  }

  sendJson(response, 404, { error: 'NOT_FOUND' });
}

export function createControlServer(options: ControlServerOptions): Server {
  // 产物预览路由令牌表：token → 访问目标；随进程重启失效（桌面重新点「打开产物」即重生成）
  const previewRoutes = new Map<string, PreviewRouteEntry>();
  const serverOptions: ControlServerOptions & { previewRoutes: Map<string, PreviewRouteEntry> } = {
    ...options,
    previewRoutes,
  };
  const server = createServer((request, response) => {
    void handleRequest(request, response, serverOptions).catch((error: unknown) => {
      if (error instanceof HttpError) {
        sendJson(response, error.statusCode, { error: error.message });
        return;
      }
      console.error(
        '[control-api] request failed:',
        error instanceof Error ? error.message : 'unknown error',
      );
      sendJson(response, 500, { error: 'INTERNAL' });
    });
  });
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WS_PAYLOAD_BYTES,
  });
  const connectionPrincipals = new WeakMap<
    WebSocket,
    { role: 'user'; userId: string } | { role: 'runtime'; identity: CloudRuntimeIdentity }
  >();

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://control.local');
    if (url.pathname !== '/v1/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const userId = options.authenticate(request.headers.authorization);
    const runtimeIdentity = options.authenticateRuntime?.(
      request.headers.authorization,
    ) ?? null;
    if (userId && runtimeIdentity) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const principal = runtimeIdentity
      ? { role: 'runtime' as const, identity: runtimeIdentity }
      : userId
        ? { role: 'user' as const, userId }
        : null;
    if (!principal) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      connectionPrincipals.set(webSocket, principal);
      webSocketServer.emit('connection', webSocket, request);
    });
  });

  webSocketServer.on('connection', (webSocket) => {
    const principal = connectionPrincipals.get(webSocket);
    if (!principal) {
      webSocket.close(1008, 'Authentication required');
      return;
    }
    let registeredMachineId: string | null = null;
    let registeredRuntimePodId: string | null = null;
    let registrationStarted = false;
    let registeringIdentity: string | null = null;

    webSocket.on('message', (data) => {
      let value: unknown;
      try {
        value = JSON.parse(data.toString()) as unknown;
      } catch {
        webSocket.close(1007, 'Invalid JSON');
        return;
      }
      const parsed = ClientToServerMessageSchema.safeParse(value);
      if (!parsed.success) {
        webSocket.close(1008, 'Invalid client message');
        return;
      }

      const message: ClientToServerMessage = parsed.data;
      if (message.type === 'runtime.hello') {
        const hello: RuntimeHelloMessage = message;
        if (
          principal.role !== 'runtime' ||
          hello.podId !== principal.identity.podId
        ) {
          webSocket.close(1008, 'Runtime identity does not match credentials');
          return;
        }
        if (registrationStarted) {
          if (registeringIdentity !== `runtime:${hello.podId}`) {
            webSocket.close(1008, 'A connection may register only one runtime');
          }
          return;
        }
        registrationStarted = true;
        registeringIdentity = `runtime:${hello.podId}`;
        void options.store
          .registerRuntime(
            principal.identity.userId,
            hello.podId,
            hello.capabilities,
          )
          .then(() => {
            registeredRuntimePodId = hello.podId;
            options.toolRouter.registerRuntime(
              principal.identity.userId,
              hello.podId,
              hello.capabilities,
              webSocket,
            );
            return options.store.getSelectedRuntimeId(principal.identity.userId);
          })
          .then((selectedRuntimeId) => {
            if (selectedRuntimeId) {
              options.toolRouter.restoreRuntimeSelection(
                principal.identity.userId,
                selectedRuntimeId,
              );
            }
          })
          .catch((error: unknown) => {
            console.error(
              '[control-api] runtime registration failed:',
              error instanceof Error ? error.message : 'unknown error',
            );
            webSocket.close(1011, 'Runtime registration failed');
          });
        return;
      }

      if (message.type === 'machine.hello') {
        const hello: MachineHelloMessage = message;
        if (principal.role !== 'user') {
          webSocket.close(1008, 'Runtime connection cannot register a machine');
          return;
        }
        if (registrationStarted) {
          if (registeringIdentity !== `machine:${hello.machineId}`) {
            webSocket.close(1008, 'A connection may register only one machine');
          }
          return;
        }
        registrationStarted = true;
        registeringIdentity = `machine:${hello.machineId}`;
        void options.store
          .registerMachine(
            principal.userId,
            hello.machineId,
            hello.label,
            hello.capabilities,
          )
          .then(() => {
            registeredMachineId = hello.machineId;
            options.toolRouter.registerMachine(
              principal.userId,
              hello.machineId,
              hello.capabilities,
              webSocket,
              hello.label,
            );
            return options.store.getSelectedMachineId(principal.userId);
          })
          .then((selectedMachineId) => {
            if (selectedMachineId) {
              options.toolRouter.restoreMachineSelection(
                principal.userId,
                selectedMachineId,
              );
            }
          })
          .catch((error: unknown) => {
            console.error(
              '[control-api] machine registration failed:',
              error instanceof Error ? error.message : 'unknown error',
            );
            webSocket.close(1011, 'Machine registration failed');
          });
        return;
      }

      if (
        message.type === 'ping' &&
        registeredRuntimePodId &&
        principal.role === 'runtime'
      ) {
        webSocket.send(JSON.stringify({ type: 'pong', ts: message.ts }));
        void options.store
          .touchRuntime(principal.identity.userId, registeredRuntimePodId)
          .catch((error: unknown) => {
            console.error(
              '[control-api] runtime heartbeat persistence failed:',
              error instanceof Error ? error.message : 'unknown error',
            );
            webSocket.close(1011, 'Runtime heartbeat persistence failed');
          });
        return;
      }

      if (message.type === 'ping' && registeredMachineId) {
        webSocket.send(JSON.stringify({ type: 'pong', ts: message.ts }));
        return;
      }

      if (message.type === 'tool.approval' && registeredMachineId) {
        void options.toolRouter.handleApproval(webSocket, message)
          .then((accepted) => {
            if (!accepted) console.warn('[control-api] ignored uncorrelated tool approval');
          })
          .catch((error: unknown) => {
            console.error(
              '[control-api] tool approval persistence failed:',
              error instanceof Error ? error.message : 'unknown error',
            );
            webSocket.close(1011, 'Tool approval persistence failed');
          });
        return;
      }

      if (
        message.type === 'tool.result' &&
        (registeredMachineId || registeredRuntimePodId)
      ) {
        void options.toolRouter.handleResult(webSocket, message)
          .then((accepted) => {
            if (!accepted) console.warn('[control-api] ignored uncorrelated tool result');
          })
          .catch((error: unknown) => {
            console.error(
              '[control-api] tool result persistence failed:',
              error instanceof Error ? error.message : 'unknown error',
            );
            webSocket.close(1011, 'Tool result persistence failed');
          });
        return;
      }

      if (message.type === 'preview.request' && registeredMachineId) {
        // 桌面本地代理来的产物预览请求：按 user→runtime 绑定转发
        if (principal.role === 'user') {
          options.toolRouter.relayPreviewRequest(principal.userId, message, webSocket);
        }
        return;
      }

      if (message.type === 'preview.response' && registeredRuntimePodId) {
        options.toolRouter.handlePreviewResponse(webSocket, message);
        return;
      }

      webSocket.close(1008, 'Message not supported in this API version');
    });
    webSocket.on('close', () => {
      options.toolRouter.unregisterMachine(webSocket);
      options.toolRouter.unregisterRuntime(webSocket);
    });
  });

  server.on('close', () => {
    for (const client of webSocketServer.clients) {
      client.terminate();
    }
    webSocketServer.close();
  });

  return server;
}
