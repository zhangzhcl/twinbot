import { z } from 'zod';

/**
 * 单次工具载荷上限（字符数）。
 * 控制面 WSS maxPayload 为 8MB：base64 编码膨胀约 1.37 倍，
 * 5,000,000 字符载荷加 JSON 包装后仍低于 8MB，不会被网关截断。
 */
export const TOOL_PAYLOAD_MAX_CHARS = 5_000_000;

/** fs.glob 返回条数上限 */
export const FS_GLOB_MAX_MATCHES = 1000;
/** fs.grep 命中数上限与默认值 */
export const FS_GREP_MAX_RESULTS = 1000;
export const FS_GREP_DEFAULT_RESULTS = 200;
/** fs.grep 有界遍历：最多扫描文件数与单文件大小上限 */
export const FS_GREP_MAX_FILES = 2000;
export const FS_GREP_MAX_FILE_BYTES = 1024 * 1024;
/** notebook 单元格数量上限与单格源码截断阈值 */
export const NOTEBOOK_MAX_CELLS = 1000;
export const NOTEBOOK_CELL_SOURCE_MAX_CHARS = 200_000;

/** Tool name literals */
export const ToolNameSchema = z.enum([
  'fs.read',
  'fs.list',
  'fs.write',
  'fs.edit',
  'fs.glob',
  'fs.grep',
  'shell.exec',
  'files.copy',
  'code.run',
  'web.fetch',
  'web.search',
  'browser.use',
  'user.ask',
  'notebook.read',
  'notebook.edit',
  'lsp.query',
  'vcs.checkpoint',
]);
export type ToolName = z.infer<typeof ToolNameSchema>;

/** fs.read */
export const FsReadArgsSchema = z.object({
  path: z.string().min(1),
  encoding: z.enum(['utf8', 'base64']).optional().default('utf8'),
});
export type FsReadArgs = z.infer<typeof FsReadArgsSchema>;

export const FsReadResultSchema = z.object({
  path: z.string(),
  content: z.string(),
  encoding: z.enum(['utf8', 'base64']),
  size: z.number().int().nonnegative(),
});
export type FsReadResult = z.infer<typeof FsReadResultSchema>;

/** fs.list */
export const FsListArgsSchema = z.object({
  path: z.string().min(1),
});
export type FsListArgs = z.infer<typeof FsListArgsSchema>;

export const FsListEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(['file', 'directory', 'other']),
  size: z.number().int().nonnegative().optional(),
});
export type FsListEntry = z.infer<typeof FsListEntrySchema>;

export const FsListResultSchema = z.object({
  path: z.string(),
  entries: z.array(FsListEntrySchema),
});
export type FsListResult = z.infer<typeof FsListResultSchema>;

/** fs.write */
export const FsWriteArgsSchema = z.object({
  path: z.string().min(1),
  content: z.string().max(TOOL_PAYLOAD_MAX_CHARS),
  encoding: z.enum(['utf8', 'base64']).optional().default('utf8'),
  createDirs: z.boolean().optional().default(false),
});
export type FsWriteArgs = z.infer<typeof FsWriteArgsSchema>;

export const FsWriteResultSchema = z.object({
  path: z.string(),
  bytesWritten: z.number().int().nonnegative(),
});
export type FsWriteResult = z.infer<typeof FsWriteResultSchema>;

/** fs.edit：精确文本替换，oldText 必须唯一（未开启 replaceAll 时） */
export const FsEditArgsSchema = z.object({
  path: z.string().min(1),
  oldText: z.string().min(1).max(TOOL_PAYLOAD_MAX_CHARS),
  newText: z.string().max(TOOL_PAYLOAD_MAX_CHARS),
  replaceAll: z.boolean().optional().default(false),
});
export type FsEditArgs = z.infer<typeof FsEditArgsSchema>;

export const FsEditResultSchema = z.object({
  path: z.string(),
  replacements: z.number().int().nonnegative(),
});
export type FsEditResult = z.infer<typeof FsEditResultSchema>;

/** fs.glob：pattern 相对 path 基准目录，匹配结果为相对路径（正斜杠分隔） */
export const FsGlobArgsSchema = z.object({
  pattern: z.string().min(1).max(1024),
  path: z.string().optional(),
});
export type FsGlobArgs = z.infer<typeof FsGlobArgsSchema>;

export const FsGlobResultSchema = z.object({
  path: z.string(),
  matches: z.array(z.string()).max(FS_GLOB_MAX_MATCHES),
  truncated: z.boolean(),
});
export type FsGlobResult = z.infer<typeof FsGlobResultSchema>;

/** fs.grep：有界遍历的正则检索，坐标 1 基，text 为命中行内容（截断至 200 字符） */
export const FsGrepArgsSchema = z.object({
  pattern: z.string().min(1).max(1024),
  path: z.string().optional(),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(FS_GREP_MAX_RESULTS)
    .optional()
    .default(FS_GREP_DEFAULT_RESULTS),
  caseSensitive: z.boolean().optional().default(false),
});
export type FsGrepArgs = z.infer<typeof FsGrepArgsSchema>;

export const FsGrepMatchSchema = z.object({
  file: z.string(),
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  text: z.string(),
});
export type FsGrepMatch = z.infer<typeof FsGrepMatchSchema>;

export const FsGrepResultSchema = z.object({
  path: z.string(),
  matches: z.array(FsGrepMatchSchema),
  truncated: z.boolean(),
});
export type FsGrepResult = z.infer<typeof FsGrepResultSchema>;

/** shell.exec */
export const ShellExecArgsSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
});
export type ShellExecArgs = z.infer<typeof ShellExecArgsSchema>;

export const ShellExecResultSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int(),
  truncated: z.boolean().optional(),
});
export type ShellExecResult = z.infer<typeof ShellExecResultSchema>;

/** files.copy */
export const FilesCopyArgsSchema = z.object({
  source: z.string().min(1),
  destination: z.string().min(1),
  direction: z.enum(['local-to-cloud', 'cloud-to-local']),
});
export type FilesCopyArgs = z.infer<typeof FilesCopyArgsSchema>;

export const FilesCopyResultSchema = z.object({
  source: z.string(),
  destination: z.string(),
  bytesCopied: z.number().int().nonnegative(),
});
export type FilesCopyResult = z.infer<typeof FilesCopyResultSchema>;

/** code.run：云端沙箱内的脚本执行，写入临时目录运行后清理 */
export const CodeRunArgsSchema = z.object({
  language: z.enum(['python', 'node', 'bash']),
  code: z.string().min(1).max(512_000),
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(300_000)
    .optional()
    .default(60_000),
});
export type CodeRunArgs = z.infer<typeof CodeRunArgsSchema>;

export const CodeRunResultSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int(),
  truncated: z.boolean().optional(),
});
export type CodeRunResult = z.infer<typeof CodeRunResultSchema>;

/** web.fetch：仅 http/https，响应体超限即截断 */
export const WebFetchArgsSchema = z.object({
  url: z.string().url(),
  maxBytes: z
    .number()
    .int()
    .min(1024)
    .max(TOOL_PAYLOAD_MAX_CHARS)
    .optional()
    .default(2 * 1024 * 1024),
});
export type WebFetchArgs = z.infer<typeof WebFetchArgsSchema>;

export const WebFetchResultSchema = z.object({
  url: z.string(),
  status: z.number().int(),
  contentType: z.string().optional(),
  body: z.string(),
  encoding: z.enum(['utf8', 'base64']),
  truncated: z.boolean(),
});
export type WebFetchResult = z.infer<typeof WebFetchResultSchema>;

/** web.search：Brave（配置 Key 时）或 DuckDuckGo 兜底 */
export const WebSearchArgsSchema = z.object({
  query: z.string().min(1).max(400),
  count: z.number().int().min(1).max(10).optional().default(5),
});
export type WebSearchArgs = z.infer<typeof WebSearchArgsSchema>;

export const WebSearchHitSchema = z.object({
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
});
export type WebSearchHit = z.infer<typeof WebSearchHitSchema>;

export const WebSearchResultSchema = z.object({
  query: z.string(),
  provider: z.string(),
  results: z.array(WebSearchHitSchema),
});
export type WebSearchResult = z.infer<typeof WebSearchResultSchema>;

/** browser.use：云端 Pod 内无头 Chromium，screenshot 返回 base64 PNG */
export const BrowserActionSchema = z.enum([
  'goto',
  'click',
  'type',
  'screenshot',
  'close',
]);
export type BrowserAction = z.infer<typeof BrowserActionSchema>;

export const BrowserUseArgsSchema = z.object({
  action: BrowserActionSchema,
  url: z.string().url().optional(),
  selector: z.string().min(1).optional(),
  text: z.string().max(10_000).optional(),
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(120_000)
    .optional()
    .default(30_000),
});
export type BrowserUseArgs = z.infer<typeof BrowserUseArgsSchema>;

export const BrowserUseResultSchema = z.object({
  action: BrowserActionSchema,
  message: z.string().optional(),
  pageUrl: z.string().optional(),
  image: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});
export type BrowserUseResult = z.infer<typeof BrowserUseResultSchema>;

/** user.ask：向桌面端用户提问（选项 + 自由文本），仅本地执行面支持 */
export const UserAskArgsSchema = z.object({
  question: z.string().min(1).max(2000),
  choices: z.array(z.string().min(1).max(200)).max(6).optional(),
  allowFreeText: z.boolean().optional().default(true),
});
export type UserAskArgs = z.infer<typeof UserAskArgsSchema>;

export const UserAskResultSchema = z.object({
  answer: z.string().max(4000),
  choice: z.string().optional(),
});
export type UserAskResult = z.infer<typeof UserAskResultSchema>;

/** notebook.read / notebook.edit */
export const NotebookCellSchema = z.object({
  index: z.number().int().nonnegative(),
  type: z.enum(['code', 'markdown', 'raw']),
  source: z.string(),
  outputs: z.array(z.string()).optional(),
  truncated: z.boolean().optional(),
});
export type NotebookCell = z.infer<typeof NotebookCellSchema>;

export const NotebookReadArgsSchema = z.object({
  path: z.string().min(1),
});
export type NotebookReadArgs = z.infer<typeof NotebookReadArgsSchema>;

export const NotebookReadResultSchema = z.object({
  path: z.string(),
  cellCount: z.number().int().nonnegative(),
  cells: z.array(NotebookCellSchema),
});
export type NotebookReadResult = z.infer<typeof NotebookReadResultSchema>;

export const NotebookEditArgsSchema = z.object({
  path: z.string().min(1),
  mode: z.enum(['replace', 'insert', 'delete']),
  cellIndex: z.number().int().min(0),
  cellContent: z.string().max(TOOL_PAYLOAD_MAX_CHARS).optional(),
  cellType: z.enum(['code', 'markdown', 'raw']).optional().default('code'),
});
export type NotebookEditArgs = z.infer<typeof NotebookEditArgsSchema>;

export const NotebookEditResultSchema = z.object({
  path: z.string(),
  cellCount: z.number().int().nonnegative(),
});
export type NotebookEditResult = z.infer<typeof NotebookEditResultSchema>;

/** lsp.query：0 基行列；definition/references 返回 locations，type 返回 typeName */
export const LspQueryArgsSchema = z.object({
  action: z.enum(['definition', 'references', 'type']),
  path: z.string().min(1),
  line: z.number().int().min(0),
  character: z.number().int().min(0),
});
export type LspQueryArgs = z.infer<typeof LspQueryArgsSchema>;

export const LspLocationSchema = z.object({
  path: z.string(),
  line: z.number().int().nonnegative(),
  character: z.number().int().nonnegative(),
});
export type LspLocation = z.infer<typeof LspLocationSchema>;

export const LspQueryResultSchema = z.object({
  locations: z.array(LspLocationSchema),
  typeName: z.string().optional(),
});
export type LspQueryResult = z.infer<typeof LspQueryResultSchema>;

/** vcs.checkpoint：纯 Node 工作区快照（create / restore / list） */
export const VcsCheckpointArgsSchema = z.object({
  op: z.enum(['create', 'restore', 'list']),
  id: z.string().min(1).max(64).optional(),
  label: z.string().max(200).optional(),
});
export type VcsCheckpointArgs = z.infer<typeof VcsCheckpointArgsSchema>;

export const VcsCheckpointInfoSchema = z.object({
  id: z.string(),
  label: z.string().optional(),
  createdAt: z.string(),
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
});
export type VcsCheckpointInfo = z.infer<typeof VcsCheckpointInfoSchema>;

export const VcsCheckpointResultSchema = z.object({
  op: z.enum(['create', 'restore', 'list']),
  id: z.string().optional(),
  files: z.number().int().nonnegative().optional(),
  bytes: z.number().int().nonnegative().optional(),
  createdAt: z.string().optional(),
  checkpoints: z.array(VcsCheckpointInfoSchema).optional(),
});
export type VcsCheckpointResult = z.infer<typeof VcsCheckpointResultSchema>;

/** Discriminated args by tool */
export const ToolArgsSchema = z.union([
  FsReadArgsSchema,
  FsListArgsSchema,
  FsWriteArgsSchema,
  FsEditArgsSchema,
  FsGlobArgsSchema,
  FsGrepArgsSchema,
  ShellExecArgsSchema,
  FilesCopyArgsSchema,
  CodeRunArgsSchema,
  WebFetchArgsSchema,
  WebSearchArgsSchema,
  BrowserUseArgsSchema,
  UserAskArgsSchema,
  NotebookReadArgsSchema,
  NotebookEditArgsSchema,
  LspQueryArgsSchema,
  VcsCheckpointArgsSchema,
]);
export type ToolArgs =
  | FsReadArgs
  | FsListArgs
  | FsWriteArgs
  | FsEditArgs
  | FsGlobArgs
  | FsGrepArgs
  | ShellExecArgs
  | FilesCopyArgs
  | CodeRunArgs
  | WebFetchArgs
  | WebSearchArgs
  | BrowserUseArgs
  | UserAskArgs
  | NotebookReadArgs
  | NotebookEditArgs
  | LspQueryArgs
  | VcsCheckpointArgs;

export type ToolArgsByName = {
  'fs.read': FsReadArgs;
  'fs.list': FsListArgs;
  'fs.write': FsWriteArgs;
  'fs.edit': FsEditArgs;
  'fs.glob': FsGlobArgs;
  'fs.grep': FsGrepArgs;
  'shell.exec': ShellExecArgs;
  'files.copy': FilesCopyArgs;
  'code.run': CodeRunArgs;
  'web.fetch': WebFetchArgs;
  'web.search': WebSearchArgs;
  'browser.use': BrowserUseArgs;
  'user.ask': UserAskArgs;
  'notebook.read': NotebookReadArgs;
  'notebook.edit': NotebookEditArgs;
  'lsp.query': LspQueryArgs;
  'vcs.checkpoint': VcsCheckpointArgs;
};

export type ToolResultByName = {
  'fs.read': FsReadResult;
  'fs.list': FsListResult;
  'fs.write': FsWriteResult;
  'fs.edit': FsEditResult;
  'fs.glob': FsGlobResult;
  'fs.grep': FsGrepResult;
  'shell.exec': ShellExecResult;
  'files.copy': FilesCopyResult;
  'code.run': CodeRunResult;
  'web.fetch': WebFetchResult;
  'web.search': WebSearchResult;
  'browser.use': BrowserUseResult;
  'user.ask': UserAskResult;
  'notebook.read': NotebookReadResult;
  'notebook.edit': NotebookEditResult;
  'lsp.query': LspQueryResult;
  'vcs.checkpoint': VcsCheckpointResult;
};

/** 每个工具对应的 Result Schema，路由层用于校验执行端回包；Input 放宽为 unknown 以兼容带 default 的字段 */
export const ToolResultSchemasByName: {
  [T in ToolName]: z.ZodType<ToolResultByName[T], z.ZodTypeDef, unknown>;
} = {
  'fs.read': FsReadResultSchema,
  'fs.list': FsListResultSchema,
  'fs.write': FsWriteResultSchema,
  'fs.edit': FsEditResultSchema,
  'fs.glob': FsGlobResultSchema,
  'fs.grep': FsGrepResultSchema,
  'shell.exec': ShellExecResultSchema,
  'files.copy': FilesCopyResultSchema,
  'code.run': CodeRunResultSchema,
  'web.fetch': WebFetchResultSchema,
  'web.search': WebSearchResultSchema,
  'browser.use': BrowserUseResultSchema,
  'user.ask': UserAskResultSchema,
  'notebook.read': NotebookReadResultSchema,
  'notebook.edit': NotebookEditResultSchema,
  'lsp.query': LspQueryResultSchema,
  'vcs.checkpoint': VcsCheckpointResultSchema,
};

/** 每个工具参数对应的 Args Schema，协议层判别校验使用；Input 放宽为 unknown 以兼容带 default 的字段 */
export const ToolArgsSchemasByName: {
  [T in ToolName]: z.ZodType<ToolArgsByName[T], z.ZodTypeDef, unknown>;
} = {
  'fs.read': FsReadArgsSchema,
  'fs.list': FsListArgsSchema,
  'fs.write': FsWriteArgsSchema,
  'fs.edit': FsEditArgsSchema,
  'fs.glob': FsGlobArgsSchema,
  'fs.grep': FsGrepArgsSchema,
  'shell.exec': ShellExecArgsSchema,
  'files.copy': FilesCopyArgsSchema,
  'code.run': CodeRunArgsSchema,
  'web.fetch': WebFetchArgsSchema,
  'web.search': WebSearchArgsSchema,
  'browser.use': BrowserUseArgsSchema,
  'user.ask': UserAskArgsSchema,
  'notebook.read': NotebookReadArgsSchema,
  'notebook.edit': NotebookEditArgsSchema,
  'lsp.query': LspQueryArgsSchema,
  'vcs.checkpoint': VcsCheckpointArgsSchema,
};
