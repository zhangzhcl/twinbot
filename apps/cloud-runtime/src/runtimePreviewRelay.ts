import {
  PreviewHttpRequestMessageSchema,
  PreviewHttpResponseMessageSchema,
  type PreviewHttpRequestMessage,
  type PreviewHttpResponseMessage,
} from '@lca/ws-protocol';

/** 单次中继的响应体上限（字节）：base64 后约 6.7MB，低于网关 8MB WSS 消息上限 */
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);

export interface PreviewRelayDeps {
  /** 注入点：测试时替换 fetch */
  fetchImpl?: typeof fetch;
}

/**
 * 产物预览中继：接收控制面转发来的 preview.request，
 * fetch Pod 自身 loopback 端口上的产物服务并回传 preview.response。
 * 仅允许 127.0.0.1 目标；响应体超过上限即截断（truncated=true）。
 */
export class PreviewRelay {
  private readonly doFetch: typeof fetch;

  constructor(deps: PreviewRelayDeps = {}) {
    this.doFetch = deps.fetchImpl ?? fetch;
  }

  async handle(rawRequest: unknown): Promise<PreviewHttpResponseMessage> {
    const parsed = PreviewHttpRequestMessageSchema.safeParse(rawRequest);
    if (!parsed.success) {
      return this.errorResponse('relay-invalid', 400, `Invalid preview request: ${parsed.error.message}`);
    }
    const request: PreviewHttpRequestMessage = parsed.data;
    if (!ALLOWED_METHODS.has(request.method)) {
      return this.errorResponse(request.requestId, 405, `Method not allowed: ${request.method}`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await this.doFetch(
        `http://127.0.0.1:${request.port}${request.path}`,
        {
          method: request.method,
          headers: this.buildHeaders(request),
          body: request.bodyBase64 !== undefined && request.method !== 'GET' && request.method !== 'HEAD'
            ? Buffer.from(request.bodyBase64, 'base64')
            : undefined,
          signal: controller.signal,
          redirect: 'follow',
        },
      );
      const bodyBuffer = Buffer.from(await response.arrayBuffer());
      const truncated = bodyBuffer.byteLength > MAX_RESPONSE_BYTES;
      const payload = truncated ? bodyBuffer.subarray(0, MAX_RESPONSE_BYTES) : bodyBuffer;
      const message = PreviewHttpResponseMessageSchema.parse({
        type: 'preview.response',
        requestId: request.requestId,
        status: response.status,
        headers: this.pickResponseHeaders(response.headers),
        bodyBase64: payload.toString('base64'),
        ...(truncated ? { truncated: true } : {}),
      });
      return message;
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      return this.errorResponse(
        request.requestId,
        502,
        aborted
          ? `Upstream fetch timed out after ${FETCH_TIMEOUT_MS}ms`
          : `Preview fetch failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** 只透传对渲染有意义的头部，去掉分块/编码类（body 已解压为原始字节） */
  private pickResponseHeaders(headers: Headers): Record<string, string> {
    const picked: Record<string, string> = {};
    for (const name of ['content-type', 'location', 'cache-control', 'content-disposition']) {
      const value = headers.get(name);
      if (value) picked[name] = value;
    }
    return picked;
  }

  private buildHeaders(request: PreviewHttpRequestMessage): Record<string, string> {
    const headers: Record<string, string> = {};
    const contentType = request.headers['content-type'];
    if (contentType) headers['content-type'] = contentType;
    // 显式禁用压缩：本地代理按原始字节回传，无法解压 gzip
    headers['accept-encoding'] = 'identity';
    return headers;
  }

  private errorResponse(requestId: string, status: number, message: string): PreviewHttpResponseMessage {
    return PreviewHttpResponseMessageSchema.parse({
      type: 'preview.response',
      requestId,
      status,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      bodyBase64: Buffer.from(message, 'utf8').toString('base64'),
    });
  }
}
