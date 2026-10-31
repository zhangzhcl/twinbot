/**
 * Jupyter Notebook（nbformat 4）解析与序列化的纯函数模块。
 *
 * 桌面端与云端共用：读取 .ipynb 提取单元格，编辑后回写。
 * source 字段在 nbformat 中可能是 string 或 string[]（每行保留换行符），
 * 统一归一化为 string；回写时也使用 string 形式（同样是合法 nbformat）。
 */
import { NOTEBOOK_CELL_SOURCE_MAX_CHARS, NOTEBOOK_MAX_CELLS } from './tools';

export type NotebookCellType = 'code' | 'markdown' | 'raw';

export interface NotebookCellView {
  index: number;
  type: NotebookCellType;
  source: string;
  outputs: string[];
  truncated: boolean;
}

interface RawNotebookOutput {
  output_type?: unknown;
  text?: unknown;
  data?: unknown;
  ename?: unknown;
  evalue?: unknown;
  traceback?: unknown;
}

export interface RawNotebookDocument {
  cells: Array<Record<string, unknown>>;
  metadata: Record<string, unknown>;
  nbformat: number;
  nbformat_minor: number;
}

export class NotebookFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotebookFormatError';
  }
}

/** 把 nbformat 的 string | string[] source 归一化为单个字符串 */
function normalizeTextSource(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((line) => (typeof line === 'string' ? line : String(line))).join('');
  }
  if (value === undefined || value === null) return '';
  return String(value);
}

function toCellType(value: unknown): NotebookCellType {
  return value === 'markdown' || value === 'raw' ? value : 'code';
}

/** 从 execute_result / display_data 的 data 里提取 text/plain */
function extractPlainText(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const textPlain = (data as Record<string, unknown>)['text/plain'];
  return normalizeTextSource(textPlain);
}

/** 把单个 output 归一化为可读文本行 */
function normalizeOutput(raw: RawNotebookOutput): string | null {
  const outputType = typeof raw.output_type === 'string' ? raw.output_type : '';
  if (outputType === 'stream') {
    const text = normalizeTextSource(raw.text).replace(/\n$/, '');
    return text.length > 0 ? text : null;
  }
  if (outputType === 'execute_result' || outputType === 'display_data') {
    const text = extractPlainText(raw.data).replace(/\n$/, '');
    return text.length > 0 ? text : null;
  }
  if (outputType === 'error') {
    const name = typeof raw.ename === 'string' ? raw.ename : 'Error';
    const value = typeof raw.evalue === 'string' ? raw.evalue : '';
    const traceback = normalizeTextSource(raw.traceback);
    const lines = [`${name}: ${value}`];
    if (traceback.trim().length > 0) lines.push(traceback);
    return lines.join('\n');
  }
  return null;
}

/** 解析 .ipynb 文本为单元格视图；格式非法时抛出 NotebookFormatError */
export function readNotebookCells(raw: string): NotebookCellView[] {
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    throw new NotebookFormatError(
      `Invalid notebook JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!document || typeof document !== 'object' || !Array.isArray((document as Record<string, unknown>).cells)) {
    throw new NotebookFormatError('Invalid notebook: missing cells array');
  }
  const cells = (document as Record<string, unknown>).cells as Array<Record<string, unknown>>;
  if (cells.length > NOTEBOOK_MAX_CELLS) {
    throw new NotebookFormatError(`Notebook exceeds ${NOTEBOOK_MAX_CELLS} cells`);
  }

  return cells.map((cell, index) => {
    const fullSource = normalizeTextSource(cell.source);
    const truncated = fullSource.length > NOTEBOOK_CELL_SOURCE_MAX_CHARS;
    const outputs: string[] = [];
    if (Array.isArray(cell.outputs)) {
      for (const item of cell.outputs as RawNotebookOutput[]) {
        if (!item || typeof item !== 'object') continue;
        const text = normalizeOutput(item);
        if (text !== null) outputs.push(text);
      }
    }
    return {
      index,
      type: toCellType(cell.cell_type),
      source: truncated ? fullSource.slice(0, NOTEBOOK_CELL_SOURCE_MAX_CHARS) : fullSource,
      outputs,
      truncated,
    };
  });
}

/** 解析 .ipynb 文本为可编辑的原始文档结构 */
export function parseNotebookDocument(raw: string): RawNotebookDocument {
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    throw new NotebookFormatError(
      `Invalid notebook JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const record = document as Record<string, unknown>;
  if (!record || typeof record !== 'object' || !Array.isArray(record.cells)) {
    throw new NotebookFormatError('Invalid notebook: missing cells array');
  }
  return {
    cells: record.cells as Array<Record<string, unknown>>,
    metadata: (record.metadata && typeof record.metadata === 'object'
      ? record.metadata
      : {}) as Record<string, unknown>,
    nbformat: typeof record.nbformat === 'number' ? record.nbformat : 4,
    nbformat_minor: typeof record.nbformat_minor === 'number' ? record.nbformat_minor : 5,
  };
}

/** 序列化回 .ipynb 文本 */
export function serializeNotebookDocument(document: RawNotebookDocument): string {
  return `${JSON.stringify(document, null, 1)}\n`;
}

/** 构造一个新单元格（nbformat 4 结构） */
export function buildNotebookCell(
  cellType: NotebookCellType,
  source: string,
): Record<string, unknown> {
  const cell: Record<string, unknown> = {
    cell_type: cellType,
    metadata: {},
    source,
  };
  if (cellType === 'code') {
    cell.execution_count = null;
    cell.outputs = [];
  }
  return cell;
}

/** 校验写入操作后的单元格数量约束，超限抛出 NotebookFormatError */
export function assertNotebookCellLimit(cellCount: number): void {
  if (cellCount > NOTEBOOK_MAX_CELLS) {
    throw new NotebookFormatError(`Notebook exceeds ${NOTEBOOK_MAX_CELLS} cells`);
  }
}
