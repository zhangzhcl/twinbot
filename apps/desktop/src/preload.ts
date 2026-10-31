import { contextBridge, ipcRenderer } from 'electron';
import type {
  AcceptedMessage,
  MachineList,
  MessageRecord,
  ModelConfigProfile,
  ModelConfigRecord,
  RunRecord,
  SessionRecord,
  ToolCallResult,
} from './controlApiClient';

contextBridge.exposeInMainWorld('twinbot', {
  listSessions: (): Promise<SessionRecord[]> =>
    ipcRenderer.invoke('control-api:list-sessions'),
  listMachines: (): Promise<MachineList> =>
    ipcRenderer.invoke('control-api:list-machines'),
  listRuntimes: (): Promise<{ runtimes: Array<{ podId: string; capabilities: string[] }> }> =>
    ipcRenderer.invoke('control-api:list-runtimes'),
  cancelRun: (runId: string): Promise<RunRecord> =>
    ipcRenderer.invoke('control-api:cancel-run', runId),
  selectMachine: (machineId: string | null): Promise<{ selectedMachineId: string | null }> =>
    ipcRenderer.invoke('control-api:select-machine', machineId),
  selectRuntime: (podId: string | null): Promise<{ selectedRuntimeId: string | null }> =>
    ipcRenderer.invoke('control-api:select-runtime', podId),
  createSession: (title?: string): Promise<SessionRecord> =>
    ipcRenderer.invoke('control-api:create-session', title),
  updateSessionTitle: (sessionId: string, title: string): Promise<SessionRecord> =>
    ipcRenderer.invoke('control-api:update-session-title', sessionId, title),
  deleteSession: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke('control-api:delete-session', sessionId),
  getModelConfig: (): Promise<ModelConfigRecord> =>
    ipcRenderer.invoke('control-api:get-model-config'),
  saveModelConfig: (config: {
    provider: string;
    apiBaseUrl: string;
    apiKey: string;
    model: string;
  }): Promise<{ status: string; provider: string; model: string }> =>
    ipcRenderer.invoke('control-api:save-model-config', config),
  listModelProfiles: (): Promise<{ profiles: ModelConfigProfile[] }> =>
    ipcRenderer.invoke('control-api:list-model-profiles'),
  saveModelProfile: (profile: {
    name: string;
    provider: string;
    apiBaseUrl: string;
    apiKey: string;
    model: string;
  }): Promise<ModelConfigProfile> =>
    ipcRenderer.invoke('control-api:save-model-profile', profile),
  deleteModelProfile: (profileId: string): Promise<void> =>
    ipcRenderer.invoke('control-api:delete-model-profile', profileId),
  activateModelProfile: (
    profileId: string,
  ): Promise<{ status: string; profile: ModelConfigProfile }> =>
    ipcRenderer.invoke('control-api:activate-model-profile', profileId),
  listMessages: (sessionId: string): Promise<MessageRecord[]> =>
    ipcRenderer.invoke('control-api:list-messages', sessionId),
  sendMessage: (sessionId: string, text: string): Promise<AcceptedMessage> =>
    ipcRenderer.invoke('control-api:send-message', sessionId, text),
  getRun: (runId: string): Promise<RunRecord> =>
    ipcRenderer.invoke('control-api:get-run', runId),
  onLocalToolApproval: (
    callback: (request: {
      requestId: string;
      approvalId: string;
      tool: string;
      commandPreview: string;
      machineId: string;
      hostname: string;
    }) => void,
  ): (() => void) => {
    const listener = (
      _event: unknown,
      data: {
        requestId: string;
        approvalId: string;
        tool: string;
        commandPreview: string;
        machineId: string;
        hostname: string;
      },
    ) => callback(data);
    ipcRenderer.on('local-tool:request-approval', listener);
    return () => {
      ipcRenderer.removeListener('local-tool:request-approval', listener);
    };
  },
  respondLocalToolApproval: (
    requestId: string,
    decision: 'allow-once' | 'always-allow' | 'deny' | 'never',
  ): void => {
    ipcRenderer.send('local-tool:approval-response', requestId, decision);
  },
  onUserQuestion: (
    callback: (question: {
      requestId: string;
      question: string;
      choices: string[];
      allowFreeText: boolean;
      machineId: string;
    }) => void,
  ): (() => void) => {
    const listener = (
      _event: unknown,
      data: {
        requestId: string;
        question: string;
        choices: string[];
        allowFreeText: boolean;
        machineId: string;
      },
    ) => callback(data);
    ipcRenderer.on('local-tool:ask-question', listener);
    return () => {
      ipcRenderer.removeListener('local-tool:ask-question', listener);
    };
  },
  respondUserQuestion: (requestId: string, answer: string, choice?: string): void => {
    ipcRenderer.send('local-tool:question-response', requestId, answer, choice);
  },
  /** 读取生效的服务连接配置 */
  getConnectionConfig: (): Promise<{
    controlApiUrl: string;
    controlWsUrl: string;
    token: string;
    hasToken: boolean;
  }> => ipcRenderer.invoke('app:get-connection-config'),
  /** 保存服务连接配置到用户级文件（重启后生效） */
  saveConnectionConfig: (config: { controlApiUrl: string; controlWsUrl: string; token: string }): Promise<{ saved: boolean }> =>
    ipcRenderer.invoke('app:save-connection-config', config),
  /** 重启应用（保存连接配置后调用） */
  relaunchApp: (): Promise<void> => ipcRenderer.invoke('app:relaunch'),

  /** 打开产物：经控制面生成公网路由并在系统默认浏览器打开 */
  openArtifactInBrowser: (sessionId: string): Promise<{ url: string; port: number }> =>
    ipcRenderer.invoke('preview:open-route', sessionId),

  /** UI 直连只读工具调用（白名单校验在 preload/main/控制面三层） */
  executeCloudTool: (tool: string, args: Record<string, unknown>): Promise<ToolCallResult> =>
    ipcRenderer.invoke('control-api:execute-cloud-tool', tool, args),
  onSessionDelta: (
    callback: (payload: { sessionId: string; delta: unknown }) => void,
  ): (() => void) => {
    const listener = (_event: unknown, payload: { sessionId: string; delta: unknown }) => {
      callback(payload);
    };
    ipcRenderer.on('session:delta', listener);
    return () => {
      ipcRenderer.removeListener('session:delta', listener);
    };
  },
});
