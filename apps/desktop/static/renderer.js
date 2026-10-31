const sessionList = document.getElementById('session-list');
const sessionTitle = document.getElementById('session-title');
const sessionSequence = document.getElementById('session-sequence');
const messagesElement = document.getElementById('messages');
const welcomeElement = document.getElementById('welcome');
const statusMessage = document.getElementById('status-message');
const connectionDot = document.getElementById('connection-dot');
const connectionLabel = document.getElementById('connection-label');
const deviceDot = document.getElementById('device-dot');
const deviceLabel = document.getElementById('device-label');
const deviceHostBadge = document.getElementById('device-host-badge');
const messageInput = document.getElementById('message-input');
const sendButton = document.getElementById('send-button');
const messageForm = document.getElementById('message-form');
const conversationBody = document.getElementById('conversation-body');
const composerWrapEl = document.getElementById('composer-wrap');
const newSessionButton = document.getElementById('new-session');

// 外观与主题
const themeToggleBtn = document.getElementById('theme-toggle-btn');
const themeIcon = document.getElementById('theme-icon');
const themeText = document.getElementById('theme-text');

// 设置弹窗
const settingsBtn = document.getElementById('settings-btn');
const settingsModalBackdrop = document.getElementById('settings-modal-backdrop');
const settingsBtnClose = document.getElementById('settings-btn-close');
const tabModelBtn = document.getElementById('tab-model-btn');
const tabAppearanceBtn = document.getElementById('tab-appearance-btn');
const settingsPaneModel = document.getElementById('settings-pane-model');
const settingsPaneAppearance = document.getElementById('settings-pane-appearance');
const settingBaseUrl = document.getElementById('setting-base-url');
const settingApiKey = document.getElementById('setting-api-key');
const toggleKeyVisibility = document.getElementById('toggle-key-visibility');
const settingModelName = document.getElementById('setting-model-name');
const modelSaveBtn = document.getElementById('model-save-btn');
const modelSaveProfileBtn = document.getElementById('model-save-profile-btn');
const modelSaveStatus = document.getElementById('model-save-status');
const modelProfileList = document.getElementById('model-profile-list');
const settingProfileName = document.getElementById('setting-profile-name');
const themeRadioDark = document.getElementById('theme-radio-dark');
const themeRadioLight = document.getElementById('theme-radio-light');

// 右侧 Pod 监控
const podDisplayName = document.getElementById('pod-display-name');
const podOnlineStatus = document.getElementById('pod-online-status');
const podCapabilities = document.getElementById('pod-capabilities');

const openArtifactBtn = document.getElementById('open-artifact-btn');
const modelListView = document.getElementById('model-list-view');
const modelFormView = document.getElementById('model-form-view');
const modelAddBtn = document.getElementById('model-add-btn');
const modelCancelBtn = document.getElementById('model-cancel-btn');
const tabConnectionBtn = document.getElementById('tab-connection-btn');
const settingsPaneConnection = document.getElementById('settings-pane-connection');
const connectionSaveBtn = document.getElementById('connection-save-btn');
const connectionSaveStatus = document.getElementById('connection-save-status');
const settingControlApi = document.getElementById('setting-control-api');
const settingControlWs = document.getElementById('setting-control-ws');
const settingControlToken = document.getElementById('setting-control-token');
const podTabs = document.querySelectorAll('.pod-tab');
const podTabContents = document.querySelectorAll('.pod-tab-content');
const clearTermButton = document.getElementById('clear-term-button');
const helpTermButton = document.getElementById('help-term-button');
const refreshPodButton = document.getElementById('refresh-pod-button');
const lastSyncTime = document.getElementById('last-sync-time');
const terminalLogs = document.getElementById('terminal-logs');
const terminalCmdForm = document.getElementById('terminal-cmd-form');
const terminalCmdInput = document.getElementById('terminal-cmd-input');

// 审批弹窗 DOM 节点
const approvalModalBackdrop = document.getElementById('approval-modal-backdrop');
const approvalMachineId = document.getElementById('approval-machine-id');
const approvalCodeText = document.getElementById('approval-code-text');
const approvalBtnClose = document.getElementById('approval-btn-close');
const approvalBtnNever = document.getElementById('approval-btn-never');
const approvalBtnAlways = document.getElementById('approval-btn-always');
const approvalBtnOnce = document.getElementById('approval-btn-once');

let sessions = [];
let activeSessionId = null;
let selectedRuntimeId = null;
let runDeltaWaiters = new Map(); // runId -> { resolve, status }
let sending = false;
let activeRunId = null;
let currentApprovalRequestId = null;
let currentLoadedModel = 'glm-5.3-flash';

// 终端命令历史与交互
const cmdHistory = [];
let cmdHistoryIndex = -1;

// 一次性提示的自动清除定时器（需在顶层 showStatus 调用前声明）
let statusClearTimer = null;

// 非 TwinBot 桌面环境（如浏览器直接打开）时降级提示
if (!window.twinbot) {
  setConnected(false);
  showStatus('请从 TwinBot 桌面应用启动；安全 IPC 桥当前不可用。', true);
  if (newSessionButton) newSessionButton.disabled = true;
  if (messageInput) messageInput.disabled = true;
  if (sendButton) sendButton.disabled = true;
}

function showStatus(message, isError = false) {
  if (!statusMessage) return;
  statusMessage.textContent = message;
  statusMessage.classList.toggle('error', isError);
  // 非错误的一次性提示自动消失，避免输入框上方常驻状态文本
  if (statusClearTimer) clearTimeout(statusClearTimer);
  if (!isError && message) {
    statusClearTimer = setTimeout(() => {
      statusMessage.textContent = '';
      statusClearTimer = null;
    }, 4000);
  }
}

// ===== 运行期状态行：渲染在消息流末尾，回复到达后撤掉 =====
let runStatusText = null;

function buildStatusRow(text) {
  const row = document.createElement('div');
  row.className = 'message message-status';
  const dots = document.createElement('span');
  dots.className = 'status-dots';
  dots.setAttribute('aria-hidden', 'true');
  dots.innerHTML = '<span></span><span></span><span></span>';
  const label = document.createElement('span');
  label.className = 'status-text';
  label.textContent = text;
  row.append(dots, label);
  return row;
}

function showRunStatus(text) {
  runStatusText = text;
  const scroller = document.getElementById('conversation-body');
  const existing = messagesElement?.querySelector('.message-status');
  if (existing) {
    existing.querySelector('.status-text').textContent = text;
  } else if (messagesElement) {
    messagesElement.append(buildStatusRow(text));
  }
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
}

function clearRunStatus() {
  runStatusText = null;
  messagesElement?.querySelector('.message-status')?.remove();
}

function setConnected(connected) {
  if (connectionDot) {
    connectionDot.classList.toggle('connected', connected);
  }
  if (connectionLabel) {
    connectionLabel.textContent = connected ? '云端引擎就绪' : '云端引擎连接中';
  }
}

// 终端流式日志输出
function appendTerminalLog(text, level = 'info') {
  if (!terminalLogs) return;
  const p = document.createElement('p');
  p.className = `term-line term-${level}`;
  const now = new Date().toLocaleTimeString();
  const tagMap = {
    system: '[SYS]',
    info: '[INFO]',
    success: '[OK]',
    tool: '[TOOL]',
    agent: '[AGENT]',
    error: '[ERR]',
    cmd: '[CMD]',
  };
  const tag = tagMap[level] || '[LOG]';
  p.innerHTML = `<span class="term-tag">${tag}</span> [${now}] ${escapeHtml(text)}`;
  terminalLogs.append(p);
  terminalLogs.scrollTop = terminalLogs.scrollHeight;
}

// 转义 HTML 辅助函数
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 轻量级 Markdown 渲染器（支持代码块、行内代码、粗体、无序列表）
function formatMarkdown(text) {
  if (!text) return '';
  const escaped = escapeHtml(text);

  const codeBlocks = [];
  const withCodeBlocks = escaped.replace(/```([\w-]*)\n([\s\S]*?)```/g, (_match, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(
      `<div class="code-block-wrap"><div class="code-lang-tag">${lang || 'code'}</div><pre><code class="lang-${lang || 'text'}">${code.trim()}</code></pre></div>`,
    );
    return `__CODE_BLOCK_${idx}__`;
  });

  const withInline = withCodeBlocks
    .replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');

  const restored = withInline.replace(/__CODE_BLOCK_(\d+)__/g, (_match, id) => {
    return codeBlocks[Number(id)] || '';
  });

  const parts = restored.split(/\n{2,}/);
  return parts
    .map((part) => {
      if (part.startsWith('<div class="code-block-wrap">')) {
        return part;
      }
      if (part.includes('\n- ') || part.includes('\n* ') || part.startsWith('- ') || part.startsWith('* ')) {
        const lines = part.split('\n');
        const listItems = lines
          .map((l) => {
            const t = l.trim();
            if (t.startsWith('- ') || t.startsWith('* ')) {
              return `<li>${t.slice(2)}</li>`;
            }
            return l;
          })
          .join('');
        return `<ul>${listItems}</ul>`;
      }
      return `<p>${part.replace(/\n/g, '<br/>')}</p>`;
    })
    .join('');
}

// 外观深浅色主题切换
function initTheme() {
  const savedTheme = localStorage.getItem('twinbot_theme') || 'dark';
  applyTheme(savedTheme);

  themeToggleBtn?.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const nextTheme = current === 'dark' ? 'light' : 'dark';
    applyTheme(nextTheme);
    appendTerminalLog(`外观风格已切换为: ${nextTheme === 'dark' ? '深色模式' : '浅色模式'}`, 'info');
  });

  themeRadioDark?.addEventListener('change', () => {
    if (themeRadioDark.checked) applyTheme('dark');
  });
  themeRadioLight?.addEventListener('change', () => {
    if (themeRadioLight.checked) applyTheme('light');
  });
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('twinbot_theme', theme);
  const isDark = theme === 'dark';
  if (themeIcon) themeIcon.textContent = isDark ? '☼' : '☾';
  if (themeText) themeText.textContent = isDark ? '浅色外观' : '深色外观';
  if (themeRadioDark) themeRadioDark.checked = isDark;
  if (themeRadioLight) themeRadioLight.checked = !isDark;
}

// 模型配置与设置弹窗逻辑
function initSettingsModal() {
  settingsBtn?.addEventListener('click', async () => {
    if (settingsModalBackdrop) {
      settingsModalBackdrop.hidden = false;
      await loadModelConfigToForm();
    }
  });

  settingsBtnClose?.addEventListener('click', () => {
    if (settingsModalBackdrop) settingsModalBackdrop.hidden = true;
    if (modelSaveStatus) modelSaveStatus.textContent = '';
  });

  settingsModalBackdrop?.addEventListener('click', (e) => {
    if (e.target === settingsModalBackdrop) {
      settingsModalBackdrop.hidden = true;
      if (modelSaveStatus) modelSaveStatus.textContent = '';
    }
  });

  const activateSettingsPane = (pane) => {
    for (const [tabBtn, paneEl] of [[
      tabModelBtn, settingsPaneModel
    ], [tabAppearanceBtn, settingsPaneAppearance], [tabConnectionBtn, settingsPaneConnection]]) {
      const isActive = paneEl && paneEl.id === `settings-pane-${pane}`;
      tabBtn?.classList.toggle('active', isActive);
      if (paneEl) paneEl.hidden = !isActive;
    }
    if (pane === 'model') void loadModelConfigToForm();
  };

  tabModelBtn?.addEventListener('click', () => activateSettingsPane('model'));

  tabAppearanceBtn?.addEventListener('click', () => activateSettingsPane('appearance'));

  tabConnectionBtn?.addEventListener('click', () => activateSettingsPane('connection'));

  connectionSaveBtn?.addEventListener('click', async () => {
    if (!window.twinbot?.saveConnectionConfig) return;
    const controlApiUrl = settingControlApi?.value?.trim() || '';
    const controlWsUrl = settingControlWs?.value?.trim() || '';
    const token = settingControlToken?.value?.trim() || '';
    if (connectionSaveStatus) connectionSaveStatus.style.color = 'var(--text-error, #f87171)';
    if (!/^https?:\/\//.test(controlApiUrl)) {
      if (connectionSaveStatus) connectionSaveStatus.textContent = 'API 地址必须以 http:// 或 https:// 开头';
      return;
    }
    if (!/^wss?:\/\//.test(controlWsUrl)) {
      if (connectionSaveStatus) connectionSaveStatus.textContent = 'WSS 地址必须以 ws:// 或 wss:// 开头';
      return;
    }
    if (token.length < 8) {
      if (connectionSaveStatus) connectionSaveStatus.textContent = '接入 Token 至少 8 位';
      return;
    }
    connectionSaveBtn.disabled = true;
    if (connectionSaveStatus) {
      connectionSaveStatus.textContent = '正在保存…';
      connectionSaveStatus.style.color = 'var(--text-dim)';
    }
    try {
      await window.twinbot.saveConnectionConfig({ controlApiUrl, controlWsUrl, token });
      if (connectionSaveStatus) {
        connectionSaveStatus.textContent = '已保存，应用即将重启以连接新服务器…';
        connectionSaveStatus.style.color = 'var(--success, #4ade80)';
      }
      setTimeout(() => void window.twinbot?.relaunchApp?.(), 1200);
    } catch (err) {
      if (connectionSaveStatus) {
        connectionSaveStatus.textContent = `保存失败: ${err instanceof Error ? err.message : String(err)}`;
      }
      connectionSaveBtn.disabled = false;
    }
  });

  async function loadConnectionConfigToForm() {
    if (!window.twinbot?.getConnectionConfig) return;
    try {
      const config = await window.twinbot.getConnectionConfig();
      if (settingControlApi) settingControlApi.value = config.controlApiUrl || '';
      if (settingControlWs) settingControlWs.value = config.controlWsUrl || '';
      if (settingControlToken) settingControlToken.value = config.token || '';
      return config;
    } catch {
      return null;
    }
  }
  void loadConnectionConfigToForm();

  toggleKeyVisibility?.addEventListener('click', () => {
    if (!settingApiKey) return;
    const isPassword = settingApiKey.type === 'password';
    settingApiKey.type = isPassword ? 'text' : 'password';
    toggleKeyVisibility.textContent = isPassword ? '🔒' : '👁';
  });

  modelSaveBtn?.addEventListener('click', async () => {
    await saveModelProfileFromForm(true);
  });
}

async function loadModelConfigToForm() {
  if (!window.twinbot?.getModelConfig) return;
  try {
    const config = await window.twinbot.getModelConfig();
    if (config) {
      currentLoadedModel = config.model || 'glm-5.3-flash';
      updateComposerModelName(currentLoadedModel);
    }
  } catch (err) {
    console.warn('获取模型配置失败:', err);
  }
  await loadModelProfiles();
}

// ===== 多套模型配置档案：保存多组供应商/密钥/模型，一键切换给云端 Agent 使用 =====

async function loadModelProfiles() {
  if (!modelProfileList) return;
  if (!window.twinbot?.listModelProfiles) {
    modelProfileList.innerHTML = '<p class="model-profile-empty">当前客户端版本不支持多配置档案</p>';
    return;
  }
  try {
    const { profiles } = await window.twinbot.listModelProfiles();
    let active = null;
    try {
      active = await window.twinbot.getModelConfig();
    } catch {
      active = null;
    }
    const isActiveProfile = (profile) =>
      Boolean(active) &&
      profile.provider === active.provider &&
      profile.apiBaseUrl === active.apiBaseUrl &&
      profile.apiKey === active.apiKey &&
      profile.model === active.model;

    modelProfileList.replaceChildren();
    if (!profiles.length) {
      const empty = document.createElement('p');
      empty.className = 'model-profile-empty';
      empty.textContent = '还没有保存的配置，点右上角「＋ 添加配置」创建。';
      modelProfileList.append(empty);
      return;
    }
    for (const profile of profiles) {
      const row = document.createElement('div');
      row.className = 'model-profile-item';

      const info = document.createElement('div');
      info.className = 'model-profile-info';
      const nameSpan = document.createElement('span');
      nameSpan.className = 'model-profile-name';
      nameSpan.textContent = profile.name;
      const metaSpan = document.createElement('span');
      metaSpan.className = 'model-profile-meta';
      metaSpan.textContent = `${profile.provider === 'openai-compatible' ? 'OpenAI 兼容' : profile.provider} · ${profile.model}`;
      info.append(nameSpan, metaSpan);

      const actions = document.createElement('div');
      actions.className = 'model-profile-actions';
      if (isActiveProfile(profile)) {
        const badge = document.createElement('span');
        badge.className = 'model-profile-active-badge';
        badge.textContent = '使用中';
        actions.append(badge);
      }
      const activateBtn = document.createElement('button');
      activateBtn.type = 'button';
      activateBtn.className = 'model-profile-btn';
      activateBtn.textContent = '启用';
      activateBtn.addEventListener('click', () => void activateModelProfileById(profile.id, profile.name));
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'model-profile-btn';
      editBtn.textContent = '编辑';
      editBtn.addEventListener('click', () => editModelProfile(profile));
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'model-profile-btn danger';
      deleteBtn.textContent = '删除';
      deleteBtn.addEventListener('click', () => void deleteModelProfileById(profile.id, profile.name));
      actions.append(activateBtn, editBtn, deleteBtn);

      row.append(info, actions);
      modelProfileList.append(row);
    }
  } catch (err) {
    console.warn('加载模型配置档案失败:', err);
  }
}

async function activateModelProfileById(profileId, name) {
  if (!window.twinbot?.activateModelProfile) return;
  if (modelSaveStatus) {
    modelSaveStatus.textContent = `正在启用「${name}」…`;
    modelSaveStatus.style.color = 'var(--text-dim)';
  }
  try {
    const result = await window.twinbot.activateModelProfile(profileId);
    const profile = result?.profile;
    if (profile) {
      if (settingBaseUrl) settingBaseUrl.value = profile.apiBaseUrl || '';
      if (settingApiKey) settingApiKey.value = profile.apiKey || '';
      if (settingModelName) settingModelName.value = profile.model || '';
      currentLoadedModel = profile.model;
      updateRuntimeBadge(profile.model);
    }
    if (modelSaveStatus) {
      modelSaveStatus.textContent = `已启用「${name}」，云端 Agent 将使用该模型`;
      modelSaveStatus.style.color = 'var(--success, #4ade80)';
    }
    appendTerminalLog(`模型配置档案已启用: ${name}`, 'agent');
    await loadModelProfiles();
  } catch (err) {
    if (modelSaveStatus) {
      modelSaveStatus.textContent = '启用失败，请稍后重试。';
      modelSaveStatus.style.color = 'var(--text-error, #f87171)';
    }
    appendTerminalLog(`启用模型档案失败: ${err instanceof Error ? err.message : String(err)}`, 'error');
  }
}

function editModelProfile(profile) {
  showModelForm('edit');
  if (settingProfileName) settingProfileName.value = profile.name;
  if (settingBaseUrl) settingBaseUrl.value = profile.apiBaseUrl || '';
  if (settingApiKey) settingApiKey.value = profile.apiKey || '';
  if (settingModelName) settingModelName.value = profile.model || '';
}

async function deleteModelProfileById(profileId, name) {
  if (!window.twinbot?.deleteModelProfile) return;
  if (!window.confirm(`删除配置档案「${name}」？当前生效的模型不受影响。`)) return;
  try {
    await window.twinbot.deleteModelProfile(profileId);
    appendTerminalLog(`模型配置档案已删除: ${name}`, 'info');
  } catch (err) {
    appendTerminalLog(`删除模型档案失败: ${err instanceof Error ? err.message : String(err)}`, 'error');
  }
  await loadModelProfiles();
}

async function saveModelProfileFromForm(activate) {
  if (!window.twinbot?.saveModelProfile) return;
  const name = settingProfileName?.value?.trim() || '';
  const baseUrl = settingBaseUrl?.value?.trim() || '';
  const apiKey = settingApiKey?.value?.trim() || '';
  const model = settingModelName?.value?.trim() || '';

  if (modelSaveStatus) modelSaveStatus.style.color = 'var(--text-error, #f87171)';
  if (!name) {
    if (modelSaveStatus) modelSaveStatus.textContent = '请填写配置名称';
    return;
  }
  if (!apiKey) {
    if (modelSaveStatus) modelSaveStatus.textContent = '请填写 API Key';
    return;
  }
  if (!model) {
    if (modelSaveStatus) modelSaveStatus.textContent = '请填写模型标识';
    return;
  }

  modelSaveProfileBtn.disabled = true;
  if (modelSaveBtn) modelSaveBtn.disabled = true;
  if (modelSaveStatus) {
    modelSaveStatus.textContent = activate ? '正在保存并启用…' : '正在保存配置…';
    modelSaveStatus.style.color = 'var(--text-dim)';
  }

  try {
    const profile = await window.twinbot.saveModelProfile({
      name,
      provider: 'openai-compatible',
      apiBaseUrl: baseUrl,
      apiKey,
      model,
    });
    if (activate) {
      await window.twinbot.activateModelProfile(profile.id);
      currentLoadedModel = model;
      updateComposerModelName(model);
    }
    modelFormSaved = true;
    if (modelSaveStatus) {
      modelSaveStatus.textContent = activate
        ? `已保存并启用「${name}」，云端 Agent 下一次对话使用该模型`
        : `已保存配置「${name}」（未启用），可在列表或输入框旁随时启用`;
      modelSaveStatus.style.color = 'var(--success, #4ade80)';
    }
    appendTerminalLog(`模型配置已${activate ? '保存并启用' : '保存'}: ${name} (${model})`, 'agent');
    await loadModelProfiles();
    if (activate) {
      setTimeout(() => {
        if (settingsModalBackdrop) settingsModalBackdrop.hidden = true;
        if (modelSaveStatus) modelSaveStatus.textContent = '';
        showModelList();
      }, 1400);
    } else {
      showModelList();
    }
  } catch (err) {
    if (modelSaveStatus) {
      modelSaveStatus.textContent = '保存失败，请稍后重试。';
      modelSaveStatus.style.color = 'var(--text-error, #f87171)';
    }
    appendTerminalLog(`保存模型档案失败: ${err instanceof Error ? err.message : String(err)}`, 'error');
  } finally {
    modelSaveProfileBtn.disabled = false;
    if (modelSaveBtn) modelSaveBtn.disabled = false;
  }
}

modelCancelBtn?.addEventListener('click', () => showModelList());
modelAddBtn?.addEventListener('click', () => showModelForm('add'));
if (modelSaveProfileBtn) {
  modelSaveProfileBtn.addEventListener('click', () => void saveModelProfileFromForm(false));
}
if (modelSaveBtn) {
  modelSaveBtn.addEventListener('click', () => void saveModelProfileFromForm(true));
}

function updateRuntimeBadge(modelName) {
  // 顶栏徽章已移除：模型名在「设置」弹窗中查看
  void modelName;
}

// 渲染会话列表
function renderSessions() {
  if (!sessionList) return;
  sessionList.replaceChildren();
  if (sessions.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-sessions';
    empty.textContent = '还没有对话';
    sessionList.append(empty);
  } else {
    for (const session of sessions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'session-button';
      button.title = session.title || '新对话';
      button.setAttribute(
        'aria-current',
        session.id === activeSessionId ? 'page' : 'false',
      );

      const iconSpan = document.createElement('span');
      iconSpan.className = 'session-item-icon';
      iconSpan.setAttribute('aria-hidden', 'true');
      iconSpan.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;

      const titleSpan = document.createElement('span');
      titleSpan.className = 'session-item-title';
      titleSpan.textContent = session.title || '新对话';

      const deleteSpan = document.createElement('span');
      deleteSpan.className = 'session-delete-btn';
      deleteSpan.setAttribute('role', 'button');
      deleteSpan.setAttribute('aria-label', `删除会话 ${session.title || '新对话'}`);
      deleteSpan.title = '删除会话';
      deleteSpan.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>`;
      deleteSpan.addEventListener('click', (event) => {
        event.stopPropagation();
        void deleteSessionById(session.id, session.title, event.currentTarget);
      });

      button.append(iconSpan, titleSpan, deleteSpan);
      button.addEventListener('click', () => {
        void selectSession(session.id);
      });
      sessionList.append(button);
    }
  }
}

// 删除会话确认弹窗：替代原生 confirm，Promise 风格供删除流程等待
const deleteConfirmBackdrop = document.getElementById('delete-confirm-backdrop');
const deleteConfirmTitle = document.getElementById('delete-confirm-title');
let deleteConfirmResolver = null;

function showDeleteConfirmModal(title, anchorEl) {
  return new Promise((resolve) => {
    deleteConfirmResolver = resolve;
    if (deleteConfirmTitle) {
      deleteConfirmTitle.textContent = `删除会话「${title || '新对话'}」？`;
    }
    if (deleteConfirmBackdrop) {
      const card = deleteConfirmBackdrop.querySelector('.delete-confirm-pop');
      deleteConfirmBackdrop.hidden = false;
      if (card) {
        // 先以 visibility 隐藏完成测量定位，再揭示并重播弹出动画，
        // 避免卡片先在旧位置渲染、动画播完才跳到锚点的"从上闪一下"
        card.style.animation = 'none';
        card.style.visibility = 'hidden';
        positionDeleteConfirm(anchorEl);
        card.style.visibility = '';
        card.style.animation = '';
      }
    }
  });
}

/* 把确认卡片定位到触发 its 的会话行旁：优先行下方，越界时上移/左收 */
function positionDeleteConfirm(anchorEl) {
  const card = deleteConfirmBackdrop?.querySelector('.delete-confirm-pop');
  if (!anchorEl || !card) return;
  const anchor = anchorEl.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();
  const margin = 8;
  let left = anchor.right + 8 - cardRect.width;
  left = Math.max(margin, Math.min(left, window.innerWidth - cardRect.width - margin));
  let top = anchor.bottom + 6;
  if (top + cardRect.height > window.innerHeight - margin) {
    top = Math.max(margin, anchor.top - cardRect.height - 6);
  }
  card.style.left = `${Math.round(left)}px`;
  card.style.top = `${Math.round(top)}px`;
}

function settleDeleteConfirm(decision) {
  if (deleteConfirmBackdrop) deleteConfirmBackdrop.hidden = true;
  if (deleteConfirmResolver) {
    deleteConfirmResolver(decision);
    deleteConfirmResolver = null;
  }
}

document.getElementById('delete-confirm-btn-close')?.addEventListener('click', () => settleDeleteConfirm(false));
document.getElementById('delete-confirm-btn-cancel')?.addEventListener('click', () => settleDeleteConfirm(false));
document.getElementById('delete-confirm-btn-ok')?.addEventListener('click', () => settleDeleteConfirm(true));
deleteConfirmBackdrop?.addEventListener('click', (event) => {
  if (event.target === deleteConfirmBackdrop) settleDeleteConfirm(false);
});

// 删除会话：应用内确认弹窗，成功后刷新列表并清空被删会话的展示
async function deleteSessionById(sessionId, title, anchorEl) {
  if (!window.twinbot?.deleteSession) return;
  const confirmed = await showDeleteConfirmModal(title, anchorEl);
  if (!confirmed) return;
  try {
    await window.twinbot.deleteSession(sessionId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('SESSION_RUN_IN_PROGRESS')) {
      showStatus('该会话有任务进行中，请先取消任务再删除。');
    } else {
      showStatus('删除会话失败，请稍后重试。');
    }
    appendTerminalLog(`删除会话失败: ${message.slice(0, 120)}`, 'error');
    return;
  }
  appendTerminalLog(`会话已删除: "${title || '新对话'}"`, 'info');
  if (activeSessionId === sessionId) {
    activeSessionId = null;
    activeRunId = null;
    if (messagesElement) messagesElement.replaceChildren();
    if (sessionTitle) sessionTitle.textContent = '新对话';
    if (sessionSequence) sessionSequence.textContent = '/ 00';
  }
  sessions = sessions.filter((item) => item.id !== sessionId);
  renderSessions();
}

// 加载并呈现单机状态指示
async function loadMachines() {
  try {
    const result = await window.twinbot.listMachines();
    const machines = result.machines || [];
    const isConnected = machines.length > 0;

    if (deviceDot) {
      deviceDot.classList.toggle('connected', isConnected);
    }
    if (deviceLabel) {
      deviceLabel.textContent = isConnected ? '本机设备已连接' : '本机设备未连接';
    }
    if (deviceHostBadge) {
      if (isConnected && machines[0]) {
        deviceHostBadge.textContent = machines[0].label || machines[0].machineId.slice(0, 8);
      } else {
        deviceHostBadge.textContent = '未连接';
      }
    }
  } catch (error) {
    if (deviceDot) deviceDot.classList.remove('connected');
    if (deviceLabel) deviceLabel.textContent = '本机设备未连接';
    if (deviceHostBadge) deviceHostBadge.textContent = '未连接';
  }
}

function formatMessageTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function buildMessageActions(message) {
  const bar = document.createElement('div');
  bar.className = 'message-actions';
  const copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.className = 'message-action-btn';
  copyButton.textContent = '复制';
  copyButton.addEventListener('click', () => {
    void navigator.clipboard.writeText(message.text).then(() => {
      copyButton.textContent = '已复制';
      setTimeout(() => {
        copyButton.textContent = '复制';
      }, 1200);
    }).catch(() => {
      copyButton.textContent = '复制失败';
    });
  });
  const time = document.createElement('span');
  time.className = 'message-action-time';
  time.textContent = formatMessageTime(message.createdAt);
  bar.append(copyButton, time);
  return bar;
}

function renderMessages(messages) {
  if (!messagesElement) return;
  messagesElement.replaceChildren();
  for (const message of messages) {
    const item = document.createElement('article');
    item.className = `message ${message.role}`;

    if (message.role === 'user') {
      // 用户消息：Pionle 卡片式气泡，不带角色标签
      const content = document.createElement('div');
      content.className = 'message-content';
      content.textContent = message.text;
      item.append(content);
    } else if (message.role === 'assistant') {
      // 助手消息：无气泡全宽正文 + 悬停操作栏
      const role = document.createElement('p');
      role.className = 'message-role';
      role.textContent = `TWINBOT · ${currentLoadedModel}`;
      const content = document.createElement('div');
      content.className = 'message-content';
      content.innerHTML = formatMarkdown(message.text);
      item.append(role, content, buildMessageActions(message));
    } else {
      // 工具输出：独立小卡
      const role = document.createElement('p');
      role.className = 'message-role';
      role.textContent = '工具执行';
      const content = document.createElement('div');
      content.className = 'message-content';
      content.textContent = message.text;
      item.append(role, content);
    }
    messagesElement.append(item);
  }

  // 运行中重渲染（如切换会话后回来）时保留消息流末尾的状态行
  if (runStatusText) {
    messagesElement.append(buildStatusRow(runStatusText));
  }
  updateArtifactButton();

  const hasMessages = messages.length > 0;
  messagesElement.classList.toggle('visible', hasMessages);
  composerWrapEl?.classList.toggle('is-empty', !hasMessages);
  if (welcomeElement) welcomeElement.hidden = hasMessages;
  const scroller = document.getElementById('conversation-body');
  if (scroller) {
    scroller.scrollTop = scroller.scrollHeight;
  }
}

async function loadSessions(preferredSessionId) {
  if (!window.twinbot?.listSessions) return;
  sessions = await window.twinbot.listSessions();
  if (preferredSessionId && sessions.some((session) => session.id === preferredSessionId)) {
    activeSessionId = preferredSessionId;
  } else if (!sessions.some((session) => session.id === activeSessionId)) {
    activeSessionId = sessions[0]?.id ?? null;
  }
  renderSessions();

  if (activeSessionId) {
    await selectSession(activeSessionId);
  } else {
    if (sessionTitle) sessionTitle.textContent = 'TwinBot 工作区';
    if (sessionSequence) sessionSequence.textContent = '/ —';
    renderMessages([]);
  }
}

async function selectSession(sessionId) {
  const session = sessions.find((item) => item.id === sessionId);
  if (!session) return;
  activeSessionId = sessionId;
  renderSessions();
  if (sessionTitle) sessionTitle.textContent = session.title || '新对话';
  const ordinal = sessions.findIndex((item) => item.id === sessionId) + 1;
  if (sessionSequence) sessionSequence.textContent = `/ ${String(ordinal).padStart(2, '0')}`;
  renderMessages(await window.twinbot.listMessages(sessionId));
  artifactReady = false;
  updateArtifactButton();
  void refreshArtifactState();
}

// 双击重命名会话并持久化
sessionTitle?.addEventListener('dblclick', async () => {
  const currentTitle = sessionTitle.textContent || '新对话';
  const newTitle = window.prompt('修改当前对话标题：', currentTitle);
  if (newTitle && newTitle.trim() && newTitle.trim() !== currentTitle) {
    const trimmed = newTitle.trim();
    sessionTitle.textContent = trimmed;
    const session = sessions.find((s) => s.id === activeSessionId);
    if (session) {
      session.title = trimmed;
      renderSessions();
      appendTerminalLog(`对话标题已重命名为: "${trimmed}"`, 'info');
      if (window.twinbot?.updateSessionTitle && activeSessionId) {
        try {
          await window.twinbot.updateSessionTitle(activeSessionId, trimmed);
        } catch (e) {
          console.warn('同步标题失败:', e);
        }
      }
    }
  }
});

// 从用户提问首句中提取 4~14 字核心语义标题
function generateChineseTitle(prompt) {
  if (!prompt) return '新对话';
  let clean = prompt.replace(/[\r\n\t]+/g, ' ').trim();
  // 过滤口语化问候前缀
  clean = clean.replace(/^(请问|帮我|请帮我|麻烦帮我|你能帮我|请|能否|如何|怎么|我想让你|查一下|看下|看一下)/, '').trim();
  if (!clean) clean = prompt.trim();
  // 过滤标点符号
  clean = clean.replace(/^[，。？！、\s]+|[，。？！、\s]+$/g, '');
  if (clean.length <= 14) return clean || '新对话';
  return clean.slice(0, 14) + '…';
}

async function waitForRun(runId) {
  return waitForRunViaDeltaOrPoll(runId);
}

function notifyRunDelta(runId, status, error) {
  const waiter = runDeltaWaiters.get(runId);
  if (!waiter) return;
  waiter.status = status;
  if (status === 'completed' || status === 'failed' || status === 'cancelled') {
    runDeltaWaiters.delete(runId);
    waiter.resolve(status);
  } else if (status === 'running' || status === 'queued') {
    showRunStatus(status === 'queued' ? '已排队，等待云端 Agent 处理…' : `${currentLoadedModel} 正在思考并执行…`);
  }
  if (error) {
    // keep for failed path
    waiter.error = error;
  }
}

async function waitForRunViaDeltaOrPoll(runId) {
  return new Promise(async (resolve, reject) => {
    let settled = false;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      runDeltaWaiters.delete(runId);
      if (status === 'cancelled') {
        clearRunStatus();
        showStatus('任务已取消，消息仍保存在会话中。');
        resolve('cancelled');
        return;
      }
      if (status === 'failed') {
        reject(new Error('Agent run failed'));
        return;
      }
      resolve(status);
    };

    runDeltaWaiters.set(runId, {
      resolve: finish,
      status: 'queued',
    });

    // Fallback polling (slower) in case WSS delta is missed
    const started = Date.now();
    try {
      while (!settled && Date.now() - started < 240_000) {
        const waiter = runDeltaWaiters.get(runId);
        if (!waiter) break;
        try {
          const run = await window.twinbot.getRun(runId);
          if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
            if (run.status === 'failed') {
              settled = true;
              runDeltaWaiters.delete(runId);
              reject(new Error(run.error || `Agent run ${run.status}`));
              return;
            }
            finish(run.status);
            return;
          }
          showRunStatus(run.status === 'queued' ? '已排队，等待云端 Agent 处理…' : `${currentLoadedModel} 正在思考并执行…`);
        } catch (err) {
          // ignore transient poll errors while waiting for delta
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
      if (!settled) {
        settled = true;
        runDeltaWaiters.delete(runId);
        reject(new Error('等待 Agent 响应超时；消息仍保存在会话中。'));
      }
    } catch (error) {
      if (!settled) {
        settled = true;
        runDeltaWaiters.delete(runId);
        reject(error);
      }
    }
  });
}

async function submitMessage(text) {
  if (sending) return;
  sending = true;
  setSendButtonMode(true);
  updateArtifactButton();
  showStatus('正在投递任务…');

  try {
    if (!activeSessionId) {
      const initialTitle = generateChineseTitle(text);
      const session = await window.twinbot.createSession(initialTitle);
      sessions.unshift(session);
      activeSessionId = session.id;
      renderSessions();
      if (sessionTitle) sessionTitle.textContent = session.title;
      if (sessionSequence) sessionSequence.textContent = `/ ${String(sessions.length).padStart(2, '0')}`;
    } else {
      // 若当前会话是无名默认会话且第一条消息进来，自动更新标题并持久化到云端数据库
      const cur = sessions.find((s) => s.id === activeSessionId);
      if (cur && (!cur.title || cur.title.startsWith('New conversation') || cur.title === '新对话')) {
        const newTitle = generateChineseTitle(text);
        cur.title = newTitle;
        if (sessionTitle) sessionTitle.textContent = newTitle;
        renderSessions();
        if (window.twinbot?.updateSessionTitle) {
          window.twinbot.updateSessionTitle(activeSessionId, newTitle).catch((err) => {
            console.warn('同步标题失败:', err);
          });
        }
      }
    }

    appendTerminalLog(`投递指令到会话 [${activeSessionId.slice(0, 8)}]: "${text.slice(0, 32)}"`, 'agent');
    const accepted = await window.twinbot.sendMessage(activeSessionId, text);
    activeRunId = accepted.run.id;
    appendTerminalLog(`任务就绪，Run ID: ${accepted.run.id.slice(0, 8)}`, 'info');
    if (messageInput) messageInput.value = '';
    renderMessages(await window.twinbot.listMessages(activeSessionId));
    showRunStatus('已提交，等待云端 Agent 调度…');
    const finalStatus = await waitForRun(accepted.run.id);
    clearRunStatus();
    renderMessages(await window.twinbot.listMessages(activeSessionId));
    if (finalStatus !== 'cancelled') {
      showStatus('回复已保存到会话。');
      appendTerminalLog(`任务 ${accepted.run.id.slice(0, 8)} 执行完成，结果已保存`, 'success');
    }
    sessions = await window.twinbot.listSessions();
    renderSessions();
  } catch (error) {
    clearRunStatus();
    showStatus(error instanceof Error ? error.message : '请求失败', true);
    appendTerminalLog(`任务执行异常: ${error instanceof Error ? error.message : '未知错误'}`, 'error');
  } finally {
    activeRunId = null;
    sending = false;
    setSendButtonMode(false);
    updateSendButtonState();
    if (messageInput) messageInput.focus();
    void refreshArtifactState();
  }
}

async function cancelActiveRun() {
  if (!activeRunId) return;
  showRunStatus('正在请求取消运行…');
  try {
    const run = await window.twinbot.cancelRun(activeRunId);
    if (run.status === 'cancelled') {
      showRunStatus('取消请求已接受…');
      appendTerminalLog(`任务 ${activeRunId.slice(0, 8)} 已被用户手动取消`, 'system');
    } else {
      clearRunStatus();
      showStatus(`任务已进入 ${run.status} 状态，无法取消。`, true);
    }
  } catch (error) {
    clearRunStatus();
    showStatus(error instanceof Error ? error.message : '无法取消运行', true);
  }
}

newSessionButton?.addEventListener('click', async () => {
  newSessionButton.disabled = true;
  try {
    const session = await window.twinbot.createSession('新对话');
    sessions.unshift(session);
    activeSessionId = session.id;
    renderSessions();
    await selectSession(session.id);
    showStatus('新会话已创建。');
    appendTerminalLog(`已新建会话: ${session.id.slice(0, 8)}`, 'system');
    if (messageInput) messageInput.focus();
  } catch (error) {
    showStatus(error instanceof Error ? error.message : '无法创建会话', true);
  } finally {
    newSessionButton.disabled = false;
  }
});

messageForm?.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = messageInput ? messageInput.value.trim() : '';
  if (text) void submitMessage(text);
});

messageInput?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    messageForm?.requestSubmit();
  }
});

// 输入框高度自适应：单行 22px 起步，超过 186px 内部滚动
const TEXTAREA_MAX_HEIGHT = 186;
messageInput?.addEventListener('input', () => {
  if (!messageInput) return;
  messageInput.style.height = 'auto';
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, TEXTAREA_MAX_HEIGHT)}px`;
  updateSendButtonState();
});

// 发送按钮三态外观：发送（空闲/空禁用）↔ 停止（生成中，点击中断当前运行）
const SEND_ICON_HTML = sendButton ? sendButton.innerHTML : '';
const STOP_ICON_HTML = '<span class="stop-square" aria-hidden="true"></span>';
function setSendButtonMode(stop) {
  if (!sendButton) return;
  sendButton.classList.toggle('stop', stop);
  sendButton.innerHTML = stop ? STOP_ICON_HTML : SEND_ICON_HTML;
  sendButton.title = stop ? '停止生成' : '发送';
  sendButton.disabled = stop ? false : !(messageInput?.value.trim());
}
function updateSendButtonState() {
  if (!sendButton || sending) return;
  sendButton.disabled = !(messageInput?.value.trim());
}
sendButton?.addEventListener('mousedown', (event) => {
  // 防止点击发送抢走输入框焦点
  event.preventDefault();
});
sendButton?.addEventListener('click', (event) => {
  if (sending) {
    event.preventDefault();
    void cancelActiveRun();
  }
});

// 为消息流视口预留输入框高度（composer 高度变化时同步 CSS 变量）
if (composerWrapEl && conversationBody) {
  new ResizeObserver(() => {
    conversationBody.style.setProperty('--composer-h', `${composerWrapEl.offsetHeight}px`);
  }).observe(composerWrapEl);
}

// 全局快捷键 'N' 新建对话 (当不在输入框时)
window.addEventListener('keydown', (event) => {
  if (
    (event.key === 'n' || event.key === 'N') &&
    !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName || '')
  ) {
    event.preventDefault();
    newSessionButton?.click();
  }
});

document.querySelectorAll('.suggestion').forEach((button) => {
  button.addEventListener('click', () => {
    if (!messageInput) return;
    messageInput.value = button.dataset.prompt ?? '';
    messageInput.focus();
    messageInput.setSelectionRange(messageInput.value.length, messageInput.value.length);
  });
});

// Tab 切换控制逻辑
function switchPodTab(tabId) {
  podTabs.forEach((tab) => {
    const isSelected = tab.dataset.tab === tabId;
    tab.classList.toggle('active', isSelected);
    tab.setAttribute('aria-selected', isSelected ? 'true' : 'false');
  });

  podTabContents.forEach((content) => {
    const match = content.id === `pod-tab-${tabId}`;
    content.classList.toggle('active', match);
    content.hidden = !match;
  });
}

podTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    const tabId = tab.dataset.tab;
    if (tabId) switchPodTab(tabId);
  });
});

clearTermButton?.addEventListener('click', () => {
  if (!terminalLogs) return;
  terminalLogs.replaceChildren();
  appendTerminalLog('实时终端日志已清空', 'system');
});

helpTermButton?.addEventListener('click', () => {
  appendTerminalLog('--- 终端支持的常用指令 ---', 'info');
  appendTerminalLog('help       : 显示所有交互指令列表', 'info');
  appendTerminalLog('clear      : 清空终端当前屏幕日志', 'info');
  appendTerminalLog('任意命令会经 cloud shell.exec 在选中的 Pod 沙箱内真实执行', 'info');
  appendTerminalLog('pwd        : 输出当前工作区根目录', 'info');
  appendTerminalLog('status     : 查看当前会话和容器运行状态', 'info');
  appendTerminalLog('model      : 输出当前已装载的大语言模型', 'info');
  appendTerminalLog('whoami     : 查看当前终端执行者身份', 'info');
  appendTerminalLog('uname      : 查看沙箱系统内核版本', 'info');
});

// 交互式终端命令行解释器
terminalCmdForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!terminalCmdInput) return;
  const raw = terminalCmdInput.value.trim();
  if (!raw) return;

  cmdHistory.push(raw);
  cmdHistoryIndex = cmdHistory.length;
  terminalCmdInput.value = '';
  appendTerminalLog(`$ ${raw}`, 'cmd');

  const cmd = raw.split(/\s+/)[0].toLowerCase();
  if (cmd === 'help') {
    helpTermButton?.click();
    return;
  }
  if (cmd === 'clear' || cmd === 'cls') {
    clearTermButton?.click();
    return;
  }
  if (cmd === 'model') {
    appendTerminalLog(`当前模型: ${currentLoadedModel}`, 'agent');
    return;
  }
  if (cmd === 'status') {
    appendTerminalLog(`当前会话: ${activeSessionId ?? '无'}`, 'info');
    appendTerminalLog(`活动 Pod: ${selectedRuntimeId || podDisplayName?.textContent || '未选择'}`, 'info');
    return;
  }

  if (!window.twinbot?.executeCloudTool) {
    appendTerminalLog('云端工具通道不可用', 'error');
    return;
  }
  try {
    const result = await window.twinbot.executeCloudTool('shell.exec', {
      command: raw,
      timeoutMs: 60_000,
    });
    if (!result.ok) {
      appendTerminalLog(
        `错误[${result.error?.code || 'ERR'}]: ${result.error?.message || '执行失败'}`,
        'error',
      );
      return;
    }
    const data = result.data || {};
    if (data.stdout) {
      String(data.stdout).split(/\r?\n/).forEach((line) => {
        if (line.length) appendTerminalLog(line, 'info');
      });
    }
    if (data.stderr) {
      String(data.stderr).split(/\r?\n/).forEach((line) => {
        if (line.length) appendTerminalLog(line, 'error');
      });
    }
    appendTerminalLog(
      `退出码 ${data.exitCode ?? '?'}${data.truncated ? ' (输出已截断)' : ''}`,
      data.exitCode === 0 ? 'success' : 'error',
    );
  } catch (err) {
    appendTerminalLog(`执行失败: ${err instanceof Error ? err.message : String(err)}`, 'error');
  }
});

terminalCmdInput?.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (cmdHistory.length === 0) return;
    if (cmdHistoryIndex > 0) {
      cmdHistoryIndex--;
      terminalCmdInput.value = cmdHistory[cmdHistoryIndex] || '';
    } else if (cmdHistoryIndex === 0) {
      terminalCmdInput.value = cmdHistory[0] || '';
    }
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (cmdHistory.length === 0) return;
    if (cmdHistoryIndex < cmdHistory.length - 1) {
      cmdHistoryIndex++;
      terminalCmdInput.value = cmdHistory[cmdHistoryIndex] || '';
    } else {
      cmdHistoryIndex = cmdHistory.length;
      terminalCmdInput.value = '';
    }
  }
});

refreshPodButton?.addEventListener('click', async () => {
  if (refreshPodButton.disabled) return;
  refreshPodButton.disabled = true;
  refreshPodButton.textContent = '同步中…';
  try {
    await Promise.all([loadMachines(), loadRuntimes(), loadModelConfigToForm()]);
    if (lastSyncTime) {
      lastSyncTime.textContent = `心跳正常 (${new Date().toLocaleTimeString()})`;
    }
    appendTerminalLog('已主动同步云端沙箱与在线设备状态', 'info');
  } catch (err) {
    appendTerminalLog(`同步状态失败: ${err instanceof Error ? err.message : '未知错误'}`, 'error');
  } finally {
    refreshPodButton.disabled = false;
    refreshPodButton.textContent = '立即同步';
  }
});

async function loadRuntimes() {
  if (!window.twinbot?.listRuntimes) return;
  try {
    const res = await window.twinbot.listRuntimes();
    const runtimes = res?.runtimes ?? [];
    selectedRuntimeId = res?.selectedRuntimeId ?? selectedRuntimeId;
    const select = document.getElementById('runtime-select');
    if (select) {
      const previous = select.value;
      select.replaceChildren();
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = runtimes.length === 0 ? '暂无在线沙箱' : '自动（需仅一台在线）';
      select.append(empty);
      for (const runtime of runtimes) {
        const opt = document.createElement('option');
        opt.value = runtime.podId;
        opt.textContent = runtime.podId;
        select.append(opt);
      }
      const preferred = selectedRuntimeId || previous;
      if (preferred && runtimes.some((r) => r.podId === preferred)) {
        select.value = preferred;
        selectedRuntimeId = preferred;
      }
    }
    if (runtimes.length > 0) {
      const runtime =
        runtimes.find((r) => r.podId === selectedRuntimeId) || runtimes[0];
      if (podDisplayName) podDisplayName.textContent = runtime.podId;
      if (podOnlineStatus) podOnlineStatus.textContent = `容器就绪 (${runtime.podId})`;
      if (podCapabilities) {
        podCapabilities.textContent = runtime.capabilities.join(' · ') || 'fs';
      }
      if (lastSyncTime) {
        lastSyncTime.textContent = `心跳正常 (${new Date().toLocaleTimeString()})`;
      }
    } else {
      if (podOnlineStatus) podOnlineStatus.textContent = '暂无在线沙箱';
    }
  } catch (err) {
    console.warn('获取 Pod 状态失败:', err);
  }
}

// 可拖拽侧边栏宽度控制 (Splitter 机制与双击重置、本地持久化记忆)
function initResizers() {
  const resizerLeft = document.getElementById('resizer-left');
  const resizerRight = document.getElementById('resizer-right');

  // 恢复保存的宽度
  const POD_WIDTH_MAX = 520;
  const savedLeftWidth = localStorage.getItem('twinbot_sidebar_width');
  if (savedLeftWidth) {
    document.documentElement.style.setProperty('--sidebar-width', `${savedLeftWidth}px`);
  }
  const savedRightWidth = Number(localStorage.getItem('twinbot_pod_width'));
  if (Number.isFinite(savedRightWidth) && savedRightWidth > 0) {
    // 历史存储值可能超出当前上限，恢复时钳制到 CSS max-width 一致的边界内
    const clamped = Math.min(savedRightWidth, POD_WIDTH_MAX, Math.max(240, window.innerWidth - 560));
    document.documentElement.style.setProperty('--pod-width', `${clamped}px`);
  }

  // 左侧边栏拖拽
  if (resizerLeft) {
    let isDraggingLeft = false;

    resizerLeft.addEventListener('pointerdown', (e) => {
      isDraggingLeft = true;
      document.body.classList.add('is-resizing');
      resizerLeft.classList.add('is-dragging');
      resizerLeft.setPointerCapture(e.pointerId);
    });

    resizerLeft.addEventListener('pointermove', (e) => {
      if (!isDraggingLeft) return;
      const newWidth = Math.max(180, Math.min(450, e.clientX));
      document.documentElement.style.setProperty('--sidebar-width', `${newWidth}px`);
      localStorage.setItem('twinbot_sidebar_width', String(newWidth));
    });

    const stopLeftDrag = (e) => {
      if (!isDraggingLeft) return;
      isDraggingLeft = false;
      document.body.classList.remove('is-resizing');
      resizerLeft.classList.remove('is-dragging');
      try {
        resizerLeft.releasePointerCapture(e.pointerId);
      } catch (_) {}
    };

    resizerLeft.addEventListener('pointerup', stopLeftDrag);
    resizerLeft.addEventListener('pointercancel', stopLeftDrag);

    // 双击重置默认宽度 (240px)
    resizerLeft.addEventListener('dblclick', () => {
      document.documentElement.style.setProperty('--sidebar-width', '240px');
      localStorage.setItem('twinbot_sidebar_width', '240px');
      appendTerminalLog('左侧栏宽度已重置为默认值 (240px)', 'info');
    });
  }

  // 右侧 Pod 面板拖拽
  if (resizerRight) {
    let isDraggingRight = false;

    resizerRight.addEventListener('pointerdown', (e) => {
      isDraggingRight = true;
      document.body.classList.add('is-resizing');
      resizerRight.classList.add('is-dragging');
      resizerRight.setPointerCapture(e.pointerId);
    });

    resizerRight.addEventListener('pointermove', (e) => {
      if (!isDraggingRight) return;
      const newWidth = Math.max(240, Math.min(POD_WIDTH_MAX, window.innerWidth - e.clientX));
      document.documentElement.style.setProperty('--pod-width', `${newWidth}px`);
      localStorage.setItem('twinbot_pod_width', String(newWidth));
    });

    const stopRightDrag = (e) => {
      if (!isDraggingRight) return;
      isDraggingRight = false;
      document.body.classList.remove('is-resizing');
      resizerRight.classList.remove('is-dragging');
      try {
        resizerRight.releasePointerCapture(e.pointerId);
      } catch (_) {}
    };

    resizerRight.addEventListener('pointerup', stopRightDrag);
    resizerRight.addEventListener('pointercancel', stopRightDrag);

    // 双击重置默认宽度 (320px)
    resizerRight.addEventListener('dblclick', () => {
      document.documentElement.style.setProperty('--pod-width', '320px');
      localStorage.setItem('twinbot_pod_width', '320px');
      appendTerminalLog('右侧栏宽度已重置为默认值 (320px)', 'info');
    });
  }
}

// 本地工具执行审批弹窗事件处理
function initApprovalModal() {
  if (!window.twinbot?.onLocalToolApproval) return;

  function closeApprovalModal(decision) {
    if (!currentApprovalRequestId) return;
    if (approvalModalBackdrop) approvalModalBackdrop.hidden = true;
    window.twinbot.respondLocalToolApproval(currentApprovalRequestId, decision);
    appendTerminalLog(`本地工具审批已决议: [${decision}]`, decision.includes('allow') ? 'success' : 'tool');
    currentApprovalRequestId = null;
  }

  window.twinbot.onLocalToolApproval((req) => {
    currentApprovalRequestId = req.requestId;
    if (approvalMachineId) {
      approvalMachineId.textContent = req.machineId || req.hostname || 'LAPTOP-LOCAL';
    }
    if (approvalCodeText) {
      approvalCodeText.textContent = req.commandPreview || `${req.tool} (未知命令)`;
    }
    if (approvalModalBackdrop) approvalModalBackdrop.hidden = false;
    appendTerminalLog(`收到来自 Agent 的本地工具执行审批请求: ${req.tool}`, 'tool');
  });

  approvalBtnClose?.addEventListener('click', () => closeApprovalModal('deny'));
  approvalBtnNever?.addEventListener('click', () => closeApprovalModal('never'));
  approvalBtnAlways?.addEventListener('click', () => closeApprovalModal('always-allow'));
  approvalBtnOnce?.addEventListener('click', () => closeApprovalModal('allow-once'));
}

// user.ask 提问弹窗事件处理：选项直接作答，自由文本回车或点按钮提交
function initQuestionModal() {
  if (!window.twinbot?.onUserQuestion) return;
  const backdrop = document.getElementById('question-modal-backdrop');
  const textEl = document.getElementById('question-text');
  const machineEl = document.getElementById('question-machine-id');
  const choicesWrap = document.getElementById('question-choices');
  const inputBox = document.getElementById('question-input-box');
  const freeInput = document.getElementById('question-free-input');
  const submitBtn = document.getElementById('question-btn-submit');
  const closeBtn = document.getElementById('question-btn-close');
  let currentQuestionId = null;
  let currentChoice = null;

  function respond(answer) {
    if (!currentQuestionId) return;
    if (backdrop) backdrop.hidden = true;
    window.twinbot.respondUserQuestion(currentQuestionId, answer, currentChoice ?? undefined);
    appendTerminalLog(
      `已回答 Agent 提问: ${answer.length > 60 ? `${answer.slice(0, 60)}…` : answer || '(空回答)'}`,
      'success',
    );
    currentQuestionId = null;
    currentChoice = null;
  }

  window.twinbot.onUserQuestion((question) => {
    currentQuestionId = question.requestId;
    currentChoice = null;
    if (machineEl) machineEl.textContent = question.machineId || 'LAPTOP-LOCAL';
    if (textEl) textEl.textContent = question.question;
    if (choicesWrap) {
      choicesWrap.innerHTML = '';
      (question.choices || []).forEach((choice) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'approval-action-btn btn-always';
        btn.textContent = choice;
        btn.addEventListener('click', () => {
          currentChoice = choice;
          respond(choice);
        });
        choicesWrap.appendChild(btn);
      });
      choicesWrap.hidden = (question.choices || []).length === 0;
    }
    if (inputBox) inputBox.hidden = !question.allowFreeText;
    if (freeInput) freeInput.value = '';
    if (backdrop) backdrop.hidden = false;
    appendTerminalLog('收到 Agent 的提问，等待你的回答', 'tool');
  });

  submitBtn?.addEventListener('click', () => {
    respond(freeInput ? freeInput.value.trim() : '');
  });
  freeInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') respond(freeInput.value.trim());
  });
  closeBtn?.addEventListener('click', () => respond(''));
}

// ===== 会话产物按钮：三态（生成预览 → 生成中… → 打开预览） =====

let artifactReady = false;
let artifactProbeInFlight = false;

// 模型配置页签视图：null=列表 | 'add'=新增 | 'edit:<name>'=编辑
let modelFormMode = null;
let modelFormSaved = false;

function updateArtifactButton() {
  if (!openArtifactBtn) return;
  openArtifactBtn.hidden = !activeSessionId;
  if (!activeSessionId) return;
  openArtifactBtn.disabled = sending || artifactProbeInFlight;
  openArtifactBtn.textContent = sending
    ? '生成中…'
    : artifactReady
      ? '打开预览'
      : '生成预览';
}

/** 探测当前会话是否已有运行中的产物（sessions/<id>/.port 是否存在） */
async function refreshArtifactState() {
  if (!activeSessionId || !window.twinbot?.executeCloudTool || artifactProbeInFlight) return;
  artifactProbeInFlight = true;
  updateArtifactButton();
  try {
    const result = await window.twinbot.executeCloudTool('fs.read', {
      path: `sessions/${activeSessionId}/.port`,
    });
    artifactReady = Boolean(result.ok);
  } catch {
    artifactReady = false;
  } finally {
    artifactProbeInFlight = false;
    updateArtifactButton();
  }
}

openArtifactBtn?.addEventListener('click', () => {
  if (!activeSessionId || sending) return;

  // 已就绪：经控制面生成公网路由并在系统浏览器打开
  if (artifactReady) {
    if (!window.twinbot?.openArtifactInBrowser) return;
    showStatus('正在生成预览路由…');
    window.twinbot.openArtifactInBrowser(activeSessionId)
      .then(({ url }) => {
        showStatus('产物已在系统浏览器打开。');
        appendTerminalLog(`产物已在浏览器打开: ${url}`, 'system');
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('ARTIFACT_NOT_RUNNING')) {
          // 产物已停：回到生成态，让 Agent 重新拉起
          artifactReady = false;
          updateArtifactButton();
          showStatus('产物服务未在运行——点击「生成预览」让 Agent 重新拉起。');
        } else {
          showStatus(`打开预览失败: ${message.slice(0, 120)}`);
        }
      });
    return;
  }

  // 未就绪：驱动 Agent 按约定生成并启动产物，完成后按钮自动切换为「打开预览」
  if (!window.twinbot?.sendMessage) return;
  void submitMessage(
    '请生成并启动本会话的产物：根据当前对话上下文生成合适的项目文件（若还没有可生成一个简单的演示页面），写入当前会话工作目录，按产物预览约定读取或创建 .port 并后台启动，自检后告诉我端口与状态。',
  );
});

// 输入框模型切换器
const composerModelBtn = document.getElementById('composer-model-btn');
const composerModelName = document.getElementById('composer-model-name');
const composerModelPopover = document.getElementById('composer-model-popover');
function updateComposerModelName(model) {
  if (composerModelName) composerModelName.textContent = model || 'glm-5.3-flash';
}

function showModelForm(mode) {
  modelFormMode = mode;
  modelFormSaved = false;
  if (modelListView) modelListView.hidden = mode !== null;
  if (modelFormView) modelFormView.hidden = mode === null;
  if (modelSaveStatus) modelSaveStatus.textContent = '';
  if (mode === 'add') {
    if (settingProfileName) settingProfileName.value = '';
    if (settingBaseUrl) settingBaseUrl.value = '';
    if (settingApiKey) settingApiKey.value = '';
    if (settingModelName) settingModelName.value = '';
  }
}

function showModelList() {
  showModelForm(null);
  void loadModelProfiles();
}

async function toggleComposerModelPopover(force) {
  if (!composerModelPopover) return;
  const show = force ?? composerModelPopover.hidden;
  if (!show) {
    composerModelPopover.hidden = true;
    return;
  }
  composerModelPopover.hidden = false;
  composerModelPopover.replaceChildren();
  const loading = document.createElement('p');
  loading.className = 'composer-model-empty';
  loading.textContent = '加载中…';
  composerModelPopover.append(loading);
  let profiles = [];
  let active = null;
  try {
    if (window.twinbot?.listModelProfiles) {
      profiles = (await window.twinbot.listModelProfiles()).profiles ?? [];
    }
    if (window.twinbot?.getModelConfig) {
      active = await window.twinbot.getModelConfig();
    }
  } catch (err) {
    composerModelPopover.replaceChildren();
    const failed = document.createElement('p');
    failed.className = 'composer-model-empty';
    failed.textContent = '加载配置失败';
    composerModelPopover.append(failed);
    return;
  }
  composerModelPopover.replaceChildren();
  const isActive = (profile) => Boolean(active) && profile.apiKey === active.apiKey && profile.model === active.model && profile.apiBaseUrl === active.apiBaseUrl;
  if (!profiles.length) {
    const empty = document.createElement('button');
    empty.type = 'button';
    empty.className = 'composer-model-item';
    empty.textContent = '暂无保存的配置，去设置里添加 →';
    empty.addEventListener('click', () => {
      composerModelPopover.hidden = true;
      if (settingsModalBackdrop) settingsModalBackdrop.hidden = false;
    });
    composerModelPopover.append(empty);
    return;
  }
  for (const profile of profiles) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'composer-model-item' + (isActive(profile) ? ' active' : '');
    const label = document.createElement('span');
    label.className = 'composer-model-item-name';
    label.textContent = profile.name + (isActive(profile) ? ' · 使用中' : '');
    const meta = document.createElement('span');
    meta.className = 'composer-model-item-meta';
    meta.textContent = profile.model;
    item.append(label, meta);
    item.addEventListener('click', async () => {
      try {
        await window.twinbot.activateModelProfile(profile.id);
        currentLoadedModel = profile.model;
        updateComposerModelName(profile.model);
        showStatus(`云端 Agent 已切换为「${profile.name}」（${profile.model}），下一次对话生效`);
        appendTerminalLog(`模型已切换: ${profile.name} (${profile.model})`, 'agent');
      } catch (err) {
        showStatus(`切换失败: ${err instanceof Error ? err.message : String(err)}`);
      }
      composerModelPopover.hidden = true;
    });
    composerModelPopover.append(item);
  }

  // 列表尾部：管理入口（打开设置弹窗的配置列表，可编辑/删除）
  const manage = document.createElement('button');
  manage.type = 'button';
  manage.className = 'composer-model-item';
  manage.textContent = '管理配置…';
  manage.addEventListener('click', () => {
    composerModelPopover.hidden = true;
    if (settingsModalBackdrop) settingsModalBackdrop.hidden = false;
  });
  composerModelPopover.append(manage);
}

composerModelBtn?.addEventListener('click', () => void toggleComposerModelPopover());
document.addEventListener('click', (event) => {
  if (composerModelPopover?.hidden) return;
  if (event.target instanceof Node && composerModelBtn && !composerModelBtn.contains(event.target) && !composerModelPopover.contains(event.target)) {
    composerModelPopover.hidden = true;
  }
});

// 首次使用：未配置接入 Token 时自动打开「服务连接」页签引导
async function firstRunConnectionSetup() {
  if (!window.twinbot?.getConnectionConfig) return;
  const config = await window.twinbot.getConnectionConfig();
  if (config?.hasToken) return;
  if (settingsModalBackdrop) settingsModalBackdrop.hidden = false;
  tabConnectionBtn?.click();
  if (connectionSaveStatus) {
    connectionSaveStatus.textContent = '首次使用：请填写管理员分配的控制端地址与 Token';
    connectionSaveStatus.style.color = 'var(--text-dim)';
  }
}

// 初始化运行
initTheme();
initSettingsModal();
initResizers();
initApprovalModal();
initQuestionModal();

if (window.twinbot) {
  
document.getElementById('runtime-select')?.addEventListener('change', async (e) => {
  const podId = e.target.value || null;
  if (!window.twinbot?.selectRuntime) return;
  try {
    const result = await window.twinbot.selectRuntime(podId);
    selectedRuntimeId = result.selectedRuntimeId;
    appendTerminalLog(
      selectedRuntimeId
        ? `已选择云端 Runtime: ${selectedRuntimeId}`
        : '已清除 Runtime 选择（多 Pod 时将要求显式选择）',
      'info',
    );
    await loadRuntimes();
  } catch (err) {
    appendTerminalLog(`选择 Runtime 失败: ${err instanceof Error ? err.message : String(err)}`, 'error');
    await loadRuntimes();
  }
});

if (window.twinbot?.onSessionDelta) {
  window.twinbot.onSessionDelta(({ sessionId, delta }) => {
    if (!delta || typeof delta !== 'object') return;
    const kind = delta.kind;
    if (kind === 'message.created' && delta.message && sessionId === activeSessionId) {
      // Live-append / refresh messages for the active session
      void window.twinbot.listMessages(sessionId).then(renderMessages).catch(() => undefined);
    }
    if (kind === 'run.status' && delta.runId) {
      notifyRunDelta(delta.runId, delta.status, delta.error);
      if (delta.status === 'running' || delta.status === 'queued') {
        showRunStatus(
          delta.status === 'queued'
            ? '已排队，等待云端 Agent 处理…'
            : `${currentLoadedModel} 正在思考并执行…`,
        );
      }
      if (delta.status === 'completed' || delta.status === 'failed' || delta.status === 'cancelled') {
        if (sessionId === activeSessionId) {
          void window.twinbot.listMessages(sessionId).then(renderMessages).catch(() => undefined);
        }
      }
    }
    if (kind === 'routine.fired') {
      appendTerminalLog(
        `例程已触发: ${delta.routineName || delta.routineId || ''} → run ${(delta.runId || '').slice(0, 8)}`,
        'agent',
      );
    }
  });
}

void Promise.all([loadSessions(), loadMachines(), loadRuntimes(), loadModelConfigToForm()])
    .then(() => {
      setConnected(true);
      showStatus('消息会保存到你的持久化会话中。');
      void firstRunConnectionSetup();
      appendTerminalLog('TwinBot 控制面通道已建立，就绪等待指令', 'system');
      window.setInterval(() => {
        void loadMachines();
        void loadRuntimes();
      }, 10000);
    })
    .catch((error) => {
      setConnected(false);
      showStatus(error instanceof Error ? error.message : '无法连接控制面', true);
      appendTerminalLog(`连接控制面失败: ${error.message}`, 'error');
    });
}
