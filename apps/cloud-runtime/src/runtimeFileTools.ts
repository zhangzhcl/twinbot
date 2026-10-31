import fs from 'node:fs/promises';
import path from 'node:path';
import {
  errResult,
  FsEditArgsSchema,
  FsGlobArgsSchema,
  FsGlobResultSchema,
  FsGrepArgsSchema,
  FsGrepResultSchema,
  FsListArgsSchema,
  FsListEntrySchema,
  FsListResultSchema,
  FsReadArgsSchema,
  FsReadResultSchema,
  FsWriteArgsSchema,
  FsWriteResultSchema,
  matchGlob,
  NotebookEditArgsSchema,
  NotebookReadArgsSchema,
  NotebookReadResultSchema,
  parseNotebookDocument,
  serializeNotebookDocument,
  buildNotebookCell,
  assertNotebookCellLimit,
  readNotebookCells,
  TOOL_PAYLOAD_MAX_CHARS,
  type ToolResult,
  type ToolName,
} from '@lca/tool-protocol';
import type { WorkspaceGuard } from './runtimeWorkspace';

/**
 * 单次读取上限：与协议载荷上限一致（base64 膨胀后仍低于网关 8MB WSS 消息上限）。
 */
const MAX_READ_BYTES = 5 * 1024 * 1024;
const FS_GLOB_MATCH_LIMIT = 1000;
const FS_GREP_FILE_LIMIT = 2000;
const FS_GREP_FILE_BYTES = 1024 * 1024;
/** 遍历时跳过的目录：依赖、版本库、运行时自身的临时与快照目录 */
const SKIP_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.checkpoints',
  '.twinbot-scratch',
]);

export interface CloudRuntimeToolHandler {
  (args: unknown): Promise<ToolResult<unknown>>;
}

/** 云端文件与检索工具集合：fs.read / fs.list / fs.write / fs.edit / fs.glob / fs.grep / notebook.read / notebook.edit */
export class CloudRuntimeFileTools {
  constructor(private readonly guard: WorkspaceGuard) {}

  handlers(): Partial<Record<ToolName, CloudRuntimeToolHandler>> {
    return {
      'fs.read': (args) => this.read(args),
      'fs.list': (args) => this.list(args),
      'fs.write': (args) => this.write(args),
      'fs.edit': (args) => this.edit(args),
      'fs.glob': (args) => this.glob(args),
      'fs.grep': (args) => this.grep(args),
      'notebook.read': (args) => this.notebookRead(args),
      'notebook.edit': (args) => this.notebookEdit(args),
    };
  }

  async read(rawArgs: unknown): Promise<ToolResult<unknown>> {
    const parsed = FsReadArgsSchema.safeParse(rawArgs);
    if (!parsed.success) return errResult('INVALID_ARGS', parsed.error.message);

    try {
      const { realPath, relativePath } = await this.guard.resolve(parsed.data.path);
      const file = await fs.open(realPath, 'r');
      try {
        const stats = await file.stat();
        if (!stats.isFile()) {
          return errResult('INVALID_ARGS', 'The requested path is not a regular file');
        }
        if (stats.size > MAX_READ_BYTES) {
          return errResult('INVALID_ARGS', `Files larger than ${MAX_READ_BYTES} bytes cannot be read`);
        }
        const content = await file.readFile();
        const result = FsReadResultSchema.parse({
          path: relativePath,
          content: parsed.data.encoding === 'base64'
            ? content.toString('base64')
            : content.toString('utf8'),
          encoding: parsed.data.encoding ?? 'utf8',
          size: content.byteLength,
        });
        return { ok: true, data: result };
      } finally {
        await file.close();
      }
    } catch (error) {
      return this.guard.toToolError(error);
    }
  }

  async list(rawArgs: unknown): Promise<ToolResult<unknown>> {
    const parsed = FsListArgsSchema.safeParse(rawArgs);
    if (!parsed.success) return errResult('INVALID_ARGS', parsed.error.message);

    try {
      const { realPath, relativePath } = await this.guard.resolve(parsed.data.path);
      const entries = await fs.readdir(realPath, { withFileTypes: true });
      const listed = await Promise.all(entries.map(async (entry) => {
        let size: number | undefined;
        if (entry.isFile()) {
          try {
            size = (await fs.stat(path.join(realPath, entry.name))).size;
          } catch {
            size = undefined;
          }
        }
        return FsListEntrySchema.parse({
          name: entry.name,
          path: path.join(relativePath, entry.name).split(path.sep).join('/'),
          type: entry.isFile()
            ? 'file'
            : entry.isDirectory()
              ? 'directory'
              : 'other',
          ...(size !== undefined ? { size } : {}),
        });
      }));
      return { ok: true, data: FsListResultSchema.parse({ path: relativePath, entries: listed }) };
    } catch (error) {
      return this.guard.toToolError(error);
    }
  }

  async write(rawArgs: unknown): Promise<ToolResult<unknown>> {
    const parsed = FsWriteArgsSchema.safeParse(rawArgs);
    if (!parsed.success) return errResult('INVALID_ARGS', parsed.error.message);

    try {
      // 写入目标可能尚不存在，先做静态边界检查，再对父目录做 realpath 防逃逸
      const base = this.guard.resolveOptional(parsed.data.path);
      const buffer = parsed.data.encoding === 'base64'
        ? Buffer.from(parsed.data.content, 'base64')
        : Buffer.from(parsed.data.content, 'utf8');
      if (buffer.byteLength > TOOL_PAYLOAD_MAX_CHARS) {
        return errResult('INVALID_ARGS', `Content exceeds ${TOOL_PAYLOAD_MAX_CHARS} bytes`);
      }
      if (parsed.data.createDirs) {
        await fs.mkdir(path.dirname(base.realPath), { recursive: true });
      }
      const realParent = await fs.realpath(path.dirname(base.realPath));
      if (!this.guard.isInside(realParent)) {
        throw Object.assign(new Error('Path resolves outside the runtime workspace'), {
          code: 'EACCES',
        });
      }
      const realPath = path.join(realParent, path.basename(base.realPath));
      await fs.writeFile(realPath, buffer);
      return {
        ok: true,
        data: FsWriteResultSchema.parse({
          path: base.relativePath,
          bytesWritten: buffer.byteLength,
        }),
      };
    } catch (error) {
      return this.guard.toToolError(error);
    }
  }

  async edit(rawArgs: unknown): Promise<ToolResult<unknown>> {
    const parsed = FsEditArgsSchema.safeParse(rawArgs);
    if (!parsed.success) return errResult('INVALID_ARGS', parsed.error.message);

    try {
      const { realPath, relativePath } = await this.guard.resolve(parsed.data.path);
      const stat = await fs.stat(realPath).catch(() => null);
      if (!stat || !stat.isFile()) {
        return errResult('NOT_FOUND', `File not found: ${parsed.data.path}`);
      }
      if (stat.size > MAX_READ_BYTES) {
        return errResult('INVALID_ARGS', `Files larger than ${MAX_READ_BYTES} bytes cannot be edited`);
      }
      const original = await fs.readFile(realPath, 'utf8');
      const { oldText, newText, replaceAll } = parsed.data;
      const occurrences = original.split(oldText).length - 1;
      if (occurrences === 0) {
        return errResult('NOT_FOUND', 'oldText was not found in the file');
      }
      if (occurrences > 1 && !replaceAll) {
        return errResult(
          'INVALID_ARGS',
          `oldText occurs ${occurrences} times; make it unique or set replaceAll`,
        );
      }
      const updated = replaceAll
        ? original.split(oldText).join(newText)
        : original.replace(oldText, newText);
      await fs.writeFile(realPath, updated, 'utf8');
      return {
        ok: true,
        data: {
          path: relativePath,
          replacements: replaceAll ? occurrences : 1,
        },
      };
    } catch (error) {
      return this.guard.toToolError(error);
    }
  }

  async glob(rawArgs: unknown): Promise<ToolResult<unknown>> {
    const parsed = FsGlobArgsSchema.safeParse(rawArgs);
    if (!parsed.success) return errResult('INVALID_ARGS', parsed.error.message);

    try {
      const base = this.guard.resolveOptional(parsed.data.path);
      const matches: string[] = [];
      const walk = async (dir: string): Promise<void> => {
        if (matches.length > FS_GLOB_MATCH_LIMIT) return;
        let entries;
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (matches.length > FS_GLOB_MATCH_LIMIT) return;
          const absolute = path.join(dir, entry.name);
          const relative = path.relative(base.realPath, absolute).split(path.sep).join('/');
          if (matchGlob(parsed.data.pattern, relative)) {
            matches.push(relative);
          }
          if (entry.isDirectory() && !SKIP_DIRECTORIES.has(entry.name)) {
            await walk(absolute);
          }
        }
      };
      await walk(base.realPath);
      const truncated = matches.length > FS_GLOB_MATCH_LIMIT;
      return {
        ok: true,
        data: FsGlobResultSchema.parse({
          path: base.relativePath,
          matches: matches.slice(0, FS_GLOB_MATCH_LIMIT),
          truncated,
        }),
      };
    } catch (error) {
      return this.guard.toToolError(error);
    }
  }

  async grep(rawArgs: unknown): Promise<ToolResult<unknown>> {
    const parsed = FsGrepArgsSchema.safeParse(rawArgs);
    if (!parsed.success) return errResult('INVALID_ARGS', parsed.error.message);

    try {
      const base = this.guard.resolveOptional(parsed.data.path);
      let regex: RegExp;
      try {
        regex = new RegExp(parsed.data.pattern, parsed.data.caseSensitive ? '' : 'i');
      } catch (error) {
        return errResult(
          'INVALID_ARGS',
          `Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const matches: Array<{ file: string; line: number; column: number; text: string }> = [];
      let filesScanned = 0;
      let truncated = false;

      const walk = async (dir: string): Promise<void> => {
        if (truncated || filesScanned >= FS_GREP_FILE_LIMIT) return;
        let entries;
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (truncated || filesScanned >= FS_GREP_FILE_LIMIT) return;
          const absolute = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (!SKIP_DIRECTORIES.has(entry.name)) await walk(absolute);
            continue;
          }
          if (!entry.isFile()) continue;
          const stat = await fs.stat(absolute).catch(() => null);
          if (!stat || stat.size === 0 || stat.size > FS_GREP_FILE_BYTES) continue;
          const content = await fs.readFile(absolute, 'utf8').catch(() => null);
          if (content === null || content.includes('\u0000')) continue;

          filesScanned += 1;
          const relative = path.relative(base.realPath, absolute).split(path.sep).join('/');
          const lines = content.split('\n');
          for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index];
            const match = regex.exec(line);
            if (!match) continue;
            matches.push({
              file: relative,
              line: index + 1,
              column: match.index + 1,
              text: line.slice(0, 200),
            });
            if (matches.length >= parsed.data.maxResults) {
              truncated = true;
              return;
            }
          }
        }
      };

      await walk(base.realPath);
      return {
        ok: true,
        data: FsGrepResultSchema.parse({
          path: base.relativePath,
          matches,
          truncated,
        }),
      };
    } catch (error) {
      return this.guard.toToolError(error);
    }
  }

  async notebookRead(rawArgs: unknown): Promise<ToolResult<unknown>> {
    const parsed = NotebookReadArgsSchema.safeParse(rawArgs);
    if (!parsed.success) return errResult('INVALID_ARGS', parsed.error.message);

    try {
      const { realPath, relativePath } = await this.guard.resolve(parsed.data.path);
      const stat = await fs.stat(realPath);
      if (stat.size > MAX_READ_BYTES) {
        return errResult('INVALID_ARGS', `Files larger than ${MAX_READ_BYTES} bytes cannot be read`);
      }
      const raw = await fs.readFile(realPath, 'utf8');
      const cells = readNotebookCells(raw);
      const result = NotebookReadResultSchema.parse({
        path: relativePath,
        cellCount: cells.length,
        cells,
      });
      return { ok: true, data: result };
    } catch (error) {
      return this.guard.toToolError(error);
    }
  }

  async notebookEdit(rawArgs: unknown): Promise<ToolResult<unknown>> {
    const parsed = NotebookEditArgsSchema.safeParse(rawArgs);
    if (!parsed.success) return errResult('INVALID_ARGS', parsed.error.message);

    try {
      const { realPath, relativePath } = await this.guard.resolve(parsed.data.path);
      const stat = await fs.stat(realPath).catch(() => null);
      if (!stat || !stat.isFile()) {
        return errResult('NOT_FOUND', `File not found: ${parsed.data.path}`);
      }
      if (stat.size > MAX_READ_BYTES) {
        return errResult('INVALID_ARGS', `Files larger than ${MAX_READ_BYTES} bytes cannot be edited`);
      }
      const raw = await fs.readFile(realPath, 'utf8');
      const document = parseNotebookDocument(raw);
      const { mode, cellIndex } = parsed.data;

      if (mode === 'delete') {
        if (cellIndex >= document.cells.length) {
          return errResult('INVALID_ARGS', `Cell index ${cellIndex} is out of range`);
        }
        document.cells.splice(cellIndex, 1);
      } else if (mode === 'insert') {
        if (parsed.data.cellContent === undefined) {
          return errResult('INVALID_ARGS', 'cellContent is required for insert');
        }
        assertNotebookCellLimit(document.cells.length + 1);
        document.cells.splice(
          cellIndex,
          0,
          buildNotebookCell(parsed.data.cellType ?? 'code', parsed.data.cellContent),
        );
      } else {
        if (cellIndex >= document.cells.length) {
          return errResult('INVALID_ARGS', `Cell index ${cellIndex} is out of range`);
        }
        if (parsed.data.cellContent === undefined) {
          return errResult('INVALID_ARGS', 'cellContent is required for replace');
        }
        if (parsed.data.cellType) {
          document.cells[cellIndex] = buildNotebookCell(parsed.data.cellType, parsed.data.cellContent);
        } else {
          document.cells[cellIndex].source = parsed.data.cellContent;
        }
      }

      await fs.writeFile(realPath, serializeNotebookDocument(document), 'utf8');
      return {
        ok: true,
        data: {
          path: relativePath,
          cellCount: document.cells.length,
        },
      };
    } catch (error) {
      return this.guard.toToolError(error);
    }
  }
}
