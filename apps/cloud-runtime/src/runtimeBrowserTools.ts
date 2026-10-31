import {
  errResult,
  BrowserUseArgsSchema,
  BrowserUseResultSchema,
  type ToolResult,
  type ToolName,
} from '@lca/tool-protocol';

export interface CloudRuntimeToolHandler {
  (args: unknown): Promise<ToolResult<unknown>>;
}

export interface RuntimeBrowserToolsOptions {
  /** 镜像内系统 Chromium 的可执行路径 */
  executablePath?: string;
  /** 浏览器用户数据目录；容器只读根文件系统时必须落在可写挂载点（如 /tmp） */
  userDataDir?: string;
}

interface PlaywrightLike {
  chromium: {
    launch(options: Record<string, unknown>): Promise<PlaywrightBrowser>;
    launchPersistentContext(
      userDataDir: string,
      options: Record<string, unknown>,
    ): Promise<PlaywrightContext>;
  };
}

interface PlaywrightBrowser {
  newContext(options?: Record<string, unknown>): Promise<PlaywrightContext>;
  close(): Promise<void>;
  isConnected(): boolean;
}

interface PlaywrightContext {
  newPage(): Promise<PlaywrightPage>;
  pages(): PlaywrightPage[];
  close(): Promise<void>;
}

interface PlaywrightPage {
  goto(url: string, options?: Record<string, unknown>): Promise<PlaywrightResponse | null>;
  click(selector: string, options?: Record<string, unknown>): Promise<void>;
  fill(selector: string, text: string, options?: Record<string, unknown>): Promise<void>;
  screenshot(options?: Record<string, unknown>): Promise<Buffer>;
  url(): string;
  title(): Promise<string>;
  viewportSize(): { width: number; height: number } | null;
  close(): Promise<void>;
}

interface PlaywrightResponse {
  status(): number;
}

/**
 * 云端 browser.use：无头 Chromium 单例 + 串行队列。
 * 容器内以非 root 运行，必须携带 --no-sandbox；userDataDir 落在 /tmp（emptyDir 可写挂载）。
 */
export class RuntimeBrowserTools {
  private browser: PlaywrightBrowser | null = null;
  private context: PlaywrightContext | null = null;
  private page: PlaywrightPage | null = null;
  private launchError: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: RuntimeBrowserToolsOptions = {}) {}

  handlers(): Partial<Record<ToolName, CloudRuntimeToolHandler>> {
    return {
      'browser.use': (args) => this.enqueue(args),
    };
  }

  /** 请求串行化：浏览器与页面都是单例，避免并发操作互相踩踏 */
  private enqueue(rawArgs: unknown): Promise<ToolResult<unknown>> {
    const task = this.queue.then(() => this.use(rawArgs));
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async use(rawArgs: unknown): Promise<ToolResult<unknown>> {
    const parsed = BrowserUseArgsSchema.safeParse(rawArgs);
    if (!parsed.success) return errResult('INVALID_ARGS', parsed.error.message);
    const { action } = parsed.data;

    if (action === 'close') {
      const message = await this.closeBrowser();
      return { ok: true, data: BrowserUseResultSchema.parse({ action, message }) };
    }

    let page: PlaywrightPage;
    try {
      page = await this.ensurePage();
    } catch (error) {
      return errResult(
        'NOT_IMPLEMENTED',
        `Browser unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      switch (action) {
        case 'goto': {
          if (!parsed.data.url) {
            return errResult('INVALID_ARGS', 'url is required for goto');
          }
          const response = await page.goto(parsed.data.url, {
            timeout: parsed.data.timeoutMs,
            waitUntil: 'load',
          });
          return {
            ok: true,
            data: BrowserUseResultSchema.parse({
              action,
              pageUrl: page.url(),
              message: `Page loaded with status ${response ? response.status() : 'unknown'}: ${await page.title()}`,
            }),
          };
        }
        case 'click': {
          if (!parsed.data.selector) {
            return errResult('INVALID_ARGS', 'selector is required for click');
          }
          await page.click(parsed.data.selector, { timeout: parsed.data.timeoutMs });
          return {
            ok: true,
            data: BrowserUseResultSchema.parse({
              action,
              pageUrl: page.url(),
              message: `Clicked ${parsed.data.selector}`,
            }),
          };
        }
        case 'type': {
          if (!parsed.data.selector || parsed.data.text === undefined) {
            return errResult('INVALID_ARGS', 'selector and text are required for type');
          }
          await page.fill(parsed.data.selector, parsed.data.text, { timeout: parsed.data.timeoutMs });
          return {
            ok: true,
            data: BrowserUseResultSchema.parse({
              action,
              pageUrl: page.url(),
              message: `Filled ${parsed.data.selector} with ${parsed.data.text.length} chars`,
            }),
          };
        }
        case 'screenshot': {
          const shot = await page.screenshot({ type: 'png', fullPage: false });
          const viewport = page.viewportSize();
          return {
            ok: true,
            data: BrowserUseResultSchema.parse({
              action,
              pageUrl: page.url(),
              image: shot.toString('base64'),
              ...(viewport ? { width: viewport.width, height: viewport.height } : {}),
            }),
          };
        }
        default:
          return errResult('INVALID_ARGS', `Unknown action: ${String(action)}`);
      }
    } catch (error) {
      return errResult(
        'INTERNAL',
        `browser.${action} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async ensurePage(): Promise<PlaywrightPage> {
    if (this.page) return this.page;
    if (this.launchError) throw new Error(this.launchError);

    const launchArgs = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'];
    const launchOptions: Record<string, unknown> = {
      headless: true,
      ...(this.options.executablePath ? { executablePath: this.options.executablePath } : {}),
      args: launchArgs,
    };

    try {
      const playwright = (await import('playwright-core')) as unknown as {
        default?: PlaywrightLike;
      } & PlaywrightLike;
      const chromium = playwright.chromium ?? playwright.default?.chromium;
      if (!chromium) throw new Error('playwright-core did not expose chromium');

      if (this.options.userDataDir) {
        // 持久化上下文：playwright 禁止在 launch 参数里传 --user-data-dir，
        // 必须走 launchPersistentContext；容器只读根文件系统时目录须落在可写挂载点
        this.context = await chromium.launchPersistentContext(
          this.options.userDataDir,
          { ...launchOptions, viewport: { width: 1280, height: 720 } },
        );
        this.page = this.context.pages()[0] ?? (await this.context.newPage());
      } else {
        this.browser = await chromium.launch(launchOptions);
        const context = await this.browser.newContext({
          viewport: { width: 1280, height: 720 },
        });
        this.page = await context.newPage();
      }
      return this.page;
    } catch (error) {
      this.launchError = error instanceof Error ? error.message : String(error);
      throw new Error(this.launchError);
    }
  }

  private async closeBrowser(): Promise<string> {
    this.page = null;
    if (this.context) {
      await this.context.close().catch(() => undefined);
      this.context = null;
      return 'Browser closed';
    }
    if (this.browser) {
      await this.browser.close().catch(() => undefined);
      this.browser = null;
      return 'Browser closed';
    }
    return 'No browser session was open';
  }
}
