import fs from 'node:fs/promises';
import path from 'node:path';
import { errResult, type ToolResult } from '@lca/tool-protocol';

export interface ResolvedLocalPath {
  realPath: string;
  relativePath: string;
}

/**
 * Local WorkspaceGuard analogue: after user approval, paths must still stay
 * inside the configured workspace root (symlink-escape safe via realpath).
 */
export class LocalWorkspaceGuard {
  readonly workspaceRoot: string;
  private readonly realRoot: string;

  constructor(workspaceRoot: string) {
    if (!workspaceRoot.trim()) {
      throw new Error('Local workspace root is required');
    }
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.realRoot = this.workspaceRoot;
  }

  async resolve(requestedPath: string): Promise<ResolvedLocalPath> {
    const candidatePath = path.resolve(this.workspaceRoot, requestedPath);
    if (!this.isInsideWorkspace(candidatePath)) {
      throw Object.assign(new Error('Path is outside the local workspace'), {
        code: 'EACCES',
      });
    }
    const realRoot = await fs.realpath(this.workspaceRoot).catch(() => this.workspaceRoot);
    // Allow resolving paths that do not exist yet (writes): check parent chain
    let realPath: string;
    try {
      realPath = await fs.realpath(candidatePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
      const parent = path.dirname(candidatePath);
      const realParent = await fs.realpath(parent).catch(async () => {
        // Walk up until an existing ancestor
        let cursor = parent;
        while (cursor !== path.dirname(cursor)) {
          try {
            return await fs.realpath(cursor);
          } catch {
            cursor = path.dirname(cursor);
          }
        }
        return realRoot;
      });
      if (!this.isInsideWorkspace(realParent, realRoot)) {
        throw Object.assign(new Error('Path resolves outside the local workspace'), {
          code: 'EACCES',
        });
      }
      realPath = path.join(realParent, path.relative(parent, candidatePath) || path.basename(candidatePath));
      // For brand-new paths under an allowed parent, candidate itself must still be inside
      if (!this.isInsideWorkspace(candidatePath, realRoot) && !this.isInsideWorkspace(candidatePath, this.workspaceRoot)) {
        throw Object.assign(new Error('Path is outside the local workspace'), { code: 'EACCES' });
      }
      realPath = candidatePath;
    }
    if (!this.isInsideWorkspace(realPath, realRoot)) {
      throw Object.assign(new Error('Path resolves outside the local workspace'), {
        code: 'EACCES',
      });
    }
    const relative = path.relative(realRoot, realPath) || '.';
    return {
      realPath,
      relativePath: relative.split(path.sep).join('/'),
    };
  }

  resolveOptional(requestedPath: string | undefined): { realPath: string; relativePath: string } {
    const candidatePath = path.resolve(this.workspaceRoot, requestedPath ?? '.');
    if (!this.isInsideWorkspace(candidatePath)) {
      throw Object.assign(new Error('Path is outside the local workspace'), {
        code: 'EACCES',
      });
    }
    const relative = path.relative(this.workspaceRoot, candidatePath) || '.';
    return {
      realPath: candidatePath,
      relativePath: relative.split(path.sep).join('/'),
    };
  }

  /** Resolve cwd for shell.exec — must be inside workspace. */
  resolveCwd(cwd: string | undefined): string {
    const candidate = path.resolve(this.workspaceRoot, cwd ?? '.');
    if (!this.isInsideWorkspace(candidate)) {
      throw Object.assign(new Error('cwd is outside the local workspace'), {
        code: 'EACCES',
      });
    }
    return candidate;
  }

  toToolError(error: unknown): ToolResult<never> {
    if (error && typeof error === 'object' && 'code' in error) {
      const code = error.code;
      if (code === 'EACCES' || code === 'EPERM' || code === 'ELOOP') {
        return errResult('PERMISSION_DENIED', 'Access is limited to the configured local workspace');
      }
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return errResult('NOT_FOUND', 'The requested workspace path was not found');
      }
    }
    return errResult(
      'INTERNAL',
      error instanceof Error ? error.message : String(error),
    );
  }

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
