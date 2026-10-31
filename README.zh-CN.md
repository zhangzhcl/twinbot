<div align="center">

**简体中文** | [English](README.md)

</div>

# TwinBot（本地 + 云端 Agent 协同系统）

基于 Node.js + TypeScript 的“一仓多服务（Monorepo）”架构系统。整体设计解耦了控制面（Control Plane，负责思考、推理、状态持久化与任务调度）与数据面（Data Plane，负责在已授权的本地设备或安全隔离的云端容器中执行具体工具）。

系统已原生支持**反向长连接架构**与**按角色平滑演进**：无论是桌面客户端还是云端沙箱 Pod，均只向控制端发起主动 WSS 长连接，无需暴露公网端口；服务本身支持通过 `SERVER_ROLE`（`all` | `gateway` | `worker`）在单机一体化与多节点集群化之间无缝演进。

完整架构设计与详细安全技术规范请参阅 [docs/architecture.md](docs/architecture.md)。

---

## 1. 仓库结构与角色定位

```text
TwinBot/
├── packages/                      # 共享基础协议与契约
│   ├── tool-protocol/             # 工具类型、错误码与 Zod Schema（fs.read, fs.list 等）
│   └── ws-protocol/               # WebSocket 通信协议、消息定义与双向校验
│
├── apps/                          # 独立角色应用
│   ├── control-api/               # 控制服务器：HTTP/WSS 网关、身份鉴权、持久化、工具路由与 Pi Agent Worker
│   ├── cloud-runtime/             # 执行服务器：Pod 沙箱运行时，工作区限制，主动长连接与工具执行
│   └── desktop/                   # 本地用户端：Electron 桌面客户端，会话 UI 与本机 Local Agent
│
└── deploy/                        # 生产部署资产
    ├── docker/                    # 控制面与执行面的生产 Dockerfile
    ├── control/                   # 2C4G 控制服务器：Docker Compose、Nginx TLS 反代与环境变量模板
    ├── k3s/                       # 4C8G 执行服务器：K3s 命名空间、网络隔离策略、PVC、双用户 Pod 编排
    └── runtime/                   # 执行服务器 Docker Compose 备选方案
```

---

## 2. 核心架构与设计原则

1. **一仓多服务（Monorepo）强类型契约**：
   - 采用 npm workspaces 组织协议包与服务应用，确保协议在控制端、桌面端、云端 Pod 之间具备 100% 的强类型一致性与运行时 Zod 校验。
2. **反向长连接（Reverse Connection）与零入站信任**：
   - 桌面客户端（Local Agent）与云端沙箱（Cloud Runtime Pod）均通过带 Token 的 TLS WSS **主动向控制端发起反向连接**。
   - 执行端（Pod / PC）无需公网 IP，不开放任何入站端口，杜绝扫描与穿透风险。
3. **安全沙箱边界与工作区防越界**：
   - 云端沙箱运行时（`cloud-runtime`）强制限定在用户指定的 `CLOUD_RUNTIME_WORKSPACE` 目录内，内核级防范路径穿越（Path Traversal）与指向工作区外部的非法符号链接。
4. **单机/分布式平滑演进（SERVER_ROLE）**：
   - 初期资源有限时，在 2C4G 服务器上单机启动 `SERVER_ROLE=all`（网关 + Worker 一体化）。
   - 未来业务扩容时，代码无需重构，只需将环境变量分别设置为 `SERVER_ROLE=gateway` 和 `SERVER_ROLE=worker`，即可平滑拆分为独立的网关集群与后台推理集群。
5. **完整可追溯审计**：
   - 工具执行生命周期（`requested -> approved -> completed/failed`）通过 PostgreSQL 进行脱敏审计，严密记录执行租户、目标机器/Pod，而不持久化敏感文件内容或代码载荷。

---

## 3. 本地开发与全量测试

### 环境要求

- Node.js `>=22.19.0`（Pi Coding Agent SDK 要求的运行时版本）
- npm 或 pnpm

### 构建与测试

```powershell
# 1. 安装工程全量依赖
npm install

# 2. 编译所有协议包与子应用
npm run build

# 3. 运行全量自动化测试（当前包含 150 项单元与端到端测试）
npm test
```

### 启动本地桌面客户端（Electron）

```powershell
npm run dev -w @lca/desktop
```

桌面端默认连接本地 `ws://127.0.0.1:8787/v1/ws`，开发环境自动注入 `dev-token`。

---

## 4. 服务器生产部署实战

当前标准推荐部署配置为：

- **控制服务器：2 vCPU / 4 GB RAM**（运行 PostgreSQL 16 + Control API + Nginx 反代）；
- **执行服务器：4 vCPU / 8 GB RAM**（运行 K3s 或 Docker，隔离调度最多 2 个独立用户 Pod）。

### 4.1 控制服务器部署（2C4G）

1. **进入控制部署目录并配置环境变量**：

   ```bash
   cd deploy/control
   cp .env.example .env
   vim .env
   ```

   主要配置项：
   - `DATABASE_URL`：PostgreSQL 连接串；
   - `CONTROL_TOKENS_JSON`：用户 Bearer Token 映射表（Token 长度 >= 32 字符）；
   - `CLOUD_RUNTIME_TOKENS_JSON`：允许接入的 Pod Token 及租户映射；
   - `AGENT_PROVIDER` / `AGENT_MODEL` / `AGENT_API_KEY`：大模型 API 凭证。

2. **一键拉起后端与数据库容器**：

   ```bash
   docker compose up -d --build
   ```

   该配置会自动启动 PostgreSQL 并挂载持久卷，Control API 启动时会自动执行幂等表结构初始化。

3. **配置 Nginx 与 TLS 证书**：
   - 参考 `deploy/control/nginx.conf`，将域名（如 `control.yourdomain.com`）的 80/443 流量反向代理到本地 `127.0.0.1:8787`；
   - 确保包含 `Upgrade` 与 `Connection: "upgrade"` 配置，以支持 WSS 长连接。

---

### 4.2 执行服务器部署（4C8G，跑 2 个 Pod）

#### 方案 A：使用 K3s Kubernetes 部署（推荐）

1. **安装 K3s（单节点极轻量）**：

   ```bash
   curl -sfL https://get.k3s.io | sh -
   ```

2. **创建命名空间与网络隔离策略**：

   ```bash
   kubectl apply -f deploy/k3s/00-namespace.yaml
   kubectl apply -f deploy/k3s/01-network-policy.yaml
   ```

   *该网络策略严格封禁所有入站，出站仅允许 DNS 和向控制端 443 端口的反向连接。*

3. **创建数据持久卷**：

   ```bash
   kubectl apply -f deploy/k3s/02-storage-pvc.yaml
   ```

   *为用户 A 和用户 B 分别分配 10GB 独立存储。*

4. **创建 Token 密钥并部署 Pod**：

   ```bash
   # 为用户 A 创建凭证 Secret
   kubectl create secret generic runtime-secrets-user-a \
     -n lca-runtimes \
     --from-literal=token=sec-runtime-token-a-32-chars-long-pod-1

   # 为用户 B 创建凭证 Secret
   kubectl create secret generic runtime-secrets-user-b \
     -n lca-runtimes \
     --from-literal=token=sec-runtime-token-b-32-chars-long-pod-2

   # 部署 Runtime Pod
   kubectl apply -f deploy/k3s/03-runtime-user-a.yaml
   kubectl apply -f deploy/k3s/04-runtime-user-b.yaml
   ```

5. **资源限制规约**：
   - 每个 Pod 设置 `requests: 500m CPU / 1Gi RAM`，`limits: 1500m CPU / 2Gi RAM`；
   - 两 Pod 最大峰值占用 3C / 4Gi，为 4C8G 宿主机留出 1C / 4Gi 安全冗余。

---

#### 方案 B：使用 Docker Compose 部署（轻量备选）

若不在执行机搭建 K3s，可直接进入 `deploy/runtime`：

```bash
cd deploy/runtime
cp .env.example .env
# 填写 CONTROL_WS_URL 及两个用户的 Token
docker compose up -d --build
```

即可在独立容器中启动两个隔离沙箱工作区，资源配置由 Docker 限制在 1.5C / 2Gi。

---

## 5. API 与功能支持清单

### 5.1 Agent 工具清单

Agent（Pi 引擎）可用工具按执行面动态暴露：桌面端设备或云端 Pod 不在线（或不具备所需能力）时，对应工具不会出现在模型的工具列表中。本地工具全部走用户审批弹窗；云端工具在 Pod 沙箱内执行，免审批但全量审计。

| 工具 | 协议名 | 桌面端 | 云端 Pod | 说明 |
| --- | --- | --- | --- | --- |
| 读取文件 | `fs.read` | 支持 | 支持 | utf8 / base64，单文件上限 5MB |
| 列出目录 | `fs.list` | 支持 | 支持 | 返回类型与文件大小 |
| 写入文件 | `fs.write` | 支持（审批） | 支持 | 可选自动创建父目录 |
| 编辑文件 | `fs.edit` | 支持（审批） | 支持 | 精确文本替换，oldText 需唯一 |
| 通配匹配 | `fs.glob` | 支持（审批） | 支持 | 支持 `**`、`{a,b}`、`[a-z]` |
| 内容检索 | `fs.grep` | 支持（审批） | 支持 | 正则、有界遍历（2000 文件 / 1000 命中） |
| 命令执行 | `shell.exec` | 支持（审批） | 支持 | 超时 + 输出截断 |
| 跨端复制 | `files.copy` | - | - | 控制面编排：源端读 base64 → 目标端写 |
| 脚本运行 | `code.run` | - | 支持 | Python / Node / Bash，隔离临时目录 |
| 网页抓取 | `web.fetch` | - | 支持 | 仅 http(s)，响应体上限内截断 |
| 网页搜索 | `web.search` | - | 支持 | Brave（配 Key）或 DuckDuckGo 兜底 |
| 浏览器操作 | `browser.use` | - | 支持 | 无头 Chromium：goto / click / type / screenshot |
| 向用户提问 | `user.ask` | 支持 | - | 选项按钮 + 自由文本的提问弹窗 |
| Notebook 读取 | `notebook.read` | 支持（审批） | 支持 | nbformat 4 解析 |
| Notebook 编辑 | `notebook.edit` | 支持（审批） | 支持 | 插入 / 替换 / 删除单元格 |
| 语言服务查询 | `lsp.query` | - | 支持 | TS/JS 的 definition / references / type |
| 工作区快照 | `vcs.checkpoint` | - | 支持 | create / restore / list，纯 Node 实现 |

未支持的工具：`image_gen`、`video_gen`、`computer_use`（有意排除，未在协议层预留）。`OpenAiCompatibleAgent` 为纯文本引擎，不支持任何工具调用；需要工具能力时请使用 Pi 引擎。

### 5.2 REST 与 WSS 接口

Control API 对外开放受控的 RESTful 与 WSS 接口：

| 方法 | 端点 | 说明 |
| --- | --- | --- |
| `GET` | `/healthz` | 服务健康检查 |
| `GET` | `/v1/machines` | 查询当前用户已连接的在线本地 Electron 设备 |
| `POST` | `/v1/machines/selection` | 设置/切换本机文件工具首选执行设备 |
| `GET` | `/v1/runtimes` | 查询当前用户已认证连接的云端沙箱 Pod 及能力 |
| `GET` | `/v1/sessions` | 列出当前用户的历史会话 |
| `POST` | `/v1/sessions` | 创建新对话会话 |
| `PATCH` | `/v1/sessions/:id` | 修改会话标题 |
| `DELETE` | `/v1/sessions/:id` | 删除会话及其全部消息与任务记录（有任务进行中时返回 409） |
| `GET` | `/v1/sessions/:id/messages` | 读取会话消息历史 |
| `POST` | `/v1/sessions/:id/messages` | 发送用户消息并原子入队 Agent Run 任务 |
| `GET/POST` | `/v1/models/config` | 读取/更新当前生效的模型配置 |
| `GET/POST` | `/v1/models/configs` | 列出/新增模型配置档案（多套保存，同名覆盖） |
| `DELETE` | `/v1/models/configs/:id` | 删除一套模型配置档案 |
| `POST` | `/v1/models/configs/:id/activate` | 启用一套档案（云端 Agent 随后的运行即使用该模型） |
| `GET` | `/v1/runs/:id` | 查询指定 Agent 任务的执行状态 |
| `POST` | `/v1/runs/:id/cancel` | 取消指定的排队中/执行中任务（支持跨实例中断） |
| `WSS` | `/v1/ws` | 用户设备与云端 Pod 的统一认证与反向执行长连接通道 |

---

## 6. 云端产物本地预览与调试

Agent 在 Pod 工作区里生成的 Web 项目，可以在系统浏览器中直接打开查看与调试：

1. **启动产物**：对 Agent 说「把工作区里的项目跑起来」。Agent 按内置约定执行：产物写到**当前会话的独立目录** `sessions/<会话ID>/`（会话之间互相隔离，.port 互不冲突，写入前会用 `ss -ltn` 检查端口占用）；读取或创建 `.port`（30000-39999 随机端口），生成 `start.sh`（`nohup` 后台启动、`.pid` 防重复），启动后自检并汇报状态码。静态站点用 `python3 -m http.server`，Python/Node 项目按各自框架启动。
2. **在浏览器打开**：对话区右上角点「打开产物」——控制面为该会话生成带随机令牌的公网路由（`https://<域名>:<端口>/p/<token>/`），并在系统默认浏览器打开，页面完全可交互。令牌 12 小时有效，控制面重启后重新点一次即可。
3. **调试图形界面**：浏览器里右键 → 检查，即可用完整 DevTools 调试页面；交互操作也可以直接在对话里让 Agent 用 browser.use 代为执行。
4. **文件预览与通道**：文件查看数据经只读工具通道（`POST /v1/tools/execute`，白名单 `fs.read/list/glob/grep`、`notebook.read`、`lsp.query`、`browser.use`）获取，独立于 Agent 的 `tool_calls` 审计（记入 `ui_tool_calls`）。服务端需配置 `PREVIEW_PUBLIC_BASE_URL`（对外协议/域名/端口，如 `https://your-domain:8787`）。

v1 限制：不支持 WebSocket 升级与 HMR（热更请手动点「刷新」）；单响应体上限 5MB；需要 dev server 的项目由 Agent 用 `shell.exec` 启动后通过同一路径访问。

## 7. 安全与免责声明

1. **凭证保护**：生产部署切勿将真实 `.env` 或高熵 Token 提交到公开 Git 仓库；
2. **命令授权**：系统对本机工具执行采取“显式审批”，所有针对用户本地磁盘的改动需用户在 Electron 界面中确认；
3. **免责与适用场景**：本项目用于合法的开发辅助、自动化编程与多端任务调度。请勿用于未授权的远程控制或破坏性操作。
