import fs from 'node:fs/promises';
import path from 'node:path';
import type { LocalWorkspaceGuard } from './localWorkspace';
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

/**
 * 与控制面 WSS maxPayload（8MB）对齐的读写上限：
 * base64 膨胀约 1.37 倍后仍低于单条消息上限。
 */
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const FS_GLOB_MATCH_LIMIT = 1000;
const FS_GREP_FILE_LIMIT = 2000;
const FS_GREP_FILE_BYTES = 1024 * 1024;
/** 遍历时跳过的目录 */
const SKIP_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.checkpoints',
  '.twinbot-scratch',
]);

export interface LocalToolHandler {
  (args: unknown): Promise<ToolResult<unknown>>;
}

/**
 * 桌面端文件工具：直接以绝对路径读写用户本机（每次调用都经审批门控）。
 * 与云端不同，这里没有工作区边界——审批对话框就是边界。
 */
export class LocalFileTools {
  constructor(private readonly guard: LocalWorkspaceGuard) {}

  handlers(): Partial<Record<ToolName, LocalToolHandler>> {
    return {
      'fs.list': (args) => listLocalDirectory(args, this.guard),
      'fs.write': (args) => this.write(args),
      'fs.edit': (args) => this.edit(args),
      'fs.glob': (args) => this.glob(args),
      'fs.grep': (args) => this.grep(args),
      'notebook.read': (args) => this.notebookRead(args),
      'notebook.edit': (args) => this.notebookEdit(args),
    };
  }

  async write(rawArgs: unknown): Promise<ToolResult<unknown>> {
    const parsed = FsWriteArgsSchema.safeParse(rawArgs);
    if (!parsed.success) return errResult('INVALID_ARGS', parsed.error.message);

    let filePath: string;
    try {
      filePath = (await this.guard.resolve(parsed.data.path)).realPath;
    } catch (error) {
      return this.guard.toToolError(error);
    }
    const { content, encoding, createDirs } = parsed.data;
    try {
      const buffer = encoding === 'base64'
        ? Buffer.from(content, 'base64')
        : Buffer.from(content, 'utf8');
      if (buffer.byteLength > TOOL_PAYLOAD_MAX_CHARS) {
        return errResult('INVALID_ARGS', `Content exceeds ${TOOL_PAYLOAD_MAX_CHARS} bytes`);
      }
      if (createDirs) {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
      }
      await fs.writeFile(filePath, buffer);
      return {
        ok: true,
        data: FsWriteResultSchema.parse({
          path: filePath,
          bytesWritten: buffer.byteLength,
        }),
      };
    } catch (err) {
      return toLocalFsError(err, filePath);
    }
  }

  async edit(rawArgs: unknown): Promise<ToolResult<unknown>> {
    const parsed = FsEditArgsSchema.safeParse(rawArgs);
    if (!parsed.success) return errResult('INVALID_ARGS', parsed.error.message);

    let filePath: string;
    try {
      filePath = (await this.guard.resolve(parsed.data.path)).realPath;
    } catch (error) {
      return this.guard.toToolError(error);
    }
    const { oldText, newText, replaceAll } = parsed.data;
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) {
        return errResult('NOT_FOUND', `File not found: ${filePath}`);
      }
      if (stat.size > MAX_FILE_BYTES) {
        return errResult('INVALID_ARGS', `Files larger than ${MAX_FILE_BYTES} bytes cannot be edited`);
      }
      const original = await fs.readFile(filePath, 'utf8');
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
      await fs.writeFile(filePath, updated, 'utf8');
      return {
        ok: true,
        data: {
          path: filePath,
          replacements: replaceAll ? occurrences : 1,
        },
      };
    } catch (err) {
      return toLocalFsError(err, filePath);
    }
  }

  async glob(rawArgs: unknown): Promise<ToolResult<unknown>> {
    const parsed = FsGlobArgsSchema.safeParse(rawArgs);
    if (!parsed.success) return errResult('INVALID_ARGS', parsed.error.message);

    let baseDirectory = parsed.data.path ?? '.';
    try {
      baseDirectory = this.guard.resolveOptional(baseDirectory).realPath;
    } catch (error) {
      return this.guard.toToolError(error);
    }
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
        const relative = path.relative(baseDirectory, absolute).split(path.sep).join('/');
        if (matchGlob(parsed.data.pattern, relative)) {
          matches.push(absolute);
        }
        if (entry.isDirectory() && !SKIP_DIRECTORIES.has(entry.name)) {
          await walk(absolute);
        }
      }
    };

    try {
      const stat = await fs.stat(baseDirectory);
      if (!stat.isDirectory()) {
        return errResult('NOT_FOUND', `Directory not found: ${baseDirectory}`);
      }
      await walk(baseDirectory);
      const truncated = matches.length > FS_GLOB_MATCH_LIMIT;
      return {
        ok: true,
        data: FsGlobResultSchema.parse({
          path: baseDirectory,
          matches: matches.slice(0, FS_GLOB_MATCH_LIMIT),
          truncated,
        }),
      };
    } catch (err) {
      return toLocalFsError(err, baseDirectory);
    }
  }

  async grep(rawArgs: unknown): Promise<ToolResult<unknown>> {
    const parsed = FsGrepArgsSchema.safeParse(rawArgs);
    if (!parsed.success) return errResult('INVALID_ARGS', parsed.error.message);

    let baseDirectory = parsed.data.path ?? '.';
    try {
      baseDirectory = this.guard.resolveOptional(baseDirectory).realPath;
    } catch (error) {
      return this.guard.toToolError(error);
    }
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
        const lines = content.split('\n');
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];
          const match = regex.exec(line);
          if (!match) continue;
          matches.push({
            file: absolute,
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

    try {
      const stat = await fs.stat(baseDirectory);
      if (!stat.isDirectory()) {
        return errResult('NOT_FOUND', `Directory not found: ${baseDirectory}`);
      }
      await walk(baseDirectory);
      return {
        ok: true,
        data: FsGrepResultSchema.parse({
          path: baseDirectory,
          matches,
          truncated,
        }),
      };
    } catch (err) {
      return toLocalFsError(err, baseDirectory);
    }
  }

  async notebookRead(rawArgs: unknown): Promise<ToolResult<unknown>> {
    const parsed = NotebookReadArgsSchema.safeParse(rawArgs);
    if (!parsed.success) return errResult('INVALID_ARGS', parsed.error.message);

    let notebookPath: string;
    try {
      notebookPath = (await this.guard.resolve(parsed.data.path)).realPath;
    } catch (error) {
      return this.guard.toToolError(error);
    }

    try {
      const stat = await fs.stat(notebookPath);
      if (stat.size > MAX_FILE_BYTES) {
        return errResult('INVALID_ARGS', `Files larger than ${MAX_FILE_BYTES} bytes cannot be read`);
      }
      const raw = await fs.readFile(notebookPath, 'utf8');
      const cells = readNotebookCells(raw);
      return {
        ok: true,
        data: NotebookReadResultSchema.parse({
          path: notebookPath,
          cellCount: cells.length,
          cells,
        }),
      };
    } catch (err) {
      return toNotebookError(err, notebookPath);
    }
  }

  async notebookEdit(rawArgs: unknown): Promise<ToolResult<unknown>> {
    const parsed = NotebookEditArgsSchema.safeParse(rawArgs);
    if (!parsed.success) return errResult('INVALID_ARGS', parsed.error.message);

    let filePath: string;
    try {
      filePath = (await this.guard.resolve(parsed.data.path)).realPath;
    } catch (error) {
      return this.guard.toToolError(error);
    }
    const { mode, cellIndex } = parsed.data;
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) {
        return errResult('NOT_FOUND', `File not found: ${filePath}`);
      }
      if (stat.size > MAX_FILE_BYTES) {
        return errResult('INVALID_ARGS', `Files larger than ${MAX_FILE_BYTES} bytes cannot be edited`);
      }
      const raw = await fs.readFile(filePath, 'utf8');
      const document = parseNotebookDocument(raw);

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

      await fs.writeFile(filePath, serializeNotebookDocument(document), 'utf8');
      return {
        ok: true,
        data: {
          path: filePath,
          cellCount: document.cells.length,
        },
      };
    } catch (err) {
      return toNotebookError(err, filePath);
    }
  }
}

export async function listLocalDirectory(
  rawArgs: unknown,
  guard?: LocalWorkspaceGuard,
): Promise<ToolResult<unknown>> {
  const parsed = FsListArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return errResult('INVALID_ARGS', parsed.error.message);
  }

  let directoryPath = parsed.data.path;
  if (guard) {
    try {
      directoryPath = (await guard.resolve(directoryPath)).realPath;
    } catch (error) {
      return guard.toToolError(error);
    }
  }

  try {
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    const listed = await Promise.all(entries.map(async (entry) => {
      let size: number | undefined;
      if (entry.isFile()) {
        try {
          size = (await fs.stat(path.join(directoryPath, entry.name))).size;
        } catch {
          size = undefined;
        }
      }
      return FsListEntrySchema.parse({
        name: entry.name,
        path: path.join(directoryPath, entry.name),
        type: entry.isFile()
          ? 'file'
          : entry.isDirectory()
            ? 'directory'
            : 'other',
        ...(size !== undefined ? { size } : {}),
      });
    }));
    return { ok: true, data: FsListResultSchema.parse({ path: directoryPath, entries: listed }) };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return errResult('NOT_FOUND', `Directory not found: ${directoryPath}`);
    }
    return toLocalFsError(err, directoryPath);
  }
}

function toLocalFsError(err: unknown, targetPath: string): ToolResult<never> {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return errResult('NOT_FOUND', `Path not found: ${targetPath}`);
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return errResult('PERMISSION_DENIED', `Permission denied: ${targetPath}`);
  }
  return errResult(
    'INTERNAL',
    err instanceof Error ? err.message : String(err),
  );
}

function toNotebookError(err: unknown, targetPath: string): ToolResult<never> {
  if (err instanceof Error && err.name === 'NotebookFormatError') {
    return errResult('INVALID_ARGS', err.message);
  }
  return toLocalFsError(err, targetPath);
}
