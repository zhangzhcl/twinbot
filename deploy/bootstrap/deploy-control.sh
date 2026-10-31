#!/usr/bin/env bash
# ==============================================================================
# TwinBot 控制端一键部署（Ubuntu / Debian + Docker）
# 用法：解压分发包后，在包根目录执行  bash deploy/bootstrap/deploy-control.sh
# 产物：控制面（含数据库与可选 HTTPS 网关）+ 桌面端「服务连接」三行配置 + 执行端所需 Token
# ==============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="$ROOT/deploy/control/.env"

command -v docker >/dev/null 2>&1 || { echo "错误：未安装 Docker（curl -fsSL https://get.docker.com | sh）"; exit 1; }
command -v openssl >/dev/null 2>&1 || { echo "错误：未安装 openssl"; exit 1; }

echo "==== TwinBot 控制端部署 ===="
read -rp "对外域名（必须已解析到本机，桌面端要求 wss 加密连接，如 chat.example.com）: " DOMAIN
[[ -z "$DOMAIN" ]] && { echo "错误：必须提供域名"; exit 1; }
read -rp "接入用户数量 [1]: " USER_COUNT
USER_COUNT="${USER_COUNT:-1}"
case "$USER_COUNT" in ''|*[!0-9]*) USER_COUNT=1 ;; esac
read -rp "控制端 HTTP 端口 [8787]: " CONTROL_PORT
CONTROL_PORT="${CONTROL_PORT:-8787}"

# ---- 生成全部凭据（自动，无需手动记录）----
PG_PASS="$(openssl rand -hex 16)"
ADMIN_TOKEN="tb-admin-$(openssl rand -hex 16)"

ADMIN_JSON="{"
USER_JSON="{"
RUNTIME_LINES=""
for i in $(seq 1 "$USER_COUNT"); do
  USER_ID="user-$i"
  USER_TOKEN="tb-user-$(openssl rand -hex 16)"
  RT_TOKEN="tb-rt-$(openssl rand -hex 16)"
  ADMIN_JSON="$ADMIN_JSON\"$USER_TOKEN\":\"$USER_ID\""
  USER_JSON="$USER_JSON\"$RT_TOKEN\":{\"userId\":\"$USER_ID\",\"podId\":\"pod-$USER_ID\"}"
  RUNTIME_LINES="$RUNTIME_LINESRUNTIME_TOKEN_USER_$i=$RT_TOKEN$NL"
  [ "$i" -lt "$USER_COUNT" ] && { ADMIN_JSON="$ADMIN_JSON,"; USER_JSON="$USER_JSON,"; }
done
ADMIN_JSON="$ADMIN_JSON}"
USER_JSON="$USER_JSON}"

# ---- 写控制端 .env ----
mkdir -p "$ROOT/deploy/control"
cat > "$ENV_FILE" <<ENV
DOMAIN=$DOMAIN
POSTGRES_PASSWORD=$PG_PASS
CONTROL_PORT=$CONTROL_PORT
CONTROL_TOKENS_JSON=$ADMIN_JSON
CLOUD_RUNTIME_TOKENS_JSON=$USER_JSON
COMPOSE_PROFILES=tls
ENV

echo "已生成 $ENV_FILE"

# ---- 构建 + 启动（含 caddy TLS 网关）----
cd "$ROOT/deploy/control"
echo "正在构建控制面镜像（首次约 3-5 分钟）…"
docker compose build
docker compose --profile tls up -d

# ---- 健康检查 ----
sleep 6
HEALTH=$(curl -s -o /dev/null -w "%{http_code}" -m 5 "http://127.0.0.1:$CONTROL_PORT/healthz" || echo 000)
if [ "$HEALTH" != "200" ]; then
  echo "警告：健康检查未通过（$HEALTH），请查看 docker compose logs control-api"
else
  echo "控制面已就绪（healthz 200）"
fi

# ---- 生成执行端部署所需的 Token 文件 ----
RUNTIME_ENV="$ROOT/runtime.env"
{
  echo "CONTROL_WS_URL=wss://$DOMAIN"
  echo "$RUNTIME_LINES" | sed ':a;N;$!ba;s/\n/\n/g'
} > "$RUNTIME_ENV"
echo "已生成 $RUNTIME_ENV（复制到执行服务器部署 Pod 用）"

# ---- 输出桌面端「服务连接」三行 ----
DESKTOP_CFG="$ROOT/twinbot-desktop-config.txt"
{
  echo "CONTROL_API_URL=https://$DOMAIN"
  echo "CONTROL_WS_URL=wss://$DOMAIN"
  echo "接入 Token（每人一个，依次对应 user-1..N）:"
  echo "$ADMIN_JSON" | tr ',' '\n' | grep -o '"tb-user[^:]*'
} > "$DESKTOP_CFG"
echo "桌面端配置已写入 $DESKTOP_CFG"
echo "完成。执行端 Pod 部署见 runtime.env 与 deploy/bootstrap/README.md"
