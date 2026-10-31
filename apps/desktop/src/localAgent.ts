import { BrowserWindow, ipcMain } from 'electron';
import fs from 'node:fs/promises';
import os from 'node:os';
import type { ToolRequestMessage } from '@lca/ws-protocol';
import type { ToolName } from '@lca/tool-protocol';
import {
  errResult,
  okResult,
  FsReadArgsSchema,
  FsReadResultSchema,
  UserAskArgsSchema,
  UserAskResultSchema,
  type ToolResult,
} from '@lca/tool-protocol';
import { LocalFileTools, listLocalDirectory } from './localFileTools';
import type { LocalToolHandler } from './localFileTools';
import { LocalShellTools } from './localShellTools';
import { LocalWorkspaceGuard } from './localWorkspace';

export interface LocalToolApprovalRequestData {
  requestId: string;
  approvalId: string;
  tool: string;
  args: unknown;
  commandPreview: string;
  machineId: string;
  hostname: string;
}

export interface LocalUserQuestionData {
  requestId: string;
  question: string;
  choices: string[];
  allowFreeText: boolean;
  machineId: string;
}

export type ApprovalDecision = 'allow-once' | 'always-allow' | 'deny' | 'never';

/** user.ask 提问超时：与审批弹窗一致 */
const QUESTION_TIMEOUT_MS = 120_000;

/**
 * Local Agent: approval gate + tool execution on this machine.
 */
export interface LocalAgentOptions {
  workspaceRoot: string;
}

export class LocalAgent {
  private readonly alwaysAllowedTools = new Set<string>();
  private readonly permanentlyDeniedTools = new Set<string>();
  private readonly toolHandlers: Partial<Record<ToolName, LocalToolHandler>>;
  private readonly guard: LocalWorkspaceGuard;
  private machineId = '';

  constructor(
    private readonly getParentWindow: () => BrowserWindow | null,
    options: LocalAgentOptions,
  ) {
    this.guard = new LocalWorkspaceGuard(options.workspaceRoot);
    const fileTools = new LocalFileTools(this.guard);
    const shellTools = new LocalShellTools(this.guard);
    this.toolHandlers = {
      ...fileTools.handlers(),
      ...shellTools.handlers(),
    };
  }

  setMachineId(id: string): void {
    this.machineId = id;
  }

  /**
   * Full path: optional approval dialog, then run tool.
   */
  async handleToolRequest(req: ToolRequestMessage): Promise<ToolResult> {
    if (req.requiresApproval) {
      const approved = await this.askApproval(req);
      if (!approved) {
        return errResult('ABORTED', 'User denied the tool request');
      }
    }

    return this.runTool(req);
  }

  /** Show approval dialog only; used when control plane needs tool.approval. */
  async askApproval(req: ToolRequestMessage): Promise<boolean> {
    if (this.alwaysAllowedTools.has(req.tool)) {
      return true;
    }
    if (this.permanentlyDeniedTools.has(req.tool)) {
      return false;
    }

    const parent = this.getParentWindow();
    if (!parent || parent.isDestroyed()) {
      return false;
    }

    const hostname = os.hostname();
    const commandPreview = this.formatCommandPreview(req.tool, req.args);

    const payload: LocalToolApprovalRequestData = {
      requestId: req.requestId,
      approvalId: req.approvalId ?? req.requestId,
      tool: req.tool,
      args: req.args,
      commandPreview,
      machineId: this.machineId || hostname,
      hostname,
    };

    return new Promise<boolean>((resolve) => {
      const channel = `local-tool:approval-response:${req.requestId}`;
      let cleanup: (() => void) | undefined;

      const timeout = setTimeout(() => {
        cleanup?.();
        resolve(false);
      }, 120_000);

      const handler = (_event: unknown, decision: ApprovalDecision) => {
        cleanup?.();
        if (decision === 'always-allow') {
          this.alwaysAllowedTools.add(req.tool);
          resolve(true);
        } else if (decision === 'allow-once') {
          resolve(true);
        } else if (decision === 'never') {
          this.permanentlyDeniedTools.add(req.tool);
          resolve(false);
        } else {
          resolve(false);
        }
      };

      cleanup = () => {
        clearTimeout(timeout);
        ipcMain.removeListener(channel, handler);
      };

      ipcMain.once(channel, handler);

      try {
        parent.webContents.send('local-tool:request-approval', payload);
      } catch (err) {
        cleanup();
        console.warn('[LocalAgent] failed to send approval request to renderer:', err);
        resolve(false);
      }
    });
  }

  /**
   * user.ask：向用户提问（选项 + 自由文本）。
   * 对话框本身就是交互，不走审批；120 秒无应答按放弃处理。
   */
  private askUser(rawArgs: unknown): Promise<ToolResult> {
    const parsed = UserAskArgsSchema.safeParse(rawArgs);
    if (!parsed.success) {
      return Promise.resolve(errResult('INVALID_ARGS', parsed.error.message));
    }

    const parent = this.getParentWindow();
    if (!parent || parent.isDestroyed()) {
      return Promise.resolve(errResult('ABORTED', 'No window available to ask the user'));
    }

    const hostname = os.hostname();
    const payload: LocalUserQuestionData = {
      requestId: `ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      question: parsed.data.question,
      choices: parsed.data.choices ?? [],
      allowFreeText: parsed.data.allowFreeText ?? true,
      machineId: this.machineId || hostname,
    };

    return new Promise<ToolResult>((resolve) => {
      const channel = `local-tool:question-response:${payload.requestId}`;
      let cleanup: (() => void) | undefined;

      const timeout = setTimeout(() => {
        cleanup?.();
        resolve(errResult('ABORTED', 'User did not answer the question in time'));
      }, QUESTION_TIMEOUT_MS);

      const handler = (_event: unknown, answer: unknown, choice: unknown) => {
        cleanup?.();
        const answerText = typeof answer === 'string' ? answer : '';
        const choiceText = typeof choice === 'string' ? choice : undefined;
        resolve({
          ok: true,
          data: UserAskResultSchema.parse({
            answer: answerText,
            ...(choiceText !== undefined ? { choice: choiceText } : {}),
          }),
        });
      };

      cleanup = () => {
        clearTimeout(timeout);
        ipcMain.removeListener(channel, handler);
      };

      ipcMain.once(channel, handler);

      try {
        parent.webContents.send('local-tool:ask-question', payload);
      } catch (err) {
        cleanup();
        console.warn('[LocalAgent] failed to send question to renderer:', err);
        resolve(errResult('ABORTED', 'Failed to show the question dialog'));
      }
    });
  }

  private formatCommandPreview(tool: string, rawArgs: unknown): string {
    const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>;
    if (tool === 'shell.exec' && typeof args.command === 'string') {
      return args.command;
    }
    if (tool === 'user.ask' && typeof args.question === 'string') {
      return `Question: ${args.question}`;
    }
    if (typeof args.path === 'string') {
      const action = {
        'fs.read': () => `Get-Content '${args.path}'`,
        'fs.list': () => `Get-ChildItem '${args.path}'`,
        'fs.write': () => `Set-Content '${args.path}' (${typeof args.content === 'string' ? args.content.length : 0} chars)`,
        'fs.edit': () => `Replace text in '${args.path}'`,
        'fs.glob': () => `Find files '${args.pattern ?? ''}' under '${args.path}'`,
        'fs.grep': () => `Search '${String(args.pattern ?? '')}' under '${args.path}'`,
        'notebook.read': () => `Read notebook '${args.path}'`,
        'notebook.edit': () => `${String(args.mode ?? 'replace')} cell ${String(args.cellIndex ?? 0)} in '${args.path}'`,
      }[tool];
      if (action) return action();
    }
    if (tool === 'files.copy') {
      return `Copy-Item '${String(args.source)}' -Destination '${String(args.destination)}'`;
    }
    return `${tool} ${JSON.stringify(args)}`;
  }

  async runTool(req: ToolRequestMessage): Promise<ToolResult> {
    if (req.tool === 'user.ask') {
      return this.askUser(req.args);
    }
    if (req.tool === 'fs.read') {
      return this.fsRead(req.args);
    }
    const handler = this.toolHandlers[req.tool];
    if (handler) {
      return handler(req.args);
    }
    return errResult(
      'NOT_IMPLEMENTED',
      `Tool ${req.tool} is not implemented on this machine`,
    );
  }

  private async fsRead(rawArgs: unknown): Promise<ToolResult<unknown>> {
    const parsed = FsReadArgsSchema.safeParse(rawArgs);
    if (!parsed.success) {
      return errResult('INVALID_ARGS', parsed.error.message);
    }

    let filePath: string;
    try {
      filePath = (await this.guard.resolve(parsed.data.path)).realPath;
    } catch (error) {
      return this.guard.toToolError(error);
    }
    const { encoding } = parsed.data;

    try {
      if (encoding === 'base64') {
        const stat = await fs.stat(filePath);
        // base64 膨胀约 1.37 倍，5MB 文件加上 JSON 包装仍低于网关 8MB 单条消息上限
        if (stat.size > 5 * 1024 * 1024) {
          return errResult(
            'INVALID_ARGS',
            `Files larger than ${5 * 1024 * 1024} bytes cannot be read`,
          );
        }
        const buf = await fs.readFile(filePath);
        return okResult({
          path: filePath,
          content: buf.toString('base64'),
          encoding: 'base64',
          size: buf.byteLength,
        });
      }

      const content = await fs.readFile(filePath, 'utf8');
      return okResult({
        path: filePath,
        content,
        encoding: 'utf8',
        size: Buffer.byteLength(content, 'utf8'),
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return errResult('NOT_FOUND', `File not found: ${filePath}`);
      }
      if (code === 'EACCES' || code === 'EPERM') {
        return errResult(
          'PERMISSION_DENIED',
          `Permission denied: ${filePath}`,
        );
      }
      return errResult(
        'INTERNAL',
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}
