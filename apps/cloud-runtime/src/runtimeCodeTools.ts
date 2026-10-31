import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  errResult,
  CodeRunArgsSchema,
  CodeRunResultSchema,
  type ToolResult,
  type ToolName,
} from '@lca/tool-protocol';
import type { WorkspaceGuard } from './runtimeWorkspace';

const OUTPUT_LIMIT_CHARS = 100_000;
const SCRATCH_ROOT = '.twinbot-scratch';

const LANGUAGE_CONFIG = {
  python: { fileName: 'main.py', command: 'python3' },
  node: { fileName: 'main.js', command: process.execPath },
  bash: { fileName: 'main.sh', command: 'bash' },
} as const;

export interface CloudRuntimeToolHandler {
  (args: unknown): Promise<ToolResult<unknown>>;
}

/**
 * 云端 code.run：脚本写入工作区内的隔离临时目录执行，结束后清理。
 * bash 语言与 shell.exec 同处一个沙箱信任级别，不构成额外越权面。
 */
export class RuntimeCodeTools {
  constructor(private readonly guard: WorkspaceGuard) {}

  handlers(): Partial<Record<ToolName, CloudRuntimeToolHandler>> {
    return {
      'code.run': (args) => this.run(args),
    };
  }

  async run(rawArgs: unknown): Promise<ToolResult<unknown>> {
    const parsed = CodeRunArgsSchema.safeParse(rawArgs);
    if (!parsed.success) return errResult('INVALID_ARGS', parsed.error.message);

    const { language, code, timeoutMs } = parsed.data;
    const config = LANGUAGE_CONFIG[language];
    const scratchDir = path.join(this.guard.workspaceRoot, SCRATCH_ROOT, randomUUID());

    try {
      await fs.mkdir(scratchDir, { recursive: true });
      const scriptPath = path.join(scratchDir, config.fileName);
      await fs.writeFile(scriptPath, code, 'utf8');

      const result = await this.execute(config.command, [scriptPath], scratchDir, timeoutMs);
      return { ok: true, data: CodeRunResultSchema.parse(result) };
    } catch (error) {
      return errResult(
        'INTERNAL',
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private execute(
    command: string,
    args: string[],
    cwd: string,
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number; truncated: boolean }> {
    return new Promise((resolve) => {
      execFile(
        command,
        args,
        {
          cwd,
          timeout: timeoutMs,
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
            exitCode = typeof error.code === 'number' ? error.code : error.killed ? 124 : 1;
          } else {
            exitCode = 0;
          }
          resolve({
            stdout: stdoutText.slice(0, OUTPUT_LIMIT_CHARS),
            stderr: stderrText.slice(0, OUTPUT_LIMIT_CHARS),
            exitCode,
            truncated,
          });
        },
      );
    });
  }
}
