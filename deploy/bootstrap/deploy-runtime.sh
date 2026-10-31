#!/usr/bin/env bash
# ==============================================================================
# TwinBot 执行端（Pod）一键部署（Ubuntu / Debian + Docker）
# 用法：解压分发包后，在包根目录执行  bash deploy/bootstrap/deploy-runtime.sh
# 前置：先在控制端服务器跑完 deploy-control.sh，把生成的 runtime.env 复制到本机包根目录
# ==============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="$ROOT/deploy/runtime/.env"

command -v docker >/dev/null 2>&1 || { echo "错误：未安装 Docker（curl -fsSL https://get.docker.com | sh）"; exit 1; }
[[ -f "$ROOT/runtime.env" ]] || { echo "错误：未找到 runtime.env——先在控制端跑 deploy-control.sh，把它生成的 runtime.env 复制到本包根目录"; exit 1; }

echo "==== TwinBot 执行端（Pod）部署 ===="
# 合并 runtime.env 到执行端 .env（保留其中的 CONTROL_WS_URL 与各 RUNTIME_TOKEN）
cp "$ROOT/runtime.env" "$ENV_FILE"
cat >> "$ENV_FILE" <<ENV
NODE_ENV=production
ENV

echo "正在构建 Pod 镜像（首次约 5-8 分钟，含 Chromium 与 Python3）…"
cd "$ROOT/deploy/runtime"
docker compose build
docker compose up -d

sleep 5
docker compose ps
echo "执行端已启动。回到控制端服务器查看 Pod 是否注册（GET /v1/runtimes），"
echo "或直接在桌面端对话中让 Agent 执行 shell.exec 自检。"
