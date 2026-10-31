import { exec } from 'node:child_process';
import {
  errResult,
  ShellExecArgsSchema,
  ShellExecResultSchema,
  type ToolResult,
  type ToolName,
} from '@lca/tool-protocol';
import type { WorkspaceGuard } from './runtimeWorkspace';

/** stdout / stderr 截断阈值（字符） */
const OUTPUT_LIMIT_CHARS = 100_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 300_000;

export interface CloudRuntimeToolHandler {
  (args: unknown): Promise<ToolResult<unknown>>;
}

/** 云端 shell.exec：在沙箱工作区内执行命令，超时与输出体积双重受限 */
export class RuntimeShellTools {
  constructor(private readonly guard: WorkspaceGuard) {}

  handlers(): Partial<Record<ToolName, CloudRuntimeToolHandler>> {
    return {
      'shell.exec': (args) => this.exec(args),
    };
  }

  async exec(rawArgs: unknown): Promise<ToolResult<unknown>> {
    const parsed = ShellExecArgsSchema.safeParse(rawArgs);
    if (!parsed.success) return errResult('INVALID_ARGS', parsed.error.message);

    const { command, cwd, timeoutMs } = parsed.data;
    const boundedTimeout = Math.min(timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

    let workingDirectory = this.guard.workspaceRoot;
    if (cwd) {
      try {
        workingDirectory = (await this.guard.resolve(cwd)).realPath;
      } catch {
        return errResult('INVALID_ARGS', `cwd is outside the runtime workspace: ${cwd}`);
      }
    }

    return new Promise<ToolResult<unknown>>((resolve) => {
      exec(
        command,
        {
          cwd: workingDirectory,
          timeout: boundedTimeout,
          maxBuffer: 16 * 1024 * 1024,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const stdoutText = typeof stdout === 'string' ? stdout : String(stdout ?? '');
          const stderrText = typeof stderr === 'string' ? stderr : String(stderr ?? '');
          const truncated =
            stdoutText.length > OUTPUT_LIMIT_CHARS || stderrText.length > OUTPUT_LIMIT_CHARS;

          let exitCode: number;
          if (error) {
            if (error.killed) {
              exitCode = 124;
            } else if (typeof error.code === 'number') {
              exitCode = error.code;
            } else {
              exitCode = 1;
            }
          } else {
            exitCode = 0;
          }

          resolve({
            ok: true,
            data: ShellExecResultSchema.parse({
              stdout: stdoutText.slice(0, OUTPUT_LIMIT_CHARS),
              stderr: stderrText.slice(0, OUTPUT_LIMIT_CHARS),
              exitCode,
              truncated,
            }),
          });
        },
      );
    });
  }
}
