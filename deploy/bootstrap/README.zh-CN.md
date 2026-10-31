<div align="center">

[English](README.md) | **简体中文**

</div>

# TwinBot 服务器部署指南（给拿到桌面端的另一台服务器的管理员）

桌面端安装包只是客户端。要让整套系统工作，需要在一台（或两台）**你自己的 Ubuntu/Debian 服务器**上部署两个服务：

- **控制端**（必须）：数据库 + 任务调度 + 模型配置存储，桌面端连接的就是它；
- **执行端 Pod**（每用户一个容器）：云端代码在这里运行，产物页面经控制面代理回浏览器。

全程约 15 分钟，只需要服务器装好 Docker。

## 执行顺序（先服务器、后桌面端）

部署全部发生在**你自己的云服务器上**（SSH 终端里执行命令），桌面端不参与部署，只是最后连接的客户端：

1. **SSH 连接控制服务器** → 解压分发包 → 执行 `deploy-control.sh`（交互式填写域名与用户数）——生成桌面端三行配置和 runtime.env；
2. **把 runtime.env 复制到执行服务器**（scp/U盘均可）→ SSH 连接执行服务器 → 解压分发包 → 执行 `deploy-runtime.sh`——Pod 启动并自动连回控制面；
3. **最后启动桌面端**（Windows 电脑安装/运行）→ 首启自动弹出「服务连接」页签 → 填入控制端打印的三行配置 → 重启即连接成功。

顺序不能颠倒：桌面端要填的三行配置是控制端脚本生成的；执行端要连的 WSS 地址也在其中。

## 0. 准备

- 一台 2C4G 起的 Ubuntu/Debian 服务器（控制端），已安装 Docker；
- 一个已解析到该服务器的域名（桌面端要求 wss 加密连接，证书由内置 Caddy 自动签发）；
- 若执行端单独一台：再加一台 4C8G 服务器。

## 1. 控制端（一条命令）

```bash
unzip twinbot-server-deploy.zip && cd twinbot-server-deploy
bash deploy/bootstrap/deploy-control.sh
```

脚本会交互式询问：**对外域名**、**接入用户数量**、**控制端端口**，然后自动：

- 生成数据库密码、管理员 Token、每个用户的接入 Token、每个 Pod 的执行 Token（全部随机，写入 `deploy/control/.env`）；
- 构建并启动控制面（含 PostgreSQL 与 Caddy HTTPS 网关，自动签发证书）；
- 生成 `runtime.env`（执行端部署用）与 `twinbot-desktop-config.txt`（桌面端「服务连接」三行配置）。

完成后健康检查通过即部署成功。

## 2. 执行端 Pod（每个用户一个容器）

```bash
# 把控制端生成的 runtime.env 复制到执行服务器的解压包根目录
bash deploy/bootstrap/deploy-runtime.sh
```

脚本构建并启动 Pod 容器（含 Chromium / Python3 / Node），自动连回控制面。默认镜像支持 2 个用户，更多用户照 `deploy/runtime/docker-compose.yaml` 里现有服务段复制即可（每用户一个独立数据卷）。

## 3. 桌面端（每个用户）

把控制端输出的 `twinbot-desktop-config.txt` 里三行发给用户：

- `CONTROL_API_URL` / `CONTROL_WS_URL` / 该用户的接入 Token；

用户首次打开桌面端会自动弹出「服务连接」页签，填入后重启即连到自己的控制端。模型 Key 在「智能体模型与供应商」页签由用户自行保存（按用户隔离，互不可见）。

## 4. 常用运维

```bash
docker compose logs control-api      # 控制面日志
docker compose logs runtime-user-a   # Pod 日志
docker compose down                  # 停止（数据卷保留）
```

- 模型配置/会话/审计都在控制面数据库里，备份 `postgres-data` 卷即可；
- 执行端用户数据在各 Pod 的 `workspace-user-*` 卷；
- 新增用户 = 控制端 .env 加 Token + 执行端加一个容器（见上）。
