/**
 * 轻量 glob 匹配器。
 *
 * 不能使用 Node 22 的 fs.glob：桌面端 Electron 33 内置 Node 20 没有该 API，
 * 因此在协议包内共享一份手写实现，保证桌面端与云端行为一致。
 *
 * 支持语法：**（跨目录）、* 与 ?（段内）、[a-z] / [!abc] 字符类、{a,b} 备选（支持嵌套）。
 * 路径分隔符统一按 '/' 处理。
 */

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 字符类内部仅需转义反斜杠与未配对的方括号语义字符；'-' 保留原样以支持区间 */
function escapeClassChar(text: string): string {
  return text.replace(/[\\\]]/g, '\\$&');
}

/** 找到与 pattern[start] 的 '{' 配对的 '}' 下标，未找到返回 -1 */
function findMatchingBrace(pattern: string, start: number): number {
  let depth = 0;
  for (let i = start; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 按深度 0 的逗号切分备选项 */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\') {
      current += ch + (text[i + 1] ?? '');
      i += 1;
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

function compileGlobSource(pattern: string): string {
  let source = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];

    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // '**/' 允许匹配零层或多层目录；裸 '**' 匹配任意剩余路径
        if (pattern[i + 2] === '/') {
          source += '(?:[^/]*/)*';
          i += 3;
        } else {
          source += '.*';
          i += 2;
        }
      } else {
        source += '[^/]*';
        i += 1;
      }
      continue;
    }

    if (ch === '?') {
      source += '[^/]';
      i += 1;
      continue;
    }

    if (ch === '[') {
      let j = i + 1;
      let cls = '';
      if (pattern[j] === '!' || pattern[j] === '^') {
        cls += '^';
        j += 1;
      }
      // 首位 ']' 是字面量
      if (pattern[j] === ']') {
        cls += '\\]';
        j += 1;
      }
      let closed = false;
      while (j < pattern.length) {
        if (pattern[j] === ']') {
          closed = true;
          break;
        }
        cls += escapeClassChar(pattern[j]);
        j += 1;
      }
      if (!closed) {
        // 未闭合的 '[' 当普通字符处理
        source += '\\[';
        i += 1;
        continue;
      }
      source += `[${cls}]`;
      i = j + 1;
      continue;
    }

    if (ch === '{') {
      const end = findMatchingBrace(pattern, i);
      if (end === -1) {
        source += '\\{';
        i += 1;
        continue;
      }
      const inner = pattern.slice(i + 1, end);
      const alternatives = splitTopLevel(inner)
        // 递归编译每个备选项，剥去锚点后拼接
        .map((part) => compileGlobSource(part))
        .join('|');
      source += `(?:${alternatives})`;
      i = end + 1;
      continue;
    }

    source += escapeRegExp(ch);
    i += 1;
  }
  return source;
}

/** 把 glob 模式编译为整串匹配的正则 */
export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/');
  return new RegExp(`^${compileGlobSource(normalized)}$`);
}

/** 判断候选路径（相对路径，正斜杠分隔）是否匹配 glob 模式 */
export function matchGlob(pattern: string, candidatePath: string): boolean {
  const normalizedPattern = pattern
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
  const normalizedCandidate = candidatePath
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
  return globToRegExp(normalizedPattern).test(normalizedCandidate);
}
