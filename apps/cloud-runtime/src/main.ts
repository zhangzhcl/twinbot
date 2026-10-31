import {
  CloudRuntimeClient,
  deriveRuntimeCapabilities,
} from './runtimeClient';
import { CloudRuntimeFileTools } from './runtimeFileTools';
import type { CloudRuntimeToolHandler } from './runtimeFileTools';
import { RuntimeShellTools } from './runtimeShellTools';
import { RuntimeCodeTools } from './runtimeCodeTools';
import { RuntimeWebTools } from './runtimeWebTools';
import { RuntimeBrowserTools } from './runtimeBrowserTools';
import { RuntimeLspTools } from './runtimeLspTools';
import { RuntimeVcsTools } from './runtimeVcsTools';
import { WorkspaceGuard } from './runtimeWorkspace';
import type { ToolName } from '@lca/tool-protocol';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const guard = new WorkspaceGuard(
  process.env.CLOUD_RUNTIME_WORKSPACE ?? process.cwd(),
);

/** 依赖懒加载成功才注册对应能力，避免 Pod 缺依赖时上报无法兑现的能力 */
async function tryLoadBrowserHandlers(): Promise<Partial<Record<ToolName, CloudRuntimeToolHandler>>> {
  try {
    await import('playwright-core');
    return new RuntimeBrowserTools({
      executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
      userDataDir: process.env.BROWSER_USER_DATA_DIR ?? '/tmp/twinbot-browser',
    }).handlers();
  } catch (error) {
    console.warn(
      '[cloud-runtime] playwright-core unavailable, browser.use disabled:',
      error instanceof Error ? error.message : String(error),
    );
    return {};
  }
}

async function tryLoadLspHandlers(): Promise<Partial<Record<ToolName, CloudRuntimeToolHandler>>> {
  try {
    await import('typescript');
    return new RuntimeLspTools(guard).handlers();
  } catch (error) {
    console.warn(
      '[cloud-runtime] typescript unavailable, lsp.query disabled:',
      error instanceof Error ? error.message : String(error),
    );
    return {};
  }
}

async function main(): Promise<void> {
  const fileTools = new CloudRuntimeFileTools(guard);
  const shellTools = new RuntimeShellTools(guard);
  const codeTools = new RuntimeCodeTools(guard);
  const webTools = new RuntimeWebTools({
    searchApiKey: process.env.WEB_SEARCH_API_KEY,
  });
  const vcsTools = new RuntimeVcsTools(guard);

  const toolHandlers: Partial<Record<ToolName, CloudRuntimeToolHandler>> = {
    ...fileTools.handlers(),
    ...shellTools.handlers(),
    ...codeTools.handlers(),
    ...webTools.handlers(),
    ...vcsTools.handlers(),
    ...(await tryLoadBrowserHandlers()),
    ...(await tryLoadLspHandlers()),
  };

  const capabilities = deriveRuntimeCapabilities(toolHandlers);
  const client = new CloudRuntimeClient({
    controlWsUrl: requiredEnvironment('CONTROL_WS_URL'),
    token: requiredEnvironment('CLOUD_RUNTIME_TOKEN'),
    podId: requiredEnvironment('CLOUD_RUNTIME_POD_ID'),
    toolHandlers,
    capabilities,
  });
  await client.start();
  console.log(
    `[cloud-runtime] connected to Control API (workspace=${guard.workspaceRoot}, capabilities=${capabilities.join(',')})`,
  );

  const shutdown = (): void => {
    client.stop();
    process.exitCode = 0;
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

void main().catch((error: unknown) => {
  console.error(
    '[cloud-runtime] startup failed:',
    error instanceof Error ? error.message : 'unknown error',
  );
  process.exitCode = 1;
});
