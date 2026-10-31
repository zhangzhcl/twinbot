import fs from 'node:fs/promises';
import path from 'node:path';
import { errResult, type ToolResult } from '@lca/tool-protocol';

export interface ResolvedWorkspacePath {
  realPath: string;
  /** 相对工作区根的路径，统一使用正斜杠 */
  relativePath: string;
}

/**
 * 工作区边界守卫：所有云端文件类工具共用。
 * 双重校验——先做纯路径拼接检查，再用 realpath 防符号链接逃逸。
 */
export class WorkspaceGuard {
  readonly workspaceRoot: string;

  private readonly realRoot: string;

  constructor(workspaceRoot: string) {
    if (!workspaceRoot.trim()) {
      throw new Error('Cloud Runtime workspace root is required');
    }
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.realRoot = this.workspaceRoot;
  }

  /** 解析必填路径；路径不存在或越界时抛出带 code 的错误 */
  async resolve(requestedPath: string): Promise<ResolvedWorkspacePath> {
    const candidatePath = path.resolve(this.workspaceRoot, requestedPath);
    if (!this.isInsideWorkspace(candidatePath)) {
      throw Object.assign(new Error('Path is outside the runtime workspace'), {
        code: 'EACCES',
      });
    }
    const realRoot = await fs.realpath(this.workspaceRoot);
    const realPath = await fs.realpath(candidatePath);
    if (!this.isInsideWorkspace(realPath, realRoot)) {
      throw Object.assign(new Error('Path resolves outside the runtime workspace'), {
        code: 'EACCES',
      });
    }
    const relative = path.relative(realRoot, realPath) || '.';
    return {
      realPath,
      relativePath: relative.split(path.sep).join('/'),
    };
  }

  /**
   * 解析可选路径（fs.glob / fs.grep 的基准目录）：缺省为工作区根。
   * 与 resolve 不同，允许目标尚不存在，只做静态边界检查。
   */
  resolveOptional(
    requestedPath: string | undefined,
  ): { realPath: string; relativePath: string } {
    const candidatePath = path.resolve(this.workspaceRoot, requestedPath ?? '.');
    if (!this.isInsideWorkspace(candidatePath)) {
      throw Object.assign(new Error('Path is outside the runtime workspace'), {
        code: 'EACCES',
      });
    }
    const relative = path.relative(this.workspaceRoot, candidatePath) || '.';
    return {
      realPath: candidatePath,
      relativePath: relative.split(path.sep).join('/'),
    };
  }

  /** 把文件系统错误统一映射为工具错误结果 */
  toToolError(error: unknown): ToolResult<never> {
    if (error && typeof error === 'object' && 'code' in error) {
      const code = error.code;
      if (code === 'EACCES' || code === 'EPERM' || code === 'ELOOP') {
        return errResult('PERMISSION_DENIED', 'Access is limited to the runtime workspace');
      }
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return errResult('NOT_FOUND', 'The requested workspace path was not found');
      }
    }
    if (error instanceof Error && error.name === 'NotebookFormatError') {
      return errResult('INVALID_ARGS', error.message);
    }
    return errResult(
      'INTERNAL',
      error instanceof Error ? error.message : String(error),
    );
  }

  /** 判断 realpath 后的路径是否仍在工作区内（供写入类工具做父目录校验） */
  isInside(candidatePath: string, rootPath = this.realRoot): boolean {
    return this.isInsideWorkspace(candidatePath, rootPath);
  }

  private isInsideWorkspace(
    candidatePath: string,
    rootPath = this.workspaceRoot,
  ): boolean {
    const relative = path.relative(rootPath, candidatePath);
    return relative === '' ||
      (relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative));
  }
}
