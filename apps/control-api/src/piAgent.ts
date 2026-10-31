import os from 'node:os';
import path from 'node:path';
import type { ToolName } from '@lca/tool-protocol';
import type { AgentEngine } from './agentWorker';
import type {
  AgentPromptMessage,
  MemoryRecord,
  QueuedAgentRun,
  UserModelConfig,
} from './conversationStore';
import type { LocalToolRouter } from './toolRouter';

export interface PiAgentEngineOptions {
  provider: string;
  model: string;
  apiKey: string;
  apiBaseUrl: string;
  timeoutMs: number;
  getUserModelConfig?: (userId: string) => Promise<UserModelConfig | null>;
  getUserMemories?: (userId: string) => Promise<MemoryRecord[]>;
  memoryStore?: {
    upsertMemory(
      userId: string,
      input: { key: string; content: string; importance?: number },
    ): Promise<MemoryRecord>;
    deleteMemory(userId: string, memoryId: string): Promise<boolean>;
    listMemories(userId: string): Promise<MemoryRecord[]>;
  };
  toolRouter?: Pick<
    LocalToolRouter,
    | 'requestLocalTool'
    | 'requestCloudTool'
    | 'requestFilesCopy'
    | 'listConnectedMachines'
    | 'listConnectedRuntimes'
  >;
}

/** 产物路由与启动约定：与桌面端「预览」页签的 .port/.pid 规范配套（参见 README「云端产物预览」） */
export const AGENT_SYSTEM_PROMPT = [
  'You are TwinBot, a personal agent working inside the user\'s isolated cloud sandbox. Respond concisely and accurately.',
  '',
  '写入位置路由（严格遵守）：',
  '- 代码、网页、脚本、配置等「产物」默认写入云端工作区（cloud_fs_write / cloud_fs_edit）；用户没有指定位置时一律选云端。',
  '- 只有用户明确要求「保存到本机 / 存到我的电脑 / 写到 D 盘」等时，才使用 local_fs_write / local_fs_edit。',
  '- 把产物写入云端工作区后，提醒用户：可在桌面端「预览」页签点击「打开产物」查看运行效果。',
  '',
  '产物预览约定（用户要求「跑起来 / 预览 / 打开」某个项目时严格执行）：',
  '1. 读取工作区 .port 文件确定端口；不存在则写入一个 30000-39999 范围内的随机整数。',
  '2. 生成 start.sh：读取 .port 得到 $PORT；若 .pid 对应进程仍在运行则直接跳过启动；否则用 nohup 后台启动并把 $! 写入 .pid。静态站点直接用 python3 -m http.server "$PORT" --bind 127.0.0.1。',
  '3. 生成 stop.sh：按 .pid 与端口兜底清理进程。',
  '4. 启动后用 shell.exec 执行 curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:$PORT/ 自检，把状态码告诉用户。',
  '5. 告知用户：产物已启动，端口见 .port，可在桌面端「预览」页签点击「打开产物」查看。',
  '禁止把 .port/.pid 当作普通文件随意改写或删除；依赖必须在生成 start.sh 之前安装完毕。',
].join('\n');

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** 工具调用超时上限：默认 60s，长任务单独放宽（仍受 AGENT_TIMEOUT_MS 全局上限约束） */
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
const LONG_TOOL_TIMEOUT_MS = 120_000;
const CHECKPOINT_TOOL_TIMEOUT_MS = 300_000;

/**
 * typebox 是 ESM-only 包，CJS 模块只能运行时动态 import，
 * 因此用结构化类型描述本文件用到的 Type 构造器子集。
 */
interface ToolParameterSchema {
  type?: string;
  [key: string]: unknown;
}

interface TypeBoxTypeBuilder {
  Object(
    properties: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): ToolParameterSchema;
  Optional(schema: unknown): unknown;
  String(options?: Record<string, unknown>): unknown;
  Integer(options?: Record<string, unknown>): unknown;
  Boolean(options?: Record<string, unknown>): unknown;
  Literal(value: string): unknown;
  Union(schemas: unknown[]): unknown;
  Array(schema: unknown, options?: Record<string, unknown>): unknown;
}

/**
 * defineTool 与 createAgentSession 均来自 ESM-only 的 Pi SDK，
 * CJS 编译单元内无法引用其类型，边界处使用宽松签名，实际对象原样透传。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type DefineToolFn = (definition: any) => any;

interface AgentToolSpec {
  /** LLM 侧工具名：local_ / cloud_ 前缀，files_copy 为跨端复合工具 */
  name: string;
  label: string;
  description: string;
  plane: 'local' | 'cloud' | 'composite';
  tool: ToolName;
  /** 暴露该工具要求的执行面能力（本地为 MachineCapability，云端为 CloudRuntimeCapability） */
  capability: string;
  parameters: ToolParameterSchema;
  timeoutMs: number;
}

/**
 * 静态工具注册表：每个执行面工具一条描述，execute 由通用包装生成。
 * 新增工具时在此追加一条即可，无需再写 defineTool 闭包。
 */
function buildAgentToolRegistry(Type: TypeBoxTypeBuilder): AgentToolSpec[] {
  const local = (
    suffix: string,
    tool: ToolName,
    capability: string,
    description: string,
    parameters: AgentToolSpec['parameters'],
    timeoutMs = DEFAULT_TOOL_TIMEOUT_MS,
  ): AgentToolSpec => ({
    name: `local_${suffix}`,
    label: suffix,
    description: `Run ${tool} on the user-approved local machine. The user must approve each request. ${description}`,
    plane: 'local',
    tool,
    capability,
    parameters,
    timeoutMs,
  });

  const cloud = (
    suffix: string,
    tool: ToolName,
    capability: string,
    description: string,
    parameters: AgentToolSpec['parameters'],
    timeoutMs = DEFAULT_TOOL_TIMEOUT_MS,
  ): AgentToolSpec => ({
    name: `cloud_${suffix}`,
    label: suffix,
    description: `Run ${tool} inside the user cloud runtime sandbox. Use a relative path from the sandbox root. ${description}`,
    plane: 'cloud',
    tool,
    capability,
    parameters,
    timeoutMs,
  });

  const fsReadParams = () =>
    Type.Object({
      path: Type.String({ minLength: 1 }),
      encoding: Type.Optional(Type.Union([Type.Literal('utf8'), Type.Literal('base64')])),
    });

  const globParams = () =>
    Type.Object({
      pattern: Type.String({ minLength: 1 }),
      path: Type.Optional(Type.String()),
    });

  const grepParams = () =>
    Type.Object({
      pattern: Type.String({ minLength: 1 }),
      path: Type.Optional(Type.String()),
      maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
      caseSensitive: Type.Optional(Type.Boolean()),
    });

  const notebookReadParams = () =>
    Type.Object({
      path: Type.String({ minLength: 1 }),
    });

  const notebookEditParams = () =>
    Type.Object({
      path: Type.String({ minLength: 1 }),
      mode: Type.Union([Type.Literal('replace'), Type.Literal('insert'), Type.Literal('delete')]),
      cellIndex: Type.Integer({ minimum: 0 }),
      cellContent: Type.Optional(Type.String()),
      cellType: Type.Optional(
        Type.Union([Type.Literal('code'), Type.Literal('markdown'), Type.Literal('raw')]),
      ),
    });

  return [
    local('fs_read', 'fs.read', 'fs', 'Read a text or base64-encoded file.', fsReadParams()),
    local('fs_list', 'fs.list', 'fs', 'List entries of a directory.', Type.Object({
      path: Type.String({ minLength: 1 }),
    })),
    local('fs_write', 'fs.write', 'fs', 'Write (or overwrite) a file on the user\'s own computer. Use ONLY when the user explicitly asks to save on their local machine; generated code and web artifacts belong to the cloud workspace.', Type.Object({
      path: Type.String({ minLength: 1 }),
      content: Type.String(),
      encoding: Type.Optional(Type.Union([Type.Literal('utf8'), Type.Literal('base64')])),
      createDirs: Type.Optional(Type.Boolean()),
    })),
    local('fs_edit', 'fs.edit', 'fs', 'Replace an exact unique text snippet in a file.', Type.Object({
      path: Type.String({ minLength: 1 }),
      oldText: Type.String({ minLength: 1 }),
      newText: Type.String(),
      replaceAll: Type.Optional(Type.Boolean()),
    })),
    local('fs_glob', 'fs.glob', 'fs', 'Match files by glob pattern (supports **, *, ?, {a,b}, [a-z]).', globParams()),
    local('fs_grep', 'fs.grep', 'fs', 'Regex search across files, returning line matches.', grepParams()),
    local('shell_exec', 'shell.exec', 'shell', 'Execute a shell command on the local machine.', Type.Object({
      command: Type.String({ minLength: 1 }),
      cwd: Type.Optional(Type.String()),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 300_000 })),
    })),
    local('user_ask', 'user.ask', 'ask', 'Ask the local user a question with optional choices and free text. Use when information is missing or a decision is required.', Type.Object({
      question: Type.String({ minLength: 1 }),
      choices: Type.Optional(Type.Array(Type.String(), { maxItems: 6 })),
      allowFreeText: Type.Optional(Type.Boolean()),
    })),
    local('notebook_read', 'notebook.read', 'fs', 'Read cells of a Jupyter notebook (.ipynb).', notebookReadParams()),
    local('notebook_edit', 'notebook.edit', 'fs', 'Insert, replace or delete a cell of a Jupyter notebook.', notebookEditParams()),

    cloud('fs_read', 'fs.read', 'fs', 'Read a text or base64-encoded file.', fsReadParams()),
    cloud('fs_list', 'fs.list', 'fs', 'List entries of a directory. Use "." for the sandbox root.', Type.Object({
      path: Type.String({ minLength: 1 }),
    })),
    cloud('fs_write', 'fs.write', 'fs', 'Write (or overwrite) a file; set createDirs to make parent directories. This is the DEFAULT destination for generated code, web pages, scripts and other artifacts.', Type.Object({
      path: Type.String({ minLength: 1 }),
      content: Type.String(),
      encoding: Type.Optional(Type.Union([Type.Literal('utf8'), Type.Literal('base64')])),
      createDirs: Type.Optional(Type.Boolean()),
    })),
    cloud('fs_edit', 'fs.edit', 'fs', 'Replace an exact unique text snippet in a file.', Type.Object({
      path: Type.String({ minLength: 1 }),
      oldText: Type.String({ minLength: 1 }),
      newText: Type.String(),
      replaceAll: Type.Optional(Type.Boolean()),
    })),
    cloud('fs_glob', 'fs.glob', 'fs', 'Match files by glob pattern (supports **, *, ?, {a,b}, [a-z]).', globParams()),
    cloud('fs_grep', 'fs.grep', 'fs', 'Regex search across files, returning line matches.', grepParams()),
    cloud('shell_exec', 'shell.exec', 'shell', 'Execute a shell command inside the sandbox.', Type.Object({
      command: Type.String({ minLength: 1 }),
      cwd: Type.Optional(Type.String()),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 300_000 })),
    })),
    cloud('code_run', 'code.run', 'code', 'Execute a short Python, Node.js or Bash script in an isolated scratch directory and get its output.', Type.Object({
      language: Type.Union([Type.Literal('python'), Type.Literal('node'), Type.Literal('bash')]),
      code: Type.String({ minLength: 1 }),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 300_000 })),
    }), LONG_TOOL_TIMEOUT_MS),
    cloud('web_fetch', 'web.fetch', 'web', 'Fetch one http(s) URL and return its body (text or base64).', Type.Object({
      url: Type.String({ minLength: 1 }),
      maxBytes: Type.Optional(Type.Integer({ minimum: 1024 })),
    })),
    cloud('web_search', 'web.search', 'web', 'Search the web and return ranked result titles, URLs and snippets.', Type.Object({
      query: Type.String({ minLength: 1 }),
      count: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
    })),
    cloud('browser_use', 'browser.use', 'browser', 'Drive a headless Chromium: goto / click / type / screenshot / close. Screenshot returns a base64 PNG.', Type.Object({
      action: Type.Union([
        Type.Literal('goto'),
        Type.Literal('click'),
        Type.Literal('type'),
        Type.Literal('screenshot'),
        Type.Literal('close'),
      ]),
      url: Type.Optional(Type.String()),
      selector: Type.Optional(Type.String()),
      text: Type.Optional(Type.String()),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 120_000 })),
    }), LONG_TOOL_TIMEOUT_MS),
    cloud('notebook_read', 'notebook.read', 'fs', 'Read cells of a Jupyter notebook (.ipynb).', notebookReadParams()),
    cloud('notebook_edit', 'notebook.edit', 'fs', 'Insert, replace or delete a cell of a Jupyter notebook.', notebookEditParams()),
    cloud('lsp_query', 'lsp.query', 'lsp', 'TypeScript/JavaScript language queries: definition, references or type at a 0-based line/character position.', Type.Object({
      action: Type.Union([Type.Literal('definition'), Type.Literal('references'), Type.Literal('type')]),
      path: Type.String({ minLength: 1 }),
      line: Type.Integer({ minimum: 0 }),
      character: Type.Integer({ minimum: 0 }),
    })),
    cloud('vcs_checkpoint', 'vcs.checkpoint', 'vcs', 'Create, restore or list workspace snapshots. Create before risky bulk edits; restore replaces workspace contents.', Type.Object({
      op: Type.Union([Type.Literal('create'), Type.Literal('restore'), Type.Literal('list')]),
      id: Type.Optional(Type.String()),
      label: Type.Optional(Type.String()),
    }), CHECKPOINT_TOOL_TIMEOUT_MS),

    {
      name: 'files_copy',
      label: 'Copy file between local machine and cloud runtime',
      description: 'Copy a file between the user-approved local machine and the cloud runtime sandbox (direction: local-to-cloud or cloud-to-local).',
      plane: 'composite',
      tool: 'files.copy',
      capability: 'fs',
      parameters: Type.Object({
        source: Type.String({ minLength: 1 }),
        destination: Type.String({ minLength: 1 }),
        direction: Type.Union([Type.Literal('local-to-cloud'), Type.Literal('cloud-to-local')]),
      }),
      timeoutMs: LONG_TOOL_TIMEOUT_MS,
    },
  ];
}

export class PiAgentEngine implements AgentEngine {
  constructor(private readonly options: PiAgentEngineOptions) {}

  async generate(
    messages: AgentPromptMessage[],
    context?: QueuedAgentRun,
    signal?: AbortSignal,
  ): Promise<string> {
    const currentMessage = messages.at(-1);
    if (!currentMessage || currentMessage.role !== 'user') {
      throw new Error('Pi agent requires a user message as the latest turn');
    }
    if (this.options.toolRouter && !context) {
      throw new Error('Pi local tool routing requires an agent run context');
    }

    const {
      createAgentSession,
      DefaultResourceLoader,
      defineTool,
      ModelRuntime,
      SessionManager,
      SettingsManager,
    } = await import('@earendil-works/pi-coding-agent');
    const { Type } = await import('typebox');
    const cwd = process.cwd();
    const agentDir = path.join(os.tmpdir(), 'twinbot-pi-agent');
    const modelRuntime = await ModelRuntime.create({
      modelsPath: null,
      refreshOnCreate: false,
    });

    let activeProvider = this.options.provider;
    let activeModelId = this.options.model;
    let activeApiKey = this.options.apiKey;
    let activeApiBaseUrl = this.options.apiBaseUrl;

    if (context?.userId && this.options.getUserModelConfig) {
      try {
        const userConfig = await this.options.getUserModelConfig(context.userId);
        if (userConfig?.apiKey && userConfig?.model) {
          activeProvider = userConfig.provider || 'openai-compatible';
          activeModelId = userConfig.model;
          activeApiKey = userConfig.apiKey;
          if (userConfig.apiBaseUrl) {
            activeApiBaseUrl = userConfig.apiBaseUrl;
          }
        }
      } catch (err) {
        console.warn('[pi-agent] failed to load user model config, fallback to default:', err);
      }
    }

    if (activeProvider === 'openai-compatible') {
      modelRuntime.registerProvider(activeProvider, {
        name: 'TwinBot OpenAI-compatible',
        api: 'openai-completions',
        apiKey: activeApiKey,
        baseUrl: activeApiBaseUrl,
        models: [{
          id: activeModelId,
          name: activeModelId,
          api: 'openai-completions',
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          reasoning: false,
          contextWindow: 128_000,
          maxTokens: 8_192,
        }],
      });
    } else {
      modelRuntime.registerProvider(activeProvider, {
        apiKey: activeApiKey,
      });
    }

    const model = modelRuntime.getModel(activeProvider, activeModelId);
    if (!model) {
      throw new Error(
        `Pi model not found: ${activeProvider}/${activeModelId}`,
      );
    }
    // 会话隔离：每个会话的产物写到工作区独立目录，.port 互不冲突
    const sessionDir = context?.sessionId ? `sessions/${context.sessionId}/` : null;
    let memoryBlock = '';
    if (context?.userId && this.options.getUserMemories) {
      try {
        const memories = await this.options.getUserMemories(context.userId);
        if (memories.length > 0) {
          memoryBlock = '\n\nKnown user memories (durable preferences/facts):\n' +
            memories
              .slice(0, 40)
              .map((m) => `- [${m.key}] ${m.content}`)
              .join('\n');
        }
      } catch (error) {
        console.warn(
          '[pi-agent] failed to load memories:',
          error instanceof Error ? error.message : 'unknown error',
        );
      }
    }

    const systemPrompt = sessionDir
      ? `${AGENT_SYSTEM_PROMPT}${memoryBlock}
        
        当前会话工作目录：${sessionDir}（本会话的全部产物——项目代码、.port、.pid、start.sh——都必须写到该目录下，cloud_fs_write 的路径以它为前缀）。
        写 .port 前先确认端口未被占用：用 shell.exec 执行 ss -ltn | grep ":$PORT"，有输出则换一个随机端口再写。`
      : `${AGENT_SYSTEM_PROMPT}${memoryBlock}`;

    const settingsManager = SettingsManager.inMemory();
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt,
    });
    await resourceLoader.reload();

    const sessionManager = SessionManager.inMemory(cwd);
    for (const message of messages.slice(0, -1)) {
      if (message.role === 'user') {
        sessionManager.appendMessage({
          role: 'user',
          content: message.text,
          timestamp: Date.now(),
        });
      } else {
        sessionManager.appendMessage({
          role: 'assistant',
          content: [{ type: 'text', text: message.text }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: EMPTY_USAGE,
          stopReason: 'stop',
          timestamp: Date.now(),
        });
      }
    }


    const customTools = [
      ...this.buildCustomTools(
        defineTool,
        Type as unknown as TypeBoxTypeBuilder,
        context,
      ),
      ...this.buildMemoryTools(
        defineTool,
        Type as unknown as TypeBoxTypeBuilder,
        context,
      ),
    ];
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      model,
      modelRuntime,
      settingsManager,
      resourceLoader,
      sessionManager,
      noTools: 'all',
      tools: customTools.map((tool) => tool.name),
      customTools,
      thinkingLevel: 'off',
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const cancellation = new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          void session.abort().catch((error: unknown) => {
            console.error(
              '[pi-agent] abort failed:',
              error instanceof Error ? error.message : 'unknown error',
            );
          });
          reject(new Error('Agent run cancelled'));
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
      });
      await Promise.race([
        session.prompt(currentMessage.text),
        cancellation,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`Pi agent timed out after ${this.options.timeoutMs}ms`)),
            this.options.timeoutMs,
          );
        }),
      ]);
      const reply = session.getLastAssistantText();
      if (!reply || reply.trim().length === 0) {
        const lastAssistant = [...session.messages]
          .reverse()
          .find((m) => m.role === 'assistant');
        if (lastAssistant && 'errorMessage' in lastAssistant && lastAssistant.errorMessage) {
          throw new Error(`Pi agent failed: ${lastAssistant.errorMessage}`);
        }
        throw new Error('Pi agent returned no assistant text');
      }
      return reply;
    } finally {
      if (timeout) clearTimeout(timeout);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      session.dispose();
    }
  }

  /**
   * 按注册表生成 defineTool 列表，并根据当前在线执行面的能力过滤：
   * 桌面端或 Pod 不在线（或不具备所需能力）时，对应工具不对模型暴露，
   * 避免模型调用必然失败的工具。
   */
  private buildCustomTools(
    defineTool: DefineToolFn,
    Type: TypeBoxTypeBuilder,
    context?: QueuedAgentRun,
  ): any[] {
    const toolRouter = this.options.toolRouter;
    if (!toolRouter || !context) return [];

    const registry = buildAgentToolRegistry(Type);
    const machines = toolRouter.listConnectedMachines(context.userId);
    const runtimes = toolRouter.listConnectedRuntimes(context.userId);
    const machineHas = (capability: string): boolean =>
      machines.some((machine) => machine.capabilities.includes(capability as never));
    const runtimeHas = (capability: string): boolean =>
      runtimes.some((runtime) => runtime.capabilities.includes(capability as never));

    const customTools: any[] = [];
    for (const spec of registry) {
      if (spec.plane === 'local' && !machineHas(spec.capability)) continue;
      if (spec.plane === 'cloud' && !runtimeHas(spec.capability)) continue;
      if (spec.plane === 'composite' && !(machineHas('fs') && runtimeHas('fs'))) continue;

      const executeTimeoutMs = Math.min(spec.timeoutMs, this.options.timeoutMs);
      customTools.push(defineTool({
        name: spec.name,
        label: spec.label,
        description: spec.description,
        parameters: spec.parameters as never,
        execute: async (
          _toolCallId: unknown,
          params: Record<string, unknown>,
          signal: AbortSignal | undefined,
        ) => {
          const result = spec.plane === 'composite'
            ? await toolRouter.requestFilesCopy(
                context.userId,
                params as never,
                executeTimeoutMs,
                { runId: context.id, sessionId: context.sessionId },
                signal,
              )
            : spec.plane === 'local'
              ? await toolRouter.requestLocalTool(
                  context.userId,
                  spec.tool,
                  params,
                  executeTimeoutMs,
                  { runId: context.id, sessionId: context.sessionId },
                  signal,
                )
              : await toolRouter.requestCloudTool(
                  context.userId,
                  spec.tool,
                  params,
                  executeTimeoutMs,
                  { runId: context.id, sessionId: context.sessionId },
                  signal,
                );
          return {
            content: [{
              type: 'text' as const,
              text: result.ok ? JSON.stringify(result.data) : JSON.stringify(result.error),
            }],
            details: result.ok ? { ok: true } : { ok: false, code: result.error.code },
            isError: !result.ok,
          };
        },
      }));
    }
    return customTools;
  }

  private buildMemoryTools(
    defineTool: DefineToolFn,
    Type: TypeBoxTypeBuilder,
    context?: QueuedAgentRun,
  ): any[] {
    const store = this.options.memoryStore;
    if (!store || !context) return [];
    const userId = context.userId;
    return [
      defineTool({
        name: 'memory_list',
        label: 'memory_list',
        description: 'List long-term user memories (preferences and facts).',
        parameters: Type.Object({}) as never,
        execute: async () => {
          const memories = await store.listMemories(userId);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(memories) }],
            details: { ok: true },
            isError: false,
          };
        },
      }),
      defineTool({
        name: 'memory_set',
        label: 'memory_set',
        description: 'Create or update a long-term memory by key. Use for durable preferences and facts.',
        parameters: Type.Object({
          key: Type.String({ minLength: 1 }),
          content: Type.String({ minLength: 1 }),
          importance: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
        }) as never,
        execute: async (_id: unknown, params: { key: string; content: string; importance?: number }) => {
          const memory = await store.upsertMemory(userId, params);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(memory) }],
            details: { ok: true },
            isError: false,
          };
        },
      }),
      defineTool({
        name: 'memory_delete',
        label: 'memory_delete',
        description: 'Delete a long-term memory by id.',
        parameters: Type.Object({
          id: Type.String({ minLength: 1 }),
        }) as never,
        execute: async (_id: unknown, params: { id: string }) => {
          const deleted = await store.deleteMemory(userId, params.id);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ deleted }) }],
            details: { ok: deleted },
            isError: !deleted,
          };
        },
      }),
    ];
  }

}
