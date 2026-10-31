<div align="center">

[简体中文](README.zh-CN.md) | **English**

</div>

# TwinBot (Local + Cloud Agent Collaboration System)

A Node.js + TypeScript monorepo that decouples the **Control Plane** (reasoning, state persistence, task scheduling) from the **Data Plane** (executing concrete tools on authorized local devices or isolated cloud containers).

The system natively supports a **reverse-connection architecture** and **smooth role-based scaling**: both the desktop client and the cloud sandbox Pod only make outbound WSS connections to the control plane — no inbound ports are ever exposed; the control server itself evolves seamlessly from a single-box setup to a multi-node cluster via `SERVER_ROLE` (`all` | `gateway` | `worker`).

For the full architecture design and detailed security specifications, see [docs/architecture.md](docs/architecture.md). A Chinese version of this document is available at [README.zh-CN.md](README.zh-CN.md).

---

## 1. Repository Structure

```text
TwinBot/
├── packages/                      # Shared protocol packages
│   ├── tool-protocol/             # Tool types, error codes and Zod schemas (fs.read, fs.list, ...)
│   └── ws-protocol/               # WebSocket protocol, message definitions and validation
│
├── apps/                          # Role applications
│   ├── control-api/               # Control server: HTTP/WSS gateway, auth, persistence, tool routing, Pi Agent worker
│   ├── cloud-runtime/             # Execution server: pod sandbox runtime, workspace isolation, outbound connection, tool execution
│   └── desktop/                   # Local client: Electron desktop app, session UI and the local Local Agent
│
└── deploy/                        # Production deployment assets
    ├── docker/                    # Production Dockerfiles for control plane and execution plane
    ├── control/                   # 2C4G control server: Docker Compose, Nginx TLS reverse proxy, env templates
    ├── k3s/                       # 4C8G execution server: K3s namespace, network policy, PVC, dual-user pod manifest
    ├── runtime/                   # Docker Compose alternative for the execution server
    └── bootstrap/                 # One-command deployment scripts for fresh servers (see deploy/bootstrap/README.md)
```

---

## 2. Core Design Principles

1. **Strongly-typed monorepo contracts**: npm workspaces organize protocol packages and services, guaranteeing 100% type consistency across control plane, desktop and cloud pods, with runtime Zod validation.
2. **Reverse connection, zero inbound trust**: both the desktop Local Agent and the cloud runtime pod actively connect outbound to the control plane over token-authenticated TLS WSS; no public IP or inbound port is required on the execution side.
3. **Sandbox boundaries**: the cloud runtime enforces all file operations inside the user's `CLOUD_RUNTIME_WORKSPACE`, defending against path traversal and symlink escapes at the kernel level.
4. **Single-box to cluster scaling (`SERVER_ROLE`)**: start monolithically on a 2C4G server with `SERVER_ROLE=all`; later switch to `SERVER_ROLE=gateway` and `SERVER_ROLE=worker` to split into a gateway cluster and a worker cluster with zero code changes.
5. **Fully traceable audit**: every tool execution lifecycle (`requested → approved → completed/failed`) is audited in PostgreSQL with tenant and target metadata — never file contents or code payloads.

---

## 3. Local Development and Testing

### Requirements

- Node.js `>=22.19.0` (required by the Pi Coding Agent SDK)
- npm

### Build and test

```bash
# 1. Install all workspace dependencies
npm install

# 2. Compile all protocol packages and applications
npm run build

# 3. Run the full test suite (150 unit and end-to-end tests)
npm test
```

### Start the desktop client (Electron)

```bash
npm run dev -w @lca/desktop
```

In development the desktop client connects to `ws://127.0.0.1:8787/v1/ws` with a `dev-token` injected automatically.

---

## 4. Production Deployment

Recommended baseline:

- **Control server: 2 vCPU / 4 GB RAM** (PostgreSQL 16 + Control API + reverse proxy);
- **Execution server: 4 vCPU / 8 GB RAM** (K3s or Docker, scheduling up to 2 isolated user pods).

A one-command deployment path for fresh servers is available — see [deploy/bootstrap/README.md](deploy/bootstrap/README.md) (English) / [deploy/bootstrap/README.zh-CN.md](deploy/bootstrap/README.zh-CN.md) (Chinese). It interactively generates all credentials, starts the control plane with an automatic-HTTPS gateway, deploys pod containers, and prints the three-line connection config for the desktop client.

### 4.1 Control server (2C4G)

1. **Configure environment variables**:

   ```bash
   cd deploy/control
   cp .env.example .env
   vim .env
   ```

   Key settings:
   - `DATABASE_URL`: PostgreSQL connection string;
   - `CONTROL_TOKENS_JSON`: user Bearer Token mapping (tokens >= 32 chars);
   - `CLOUD_RUNTIME_TOKENS_JSON`: pod tokens and tenant mapping;
   - `AGENT_PROVIDER` / `AGENT_MODEL` / `AGENT_API_KEY`: default LLM credentials (per-user profiles override these).

2. **Start the backend and database**:

   ```bash
   docker compose up -d --build
   ```

   The stack starts PostgreSQL with a persistent volume; the Control API runs idempotent schema migrations on startup.

3. **TLS reverse proxy**:
   - See `deploy/control/nginx.conf` — proxy 80/443 for your domain (e.g. `control.yourdomain.com`) to `127.0.0.1:8787`;
   - Make sure `Upgrade` and `Connection: upgrade` headers are set for WSS.

---

### 4.2 Execution server (4C8G, 2 pods)

#### Option A: K3s (recommended)

1. **Install K3s**:

   ```bash
   curl -sfL https://get.k3s.io | sh -
   ```

2. **Namespace and network policy**:

   ```bash
   kubectl apply -f deploy/k3s/00-namespace.yaml
   kubectl apply -f deploy/k3s/01-network-policy.yaml
   ```

   *All inbound traffic is denied; egress only allows DNS and the outbound reverse connection to the control plane on 443.*

3. **Persistent volumes**:

   ```bash
   kubectl apply -f deploy/k3s/02-storage-pvc.yaml
   ```

   *10GB per user (A and B).*

4. **Token secrets and pods**:

   ```bash
   kubectl create secret generic runtime-secrets-user-a \
     -n lca-runtimes \
     --from-literal=token=sec-runtime-token-a-32-chars-long-pod-1

   kubectl create secret generic runtime-secrets-user-b \
     -n lca-runtimes \
     --from-literal=token=sec-runtime-token-b-32-chars-long-pod-2

   kubectl apply -f deploy/k3s/03-runtime-user-a.yaml
   kubectl apply -f deploy/k3s/04-runtime-user-b.yaml
   ```

5. **Resource limits**: each pod requests `500m CPU / 1Gi RAM` with `limits: 1500m CPU / 2Gi RAM`; two pods peak at 3C / 4Gi, leaving headroom on a 4C8G host.

---

#### Option B: Docker Compose (lightweight)

```bash
cd deploy/runtime
cp .env.example .env
# Fill in CONTROL_WS_URL and both user tokens
docker compose up -d --build
```

---

## 5. API and Tool Reference

### 5.1 Agent tools

Tools are exposed to the agent dynamically based on what is online: desktop devices or cloud pods that are offline (or lack a capability) simply do not appear in the model's tool list. Local tools always go through the user approval dialog; cloud tools run inside the pod sandbox without approval, fully audited.

| Tool | Protocol name | Desktop | Cloud pod | Notes |
| --- | --- | --- | --- | --- |
| Read file | `fs.read` | Yes | Yes | utf8 / base64, 5MB per-file cap |
| List directory | `fs.list` | Yes | Yes | Returns types and file sizes |
| Write file | `fs.write` | Yes (approval) | Yes | Optional parent-directory creation |
| Edit file | `fs.edit` | Yes (approval) | Yes | Exact text replacement, oldText must be unique |
| Glob match | `fs.glob` | Yes (approval) | Yes | Supports `**`, `{a,b}`, `[a-z]` |
| Content search | `fs.grep` | Yes (approval) | Yes | Regex, bounded traversal (2000 files / 1000 hits) |
| Command execution | `shell.exec` | Yes (approval) | Yes | Timeout + output truncation |
| Cross-plane copy | `files.copy` | - | - | Control-plane orchestration: read base64 at source → write at destination |
| Run script | `code.run` | - | Yes | Python / Node / Bash in an isolated scratch dir |
| Web fetch | `web.fetch` | - | Yes | http(s) only, truncated at the body limit |
| Web search | `web.search` | - | Yes | Brave (with key) or DuckDuckGo fallback |
| Browser control | `browser.use` | - | Yes | Headless Chromium: goto / click / type / screenshot |
| Ask the user | `user.ask` | Yes | - | Choice buttons + free-text question dialog |
| Notebook read | `notebook.read` | Yes (approval) | Yes | nbformat 4 parsing |
| Notebook edit | `notebook.edit` | Yes (approval) | Yes | Insert / replace / delete cells |
| Language service | `lsp.query` | - | Yes | TS/JS definition / references / type |
| Workspace snapshot | `vcs.checkpoint` | - | Yes | create / restore / list, pure Node implementation |

Not implemented (intentionally excluded, not reserved in the protocol): `image_gen`, `video_gen`, `computer_use`. The `OpenAiCompatibleAgent` is a plain-text engine without tool support; use the Pi engine when tools are needed.

### 5.2 REST and WSS endpoints

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/healthz` | Health check |
| `GET` | `/v1/machines` | List the user's online desktop devices |
| `POST` | `/v1/machines/selection` | Set the preferred device for local file tools |
| `GET` | `/v1/runtimes` | List the user's connected cloud pods and capabilities |
| `GET` | `/v1/sessions` | List sessions |
| `POST` | `/v1/sessions` | Create a session |
| `PATCH` | `/v1/sessions/:id` | Rename a session |
| `DELETE` | `/v1/sessions/:id` | Delete a session with all messages and runs (409 while a task is active) |
| `GET` | `/v1/sessions/:id/messages` | Read session messages |
| `POST` | `/v1/sessions/:id/messages` | Send a message and enqueue an agent run |
| `GET/POST` | `/v1/models/config` | Read / update the active model config |
| `GET/POST` | `/v1/models/configs` | List / upsert saved model profiles |
| `DELETE` | `/v1/models/configs/:id` | Delete a model profile |
| `POST` | `/v1/models/configs/:id/activate` | Activate a profile (subsequent agent runs use that model) |
| `POST` | `/v1/tools/execute` | UI-initiated read-only tool call (whitelisted tools, audited in `ui_tool_calls`) |
| `GET` | `/v1/runs/:id` | Query an agent run |
| `POST` | `/v1/runs/:id/cancel` | Cancel a queued/running task |
| `GET` | `/p/<token>/*` | Public artifact preview route (random token, proxied to the pod's loopback) |
| `WSS` | `/v1/ws` | Unified authenticated channel for devices and pods |

---

## 6. Previewing and Debugging Cloud Artifacts

Web projects the agent generates inside the pod workspace can be opened and debugged directly in the system browser:

1. **Start the artifact**: ask the agent to "run the project". It follows a built-in convention: artifacts go to the session's isolated directory `sessions/<sessionId>/`, the port is read or created in `.port` (30000-39999), `start.sh` starts the service with `nohup` guarded by `.pid`, and the agent self-checks with curl.
2. **Open in browser**: click "Open Preview" at the top-right of the conversation area — the control plane issues a random-token public route (`https://<domain>:<port>/p/<token>/`) and opens it in the default browser, fully interactive. Tokens last 12 hours; re-click after a control-plane restart.
3. **Debug the GUI**: right-click → Inspect in the browser for full DevTools; interactions can also be delegated to the agent via `browser.use`.
4. **File preview and channel**: file data comes from the read-only tool channel (`POST /v1/tools/execute`, whitelist `fs.read/list/glob/grep`, `notebook.read`, `lsp.query`, `browser.use`), audited separately in `ui_tool_calls`. The server needs `PREVIEW_PUBLIC_BASE_URL` configured (e.g. `https://your-domain:8787`).

v1 limitations: no WebSocket upgrade or HMR (manual refresh instead); 5MB per response body; projects needing a dev server are started by the agent via `shell.exec` and accessed through the same route.

## 7. Security Notes

1. **Credential hygiene**: never commit real `.env` files or high-entropy tokens to a public repository;
2. **Explicit approval**: local tool execution requires per-request user approval in the Electron UI;
3. **Intended use**: this project is for legitimate development assistance, automated coding and multi-device task scheduling. Do not use it for unauthorized remote control or destructive operations.
