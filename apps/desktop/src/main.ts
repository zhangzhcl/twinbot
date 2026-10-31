import { app, BrowserWindow, ipcMain, Menu, shell, type IpcMainInvokeEvent } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getOrCreateMachineId } from './machineId';
import { LocalAgent } from './localAgent';
import { ControlWsClient } from './wsClient';
import { ControlApiClient, UI_ALLOWED_CLOUD_TOOLS } from './controlApiClient';
import { isTrustedRendererFrame } from './rendererSecurity';

// Windows 分数缩放（125%/150%）下 GPU 合成会把文本栅格化到低分辨率层再放大，
// 造成整体发虚。禁用硬件加速后回退 DirectWrite 软件栅格，文字边缘恢复锐利；
// 界面为轻量静态 UI，无 GPU 密集场景。若后续引入重动效可移除此行。
app.disableHardwareAcceleration();

interface WindowBounds {
  width?: number;
  height?: number;
  x?: number;
  y?: number;
}

function windowStatePath(): string {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowBounds(): WindowBounds {
  try {
    const raw = fs.readFileSync(windowStatePath(), 'utf-8');
    const bounds = JSON.parse(raw) as WindowBounds;
    return bounds && typeof bounds === 'object' ? bounds : {};
  } catch {
    return {};
  }
}

function saveWindowBounds(win: BrowserWindow): void {
  try {
    // isNormal=false（最大化/全屏）时取还原态 bounds，避免把最大化尺寸存成常规尺寸
    const bounds = win.isMaximized() || win.isFullScreen()
      ? win.getNormalBounds()
      : win.getBounds();
    fs.mkdirSync(path.dirname(windowStatePath()), { recursive: true });
    fs.writeFileSync(windowStatePath(), JSON.stringify(bounds), 'utf-8');
  } catch (err) {
    console.warn('[main] failed to save window bounds:', err);
  }
}

function applyDesktopConfigObject(config: Record<string, unknown>): void {
  if (!process.env.CONTROL_API_URL && typeof config.CONTROL_API_URL === 'string') {
    process.env.CONTROL_API_URL = config.CONTROL_API_URL;
  }
  if (!process.env.CONTROL_WS_URL && typeof config.CONTROL_WS_URL === 'string') {
    process.env.CONTROL_WS_URL = config.CONTROL_WS_URL;
  }
  if (!process.env.CONTROL_TOKEN && typeof config.CONTROL_TOKEN === 'string') {
    process.env.CONTROL_TOKEN = config.CONTROL_TOKEN;
  }
  if (!process.env.LOCAL_WORKSPACE_ROOT && typeof config.LOCAL_WORKSPACE_ROOT === 'string') {
    process.env.LOCAL_WORKSPACE_ROOT = config.LOCAL_WORKSPACE_ROOT;
  }
}

function loadDesktopConfigFromPath(configPath: string): boolean {
  if (!fs.existsSync(configPath)) return false;
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw);
    if (config && typeof config === 'object') {
      applyDesktopConfigObject(config as Record<string, unknown>);
      console.log(`[config] loaded ${configPath}`);
      return true;
    }
  } catch (err) {
    console.warn(`[config] Failed to parse ${configPath}:`, err);
  }
  return false;
}

/**
 * Prefer Electron userData (credential-store style path), then cwd / package-local
 * desktop.config.json. Real tokens must not live in the git tree — see desktop.config.example.json.
 */
function loadDesktopConfig(): void {
  // 用户级配置（服务连接页写入 userData）优先于打包内置配置，让最终用户连自己的控制端
  const candidates = [
    path.join(app.getPath('userData'), 'desktop.config.json'),
    // Populated after app ready; also try common fallbacks before ready.
    path.join(process.cwd(), 'desktop.config.json'),
    path.join(__dirname, '..', 'desktop.config.json'),
    path.join(__dirname, 'desktop.config.json'),
    path.join(process.cwd(), 'apps', 'desktop', 'desktop.config.json'),
  ];
  for (const configPath of candidates) {
    if (loadDesktopConfigFromPath(configPath)) return;
  }
}

loadDesktopConfig();

let mainWindow: BrowserWindow | null = null;
let wsClient: ControlWsClient | null = null;
let apiClient: ControlApiClient | null = null;
let trustedRendererUrl = '';

function getControlApiClient(): ControlApiClient {
  if (apiClient) return apiClient;
  const baseUrl = process.env.CONTROL_API_URL ?? 'http://127.0.0.1:8787';
  const parsedUrl = new URL(baseUrl);
  const isLoopback =
    parsedUrl.hostname === 'localhost' ||
    parsedUrl.hostname === '127.0.0.1' ||
    parsedUrl.hostname === '[::1]';
  const token = process.env.CONTROL_TOKEN ?? (isLoopback ? 'dev-token' : '');
  apiClient = new ControlApiClient({ baseUrl, token });
  return apiClient;
}

function registerApiHandlers(): void {
  const assertTrustedRenderer = (event: IpcMainInvokeEvent): void => {
    if (!isTrustedRendererFrame(
      event.senderFrame,
      mainWindow?.webContents.mainFrame ?? null,
      trustedRendererUrl,
    )) {
      throw new Error('Untrusted renderer cannot access the Control API');
    }
  };

  ipcMain.handle('control-api:list-sessions', (event) => {
    assertTrustedRenderer(event);
    return getControlApiClient().listSessions();
  });
  ipcMain.handle('control-api:list-machines', (event) => {
    assertTrustedRenderer(event);
    return getControlApiClient().listMachines();
  });
  ipcMain.handle('control-api:list-runtimes', (event) => {
    assertTrustedRenderer(event);
    return getControlApiClient().listRuntimes();
  });
  ipcMain.handle('control-api:select-machine', (event, machineId: unknown) => {
    assertTrustedRenderer(event);
    if (machineId !== null && typeof machineId !== 'string') {
      throw new Error('Machine ID must be a string or null');
    }
    return getControlApiClient().selectMachine(machineId);
  });
  ipcMain.handle('control-api:select-runtime', (event, podId: unknown) => {
    assertTrustedRenderer(event);
    if (podId !== null && typeof podId !== 'string') {
      throw new Error('Pod ID must be a string or null');
    }
    return getControlApiClient().selectRuntime(podId);
  });
  ipcMain.handle('control-api:create-session', (event, title: unknown) => {
    assertTrustedRenderer(event);
    if (title !== undefined && typeof title !== 'string') {
      throw new Error('Session title must be a string');
    }
    return getControlApiClient().createSession(title);
  });
  ipcMain.handle('control-api:update-session-title', (event, sessionId: unknown, title: unknown) => {
    assertTrustedRenderer(event);
    if (typeof sessionId !== 'string' || !sessionId) {
      throw new Error('Session ID is required');
    }
    if (typeof title !== 'string' || !title) {
      throw new Error('Title is required');
    }
    return getControlApiClient().updateSessionTitle(sessionId, title);
  });
  ipcMain.handle('control-api:delete-session', (event, sessionId: unknown) => {
    assertTrustedRenderer(event);
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('Session ID is required');
    }
    return getControlApiClient().deleteSession(sessionId);
  });
  ipcMain.handle('control-api:get-model-config', (event) => {
    assertTrustedRenderer(event);
    return getControlApiClient().getModelConfig();
  });
  ipcMain.handle('control-api:save-model-config', (event, config: unknown) => {
    assertTrustedRenderer(event);
    if (!config || typeof config !== 'object') {
      throw new Error('Config must be an object');
    }
    return getControlApiClient().saveModelConfig(config as {
      provider: string;
      apiBaseUrl: string;
      apiKey: string;
      model: string;
    });
  });
  ipcMain.handle('control-api:list-model-profiles', (event) => {
    assertTrustedRenderer(event);
    return getControlApiClient().listModelProfiles();
  });
  ipcMain.handle('control-api:save-model-profile', (event, profile: unknown) => {
    assertTrustedRenderer(event);
    if (!profile || typeof profile !== 'object') {
      throw new Error('Profile must be an object');
    }
    return getControlApiClient().saveModelProfile(profile as {
      name: string;
      provider: string;
      apiBaseUrl: string;
      apiKey: string;
      model: string;
    });
  });
  ipcMain.handle('control-api:delete-model-profile', (event, profileId: unknown) => {
    assertTrustedRenderer(event);
    if (typeof profileId !== 'string' || profileId.length === 0) {
      throw new Error('Profile ID is required');
    }
    return getControlApiClient().deleteModelProfile(profileId);
  });
  ipcMain.handle('control-api:activate-model-profile', (event, profileId: unknown) => {
    assertTrustedRenderer(event);
    if (typeof profileId !== 'string' || profileId.length === 0) {
      throw new Error('Profile ID is required');
    }
    return getControlApiClient().activateModelProfile(profileId);
  });
  ipcMain.handle('control-api:list-messages', (event, sessionId: unknown) => {
    assertTrustedRenderer(event);
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('Session ID is required');
    }
    return getControlApiClient().listMessages(sessionId);
  });
  ipcMain.handle(
    'control-api:send-message',
    (event, sessionId: unknown, text: unknown) => {
      assertTrustedRenderer(event);
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        throw new Error('Session ID is required');
      }
      if (typeof text !== 'string' || text.trim().length === 0) {
        throw new Error('Message text is required');
      }
      return getControlApiClient().sendMessage(sessionId, text);
    },
  );
  ipcMain.handle('control-api:get-run', (event, runId: unknown) => {
    assertTrustedRenderer(event);
    if (typeof runId !== 'string' || runId.length === 0) {
      throw new Error('Run ID is required');
    }
    return getControlApiClient().getRun(runId);
  });
  ipcMain.handle('control-api:cancel-run', (event, runId: unknown) => {
    assertTrustedRenderer(event);
    if (typeof runId !== 'string' || runId.length === 0) {
      throw new Error('Run ID is required');
    }
    return getControlApiClient().cancelRun(runId);
  });

  ipcMain.on('local-tool:approval-response', (_event, requestId: unknown, decision: unknown) => {
    if (typeof requestId === 'string' && typeof decision === 'string') {
      ipcMain.emit(`local-tool:approval-response:${requestId}`, _event, decision);
    }
  });

  // user.ask 提问应答：与审批应答同模式，转发到按 requestId 命名的动态通道
  ipcMain.on(
    'local-tool:question-response',
    (_event, requestId: unknown, answer: unknown, choice: unknown) => {
      if (typeof requestId === 'string') {
        ipcMain.emit(`local-tool:question-response:${requestId}`, _event, answer, choice);
      }
    },
  );

  // 服务连接配置：读取生效值 / 保存到用户级配置文件（userData）/ 重启应用
  ipcMain.handle('app:get-connection-config', (event) => {
    assertTrustedRenderer(event);
    return {
      controlApiUrl: process.env.CONTROL_API_URL ?? '',
      controlWsUrl: process.env.CONTROL_WS_URL ?? '',
      token: process.env.CONTROL_TOKEN ?? '',
      hasToken: Boolean(process.env.CONTROL_TOKEN),
    };
  });
  ipcMain.handle('app:save-connection-config', (event, config: unknown) => {
    assertTrustedRenderer(event);
    if (!config || typeof config !== 'object') {
      throw new Error('Config must be an object');
    }
    const { controlApiUrl, controlWsUrl, token } = config as Record<string, unknown>;
    if (typeof controlApiUrl !== 'string' || !/^https?:\/\//.test(controlApiUrl)) {
      throw new Error('控制端 API 地址必须是 http(s):// 开头');
    }
    if (typeof controlWsUrl !== 'string' || !/^wss?:\/\//.test(controlWsUrl)) {
      throw new Error('控制端 WSS 地址必须是 ws(s):// 开头');
    }
    if (typeof token !== 'string' || token.trim().length < 8) {
      throw new Error('接入 Token 至少 8 位');
    }
    const configPath = path.join(app.getPath('userData'), 'desktop.config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          CONTROL_API_URL: controlApiUrl,
          CONTROL_WS_URL: controlWsUrl,
          CONTROL_TOKEN: token,
        },
        null,
        2,
      ),
      'utf-8',
    );
    return { saved: true };
  });
  ipcMain.handle('app:relaunch', (event) => {
    assertTrustedRenderer(event);
    app.relaunch();
    app.exit(0);
  });

  // 桌面端 UI 直连的只读工具通道（白名单与控制面一致）
  ipcMain.handle('preview:open-route', (event, sessionId: unknown) => {
    assertTrustedRenderer(event);
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('Session ID is required');
    }
    return getControlApiClient().openPreviewRoute(sessionId).then((route) => {
      void shell.openExternal(route.url);
      return route;
    });
  });

  ipcMain.handle('control-api:execute-cloud-tool', (event, tool: unknown, args: unknown) => {
    assertTrustedRenderer(event);
    if (typeof tool !== 'string' || !UI_ALLOWED_CLOUD_TOOLS.has(tool)) {
      throw new Error('tool is not allowed on the UI channel');
    }
    if (!args || typeof args !== 'object') {
      throw new Error('args must be an object');
    }
    return getControlApiClient().executeCloudTool(tool, args as Record<string, unknown>);
  });
}

function createWindow(): BrowserWindow {
  Menu.setApplicationMenu(null);

  const iconCandidates = [
    path.join(__dirname, '..', 'resources', 'icon.png'),
    path.join(__dirname, 'resources', 'icon.png'),
    path.join(__dirname, 'static', 'icon.png'),
    path.join(__dirname, '..', 'static', 'icon.png'),
  ];
  const icon = iconCandidates.find((p) => fs.existsSync(p));

  const savedBounds = loadWindowBounds();
  const win = new BrowserWindow({
    width: savedBounds.width ?? 1500,
    height: savedBounds.height ?? 900,
    ...(savedBounds.x !== undefined && savedBounds.y !== undefined
      ? { x: savedBounds.x, y: savedBounds.y }
      : {}),
    minWidth: 800,
    minHeight: 560,
    title: 'TwinBot',
    icon,
    autoHideMenuBar: true,
    backgroundColor: '#181818',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const candidates = [
    path.join(__dirname, 'static', 'index.html'),
    path.join(__dirname, '..', 'static', 'index.html'),
  ];
  const html =
    candidates.find((p) => fs.existsSync(p)) ?? candidates[0];
  const expectedUrl = pathToFileURL(html).href;
  trustedRendererUrl = expectedUrl;
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== expectedUrl) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  void win.loadFile(html);
  return win;
}

app.whenReady().then(() => {
  const userDataConfig = path.join(app.getPath('userData'), 'desktop.config.json');
  if (!process.env.CONTROL_TOKEN) {
    loadDesktopConfigFromPath(userDataConfig);
  }
  // Seed userData config from cwd example/local file once, without overwriting secrets.
  if (!fs.existsSync(userDataConfig)) {
    const seedCandidates = [
      path.join(process.cwd(), 'desktop.config.json'),
      path.join(__dirname, '..', '..', '..', 'desktop.config.json'),
    ];
    for (const seed of seedCandidates) {
      if (fs.existsSync(seed)) {
        try {
          fs.mkdirSync(path.dirname(userDataConfig), { recursive: true });
          fs.copyFileSync(seed, userDataConfig);
          console.log(`[config] seeded userData config from ${seed}`);
          loadDesktopConfigFromPath(userDataConfig);
        } catch (err) {
          console.warn('[config] failed to seed userData config:', err);
        }
        break;
      }
    }
  }

  registerApiHandlers();
  const machineId = getOrCreateMachineId();
  console.log(`[main] machineId=${machineId}`);

  mainWindow = createWindow();

  const workspaceRoot =
    process.env.LOCAL_WORKSPACE_ROOT?.trim() ||
    path.join(app.getPath('userData'), 'workspace');
  try {
    fs.mkdirSync(workspaceRoot, { recursive: true });
  } catch (err) {
    console.warn('[main] failed to ensure local workspace:', err);
  }
  console.log(`[main] local workspace root=${workspaceRoot}`);

  const localAgent = new LocalAgent(() => mainWindow, { workspaceRoot });
  localAgent.setMachineId(machineId);

  // 首次安装（任何来源都未配置 CONTROL_WS_URL）时暂不连控制面，
  // 等用户在「服务连接」页签完成配置并重启后再启动连接
  if (process.env.CONTROL_WS_URL) {
    wsClient = new ControlWsClient({
      machineId,
      localAgent,
      onSessionDelta: (sessionId, delta) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('session:delta', { sessionId, delta });
        }
      },
    });
    wsClient.start();
  } else {
    console.warn('[main] 未配置 CONTROL_WS_URL：等待「服务连接」页签完成首启配置');
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
    }
  });
});

app.on('before-quit', () => {
  if (mainWindow && !mainWindow.isDestroyed()) saveWindowBounds(mainWindow);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    wsClient?.stop();
    app.quit();
  }
});

app.on('before-quit', () => {
  wsClient?.stop();
});
