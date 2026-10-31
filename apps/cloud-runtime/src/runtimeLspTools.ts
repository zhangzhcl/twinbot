import fs from 'node:fs';
import path from 'node:path';
import {
  errResult,
  LspQueryArgsSchema,
  LspQueryResultSchema,
  type ToolResult,
  type ToolName,
} from '@lca/tool-protocol';
import type { WorkspaceGuard } from './runtimeWorkspace';

const MAX_PROJECT_FILES = 500;
const SKIP_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.checkpoints',
  '.twinbot-scratch',
]);
const SUPPORTED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

export interface CloudRuntimeToolHandler {
  (args: unknown): Promise<ToolResult<unknown>>;
}

/**
 * 云端 lsp.query：基于 typescript 包的 LanguageService 提供 TS/JS 的
 * definition / references / type 查询，无需独立语言服务器进程。
 * 服务按 workspace 懒加载，文件版本按 mtime 失效。
 */
export class RuntimeLspTools {
  private service: import('typescript').LanguageService | null = null;
  private tsModule: typeof import('typescript') | null = null;
  private scriptFiles: string[] = [];

  constructor(private readonly guard: WorkspaceGuard) {}

  handlers(): Partial<Record<ToolName, CloudRuntimeToolHandler>> {
    return {
      'lsp.query': (args) => this.query(args),
    };
  }

  async query(rawArgs: unknown): Promise<ToolResult<unknown>> {
    const parsed = LspQueryArgsSchema.safeParse(rawArgs);
    if (!parsed.success) return errResult('INVALID_ARGS', parsed.error.message);

    const { action, path: requestedPath, line, character } = parsed.data;
    const extension = path.extname(requestedPath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(extension)) {
      return errResult(
        'INVALID_ARGS',
        `lsp.query supports TypeScript/JavaScript files only, got: ${extension || '(none)'}`,
      );
    }

    let ts: typeof import('typescript');
    try {
      ts = await this.ensureTypescript();
    } catch (error) {
      return errResult(
        'NOT_IMPLEMENTED',
        `TypeScript module unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    let targetPath: string;
    try {
      targetPath = (await this.guard.resolve(requestedPath)).realPath;
    } catch {
      return errResult('PERMISSION_DENIED', 'Access is limited to the runtime workspace');
    }
    if (!fs.existsSync(targetPath)) {
      return errResult('NOT_FOUND', `File not found: ${requestedPath}`);
    }

    const service = await this.ensureService(ts);
    const program = service.getProgram();
    if (!program) {
      return errResult('INTERNAL', 'Language service program is unavailable');
    }
    const sourceFile = program.getSourceFile(targetPath);
    if (!sourceFile) {
      return errResult('INVALID_ARGS', `File is not part of the workspace program: ${requestedPath}`);
    }
    const position = sourceFile.getPositionOfLineAndCharacter(line, character);

    if (action === 'type') {
      const quickInfo = service.getQuickInfoAtPosition(targetPath, position);
      const typeName = quickInfo?.displayParts
        ?.map((part) => part.text)
        .join('') ?? '';
      return {
        ok: true,
        data: LspQueryResultSchema.parse({ locations: [], typeName }),
      };
    }

    const spans = action === 'definition'
      ? service.getDefinitionAtPosition(targetPath, position) ?? []
      : service.getReferencesAtPosition(targetPath, position) ?? [];

    const locations = spans
      .map((entry) => {
        const file = program.getSourceFile(entry.fileName);
        if (!file) return null;
        const at = file.getLineAndCharacterOfPosition(entry.textSpan.start);
        return {
          path: this.toDisplayPath(entry.fileName),
          line: at.line,
          character: at.character,
        };
      })
      .filter((value): value is { path: string; line: number; character: number } => value !== null);

    return {
      ok: true,
      data: LspQueryResultSchema.parse({ locations }),
    };
  }

  private async ensureTypescript(): Promise<typeof import('typescript')> {
    if (this.tsModule) return this.tsModule;
    const imported = (await import('typescript')) as unknown as {
      default?: typeof import('typescript');
    } & typeof import('typescript');
    // typescript 包可能带 CJS default 互操作层，按 version 标识判断真实模块
    this.tsModule = imported.default?.version ? imported.default : imported;
    return this.tsModule;
  }

  private async ensureService(
    ts: typeof import('typescript'),
  ): Promise<import('typescript').LanguageService> {
    this.scriptFiles = await this.collectScriptFiles(ts);
    if (this.service) return this.service;

    const compilerOptions: import('typescript').CompilerOptions = {
      allowJs: true,
      checkJs: false,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      esModuleInterop: true,
      skipLibCheck: true,
      skipDefaultLibCheck: true,
      noEmit: true,
    };
    const libDir = path.dirname(require.resolve('typescript'));
    const fileVersions = new Map<string, string>();

    const host: import('typescript').LanguageServiceHost = {
      getScriptFileNames: () => this.scriptFiles,
      getScriptVersion: (fileName) =>
        fileVersions.get(fileName) ?? this.statVersion(fileName),
      getScriptSnapshot: (fileName) => {
        try {
          return ts.ScriptSnapshot.fromString(fs.readFileSync(fileName, 'utf8'));
        } catch {
          return undefined;
        }
      },
      getCurrentDirectory: () => this.guard.workspaceRoot,
      getCompilationSettings: () => compilerOptions,
      getDefaultLibFileName: (options) => path.join(libDir, ts.getDefaultLibFileName(options)),
      fileExists: (fileName) => fs.existsSync(fileName),
      readFile: (fileName) => {
        try {
          return fs.readFileSync(fileName, 'utf8');
        } catch {
          return undefined;
        }
      },
      readDirectory: () => [],
      directoryExists: (directoryName) => fs.existsSync(directoryName),
      getDirectories: () => [],
    };
    // 版本号函数：把读取到的 mtime 缓存进 map，保证同轮查询稳定
    host.getScriptVersion = (fileName: string): string => {
      const existing = fileVersions.get(fileName);
      if (existing !== undefined) return existing;
      const version = this.statVersion(fileName);
      fileVersions.set(fileName, version);
      return version;
    };

    this.service = ts.createLanguageService(host, ts.createDocumentRegistry());
    return this.service;
  }

  private statVersion(fileName: string): string {
    try {
      return String(fs.statSync(fileName).mtimeMs);
    } catch {
      return '0';
    }
  }

  private toDisplayPath(fileName: string): string {
    const relative = path.relative(this.guard.workspaceRoot, fileName);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      return relative.split(path.sep).join('/');
    }
    return fileName;
  }

  private async collectScriptFiles(ts: typeof import('typescript')): Promise<string[]> {
    const files: string[] = [];
    const walk = (dir: string): void => {
      if (files.length >= MAX_PROJECT_FILES) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (files.length >= MAX_PROJECT_FILES) return;
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRECTORIES.has(entry.name)) walk(absolute);
          continue;
        }
        if (!entry.isFile()) continue;
        if (!SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
        if (!ts.sys.fileExists(absolute)) continue;
        files.push(absolute);
      }
    };
    walk(this.guard.workspaceRoot);
    return files;
  }
}
