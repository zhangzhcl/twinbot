@echo off
chcp 65001 >nul
title TwinBot 桌面客户端启动器

echo 正在启动 TwinBot 桌面客户端...
npm run dev:desktop
if errorlevel 1 (
  echo 启动失败，请检查是否已安装 Node.js 依赖。
  pause
)
