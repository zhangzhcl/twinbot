import {
  errResult,
  WebFetchArgsSchema,
  WebFetchResultSchema,
  WebSearchArgsSchema,
  WebSearchResultSchema,
  type ToolResult,
  type ToolName,
} from '@lca/tool-protocol';

const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 TwinBotRuntime/1.0';

export interface CloudRuntimeToolHandler {
  (args: unknown): Promise<ToolResult<unknown>>;
}

export interface RuntimeWebToolsOptions {
  /** 注入点：测试时替换为 mock fetch */
  fetchImpl?: typeof fetch;
  /** Brave Search API Key；未配置时回退 DuckDuckGo HTML 解析 */
  searchApiKey?: string;
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** 云端 web.fetch / web.search：全部走 HTTPS，与 Pod 网络策略（仅放行 443）兼容 */
export class RuntimeWebTools {
  private readonly doFetch: typeof fetch;

  constructor(private readonly options: RuntimeWebToolsOptions = {}) {
    this.doFetch = options.fetchImpl ?? fetch;
  }

  handlers(): Partial<Record<ToolName, CloudRuntimeToolHandler>> {
    return {
      'web.fetch': (args) => this.fetchUrl(args),
      'web.search': (args) => this.search(args),
    };
  }

  async fetchUrl(rawArgs: unknown): Promise<ToolResult<unknown>> {
    const parsed = WebFetchArgsSchema.safeParse(rawArgs);
    if (!parsed.success) return errResult('INVALID_ARGS', parsed.error.message);

    const { url, maxBytes } = parsed.data;
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return errResult('INVALID_ARGS', `Invalid URL: ${url}`);
    }
    if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
      return errResult('INVALID_ARGS', 'Only http(s) URLs are supported');
    }

    try {
      const response = await this.doFetch(parsedUrl.toString(), {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: 'follow',
        headers: { 'user-agent': USER_AGENT, accept: '*/*' },
      });
      const contentType = response.headers.get('content-type') ?? undefined;
      const bodyBuffer = await this.readBodyWithCap(response, maxBytes);
      const asText = this.isTextContent(contentType);
      const truncated = bodyBuffer.truncated;

      const result = WebFetchResultSchema.parse({
        url: response.url || parsedUrl.toString(),
        status: response.status,
        ...(contentType ? { contentType } : {}),
        body: asText
          ? bodyBuffer.buffer.toString('utf8')
          : bodyBuffer.buffer.toString('base64'),
        encoding: asText ? 'utf8' : 'base64',
        truncated,
      });
      return { ok: true, data: result };
    } catch (error) {
      return errResult(
        'INTERNAL',
        `Fetch failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async search(rawArgs: unknown): Promise<ToolResult<unknown>> {
    const parsed = WebSearchArgsSchema.safeParse(rawArgs);
    if (!parsed.success) return errResult('INVALID_ARGS', parsed.error.message);

    const { query, count } = parsed.data;
    try {
      const results = this.options.searchApiKey
        ? await this.searchWithBrave(query, count)
        : await this.searchWithDuckDuckGo(query, count);
      return {
        ok: true,
        data: WebSearchResultSchema.parse({
          query,
          provider: this.options.searchApiKey ? 'brave' : 'duckduckgo',
          results,
        }),
      };
    } catch (error) {
      return errResult(
        'INTERNAL',
        `Search failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async searchWithBrave(query: string, count: number): Promise<SearchResult[]> {
    const endpoint = new URL('https://api.search.brave.com/res/v1/web/search');
    endpoint.searchParams.set('q', query);
    endpoint.searchParams.set('count', String(count));
    const response = await this.doFetch(endpoint.toString(), {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        accept: 'application/json',
        'x-subscription-token': this.options.searchApiKey ?? '',
        'user-agent': USER_AGENT,
      },
    });
    if (!response.ok) {
      throw new Error(`Brave API returned status ${response.status}`);
    }
    const payload = (await response.json()) as {
      web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
    };
    return (payload.web?.results ?? [])
      .slice(0, count)
      .map((item) => ({
        title: item.title ?? '',
        url: item.url ?? '',
        snippet: item.description ?? '',
      }))
      .filter((item) => item.url.length > 0);
  }

  private async searchWithDuckDuckGo(query: string, count: number): Promise<SearchResult[]> {
    const endpoint = new URL('https://html.duckduckgo.com/html/');
    endpoint.searchParams.set('q', query);
    const response = await this.doFetch(endpoint.toString(), {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': USER_AGENT,
      },
      body: new URLSearchParams({ q: query }).toString(),
    });
    if (!response.ok) {
      throw new Error(`DuckDuckGo returned status ${response.status}`);
    }
    return parseDuckDuckGoHtml(await response.text(), count);
  }

  private isTextContent(contentType?: string): boolean {
    if (!contentType) return true;
    if (contentType.startsWith('text/')) return true;
    return /application\/(json|xml|javascript|xhtml|rss|atom|yaml|toml|csv)/.test(contentType);
  }

  /** 分块读取响应体，超过上限立即停止，避免大响应撑爆内存 */
  private async readBodyWithCap(
    response: Response,
    maxBytes: number,
  ): Promise<{ buffer: Buffer; truncated: boolean }> {
    const body = response.body;
    if (!body) return { buffer: Buffer.alloc(0), truncated: false };

    const chunks: Buffer[] = [];
    let received = 0;
    let truncated = false;
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        const remaining = maxBytes - received;
        if (remaining <= 0) {
          truncated = true;
          break;
        }
        const slice = value.byteLength > remaining
          ? value.subarray(0, remaining)
          : value;
        chunks.push(Buffer.from(slice));
        received += slice.byteLength;
        if (slice.byteLength < value.byteLength) truncated = true;
      }
    } finally {
      // 中途停止读取时主动取消，释放底层连接
      if (truncated) await reader.cancel().catch(() => undefined);
    }
    return { buffer: Buffer.concat(chunks), truncated };
  }
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCharCode(Number(code)));
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, '')).trim();
}

/**
 * 解析 DuckDuckGo HTML 版搜索结果。
 * 链接多为 //duckduckgo.com/l/?uddg=<encodeURIComponent(target)> 跳转格式，需还原真实地址。
 */
export function parseDuckDuckGoHtml(html: string, count: number): SearchResult[] {
  const results: SearchResult[] = [];
  const blockPattern = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetPattern = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;

  const titles: Array<{ href: string; title: string }> = [];
  for (const match of html.matchAll(blockPattern)) {
    titles.push({ href: match[1], title: stripTags(match[2]) });
  }
  const snippets: string[] = [];
  for (const match of html.matchAll(snippetPattern)) {
    snippets.push(stripTags(match[1]));
  }

  for (let index = 0; index < titles.length && results.length < count; index += 1) {
    const { href, title } = titles[index];
    const url = resolveDuckDuckGoHref(href);
    if (!url || title.length === 0) continue;
    results.push({
      title,
      url,
      snippet: snippets[index] ?? '',
    });
  }
  return results;
}

function resolveDuckDuckGoHref(href: string): string | null {
  if (href.startsWith('//duckduckgo.com/l/') || href.startsWith('https://duckduckgo.com/l/')) {
    try {
      const parsed = new URL(href.startsWith('//') ? `https:${href}` : href);
      const target = parsed.searchParams.get('uddg');
      return target ? decodeURIComponent(target) : null;
    } catch {
      return null;
    }
  }
  if (href.startsWith('http://') || href.startsWith('https://')) return href;
  if (href.startsWith('//')) return `https:${href}`;
  return null;
}
