#!/usr/bin/env bash
# ==============================================================================
# 组装服务器部署分发包：twinbot-server-deploy-<日期>.tar.gz
# 内容 = 源码与服务端部署资产（控制端/执行端一键脚本 + compose + 文档）
# 接收方：在解压目录直接跑 deploy/bootstrap/deploy-control.sh（见包内 README-部署.md）
# ==============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:-$(date +%Y%m%d)}"
OUT="$ROOT/release/twinbot-server-deploy-$VERSION.tar.gz"

mkdir -p "$ROOT/release"
tar czf "$OUT" \
  --exclude=node_modules \
  --exclude=dist \
  --exclude=release \
  --exclude='.env' \
  --exclude='desktop.config.json' \
  --exclude=pnpm-lock.yaml \
  --transform "s,^\.,twinbot-server-deploy," \
  -C "$ROOT" \
  .
echo "分发包已生成: $OUT ($(du -h "$OUT" | cut -f1))"
echo "接收方解压后执行: bash deploy/bootstrap/deploy-control.sh"
