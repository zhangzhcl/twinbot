import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {
  errResult,
  VcsCheckpointArgsSchema,
  VcsCheckpointResultSchema,
  type ToolResult,
  type ToolName,
} from '@lca/tool-protocol';
import type { WorkspaceGuard } from './runtimeWorkspace';

/** 快照目录位于工作区内，随用户 PVC 持久化 */
const CHECKPOINTS_DIR = '.checkpoints';
const SNAPSHOT_TOTAL_LIMIT_BYTES = 200 * 1024 * 1024;
/** 快照时排除的目录（相对工作区根，任一层级命中即跳过） */
const EXCLUDED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.checkpoints',
  '.twinbot-scratch',
]);

export interface CloudRuntimeToolHandler {
  (args: unknown): Promise<ToolResult<unknown>>;
}

interface CheckpointManifest {
  id: string;
  label?: string;
  createdAt: string;
  files: number;
  bytes: number;
}

/**
 * 云端 vcs.checkpoint：纯 Node 工作区快照（不依赖 git）。
 * create 复制工作区到 .checkpoints/<id>/，restore 用快照整体替换工作区内容。
 */
export class RuntimeVcsTools {
  constructor(private readonly guard: WorkspaceGuard) {}

  handlers(): Partial<Record<ToolName, CloudRuntimeToolHandler>> {
    return {
      'vcs.checkpoint': (args) => this.checkpoint(args),
    };
  }

  private checkpointsRoot(): string {
    return path.join(this.guard.workspaceRoot, CHECKPOINTS_DIR);
  }

  async checkpoint(rawArgs: unknown): Promise<ToolResult<unknown>> {
    const parsed = VcsCheckpointArgsSchema.safeParse(rawArgs);
    if (!parsed.success) return errResult('INVALID_ARGS', parsed.error.message);

    try {
      switch (parsed.data.op) {
        case 'create':
          return await this.createCheckpoint(parsed.data.id, parsed.data.label);
        case 'restore':
          return await this.restoreCheckpoint(parsed.data);
        case 'list':
          return await this.listCheckpoints();
        default:
          return errResult('INVALID_ARGS', `Unknown op: ${String(parsed.data.op)}`);
      }
    } catch (error) {
      return errResult(
        'INTERNAL',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async createCheckpoint(
    requestedId: string | undefined,
    label?: string,
  ): Promise<ToolResult<unknown>> {
    const id = requestedId ?? generateCheckpointId();
    if (!/^[A-Za-z0-9._-]+$/.test(id)) {
      return errResult('INVALID_ARGS', 'Checkpoint id may only contain letters, digits, dot, dash and underscore');
    }
    const snapshotDir = path.join(this.checkpointsRoot(), id);
    if (fsSync.existsSync(snapshotDir)) {
      return errResult('INVALID_ARGS', `Checkpoint already exists: ${id}`);
    }

    const summary = await copyWorkspace(this.guard.workspaceRoot, snapshotDir);
    if (summary.bytes > SNAPSHOT_TOTAL_LIMIT_BYTES) {
      await fs.rm(snapshotDir, { recursive: true, force: true });
      return errResult(
        'INVALID_ARGS',
        `Workspace exceeds the ${SNAPSHOT_TOTAL_LIMIT_BYTES} byte snapshot limit`,
      );
    }

    const manifest: CheckpointManifest = {
      id,
      ...(label ? { label } : {}),
      createdAt: new Date().toISOString(),
      files: summary.files,
      bytes: summary.bytes,
    };
    await fs.writeFile(
      path.join(snapshotDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf8',
    );
    return {
      ok: true,
      data: VcsCheckpointResultSchema.parse({
        op: 'create',
        id,
        files: summary.files,
        bytes: summary.bytes,
        createdAt: manifest.createdAt,
      }),
    };
  }

  private async restoreCheckpoint(args: {
    id?: string;
    label?: string;
  }): Promise<ToolResult<unknown>> {
    if (!args.id) {
      return errResult('INVALID_ARGS', 'id is required for restore');
    }
    const snapshotDir = path.join(this.checkpointsRoot(), args.id);
    const manifest = await readManifest(snapshotDir);
    if (!manifest) {
      return errResult('NOT_FOUND', `Checkpoint not found: ${args.id}`);
    }

    // 恢复 = 清空工作区（保留 .checkpoints）后整体复制快照内容
    const rootEntries = await fs.readdir(this.guard.workspaceRoot, { withFileTypes: true });
    for (const entry of rootEntries) {
      if (entry.name === CHECKPOINTS_DIR) continue;
      await fs.rm(path.join(this.guard.workspaceRoot, entry.name), {
        recursive: true,
        force: true,
      });
    }
    const restored = await copySnapshotContents(snapshotDir, this.guard.workspaceRoot);
    return {
      ok: true,
      data: VcsCheckpointResultSchema.parse({
        op: 'restore',
        id: args.id,
        files: restored.files,
        bytes: restored.bytes,
      }),
    };
  }

  private async listCheckpoints(): Promise<ToolResult<unknown>> {
    const root = this.checkpointsRoot();
    let ids: string[] = [];
    try {
      ids = await fs.readdir(root);
    } catch {
      ids = [];
    }
    const checkpoints = [];
    for (const id of ids.sort().reverse()) {
      const manifest = await readManifest(path.join(root, id));
      if (manifest) checkpoints.push(manifest);
    }
    return {
      ok: true,
      data: VcsCheckpointResultSchema.parse({ op: 'list', checkpoints }),
    };
  }
}

function generateCheckpointId(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  return [
    'cp',
    now.getUTCFullYear(),
    pad(now.getUTCMonth() + 1),
    pad(now.getUTCDate()),
    pad(now.getUTCHours()),
    pad(now.getUTCMinutes()),
    pad(now.getUTCSeconds()),
  ].join('-');
}

async function readManifest(snapshotDir: string): Promise<CheckpointManifest | null> {
  try {
    const raw = await fs.readFile(path.join(snapshotDir, 'manifest.json'), 'utf8');
    const parsed = JSON.parse(raw) as CheckpointManifest;
    if (typeof parsed?.id !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

async function copyWorkspace(
  sourceRoot: string,
  destinationRoot: string,
): Promise<{ files: number; bytes: number }> {
  await fs.mkdir(destinationRoot, { recursive: true });
  let files = 0;
  let bytes = 0;

  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(sourceRoot, absolute);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
        await fs.mkdir(path.join(destinationRoot, relative), { recursive: true });
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const target = path.join(destinationRoot, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(absolute, target);
      const stat = await fs.stat(absolute);
      files += 1;
      bytes += stat.size;
    }
  };

  await walk(sourceRoot);
  return { files, bytes };
}

async function copySnapshotContents(
  snapshotDir: string,
  destinationRoot: string,
): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const entries = await fs.readdir(snapshotDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && entry.name === 'manifest.json') continue;
    const source = path.join(snapshotDir, entry.name);
    const target = path.join(destinationRoot, entry.name);
    if (entry.isDirectory()) {
      await fs.mkdir(target, { recursive: true });
      const copied = await copyDirContents(source, target);
      files += copied.files;
      bytes += copied.bytes;
    } else if (entry.isFile()) {
      await fs.copyFile(source, target);
      const stat = await fs.stat(source);
      files += 1;
      bytes += stat.size;
    }
  }
  return { files, bytes };
}

async function copyDirContents(
  sourceDir: string,
  destinationDir: string,
): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const source = path.join(sourceDir, entry.name);
    const target = path.join(destinationDir, entry.name);
    if (entry.isDirectory()) {
      await fs.mkdir(target, { recursive: true });
      const copied = await copyDirContents(source, target);
      files += copied.files;
      bytes += copied.bytes;
    } else if (entry.isFile()) {
      await fs.copyFile(source, target);
      const stat = await fs.stat(source);
      files += 1;
      bytes += stat.size;
    }
  }
  return { files, bytes };
}
