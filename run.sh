#!/usr/bin/env bash
# 一条本地启动命令：重建演示库（含楔门 / 联动失败 / 复位退回样例）并启动系统。
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8066}"
HOST="${HOST:-127.0.0.1}"

echo ">> 重建演示数据库与样例（楔门 FM-101 / 联动失败 FM-203 / 复位退回 FM-102）..."
python3 -m firedoor.seed

echo ">> 启动进程内调度与 Web 服务 http://${HOST}:${PORT}"
exec python3 -m firedoor.server --host "$HOST" --port "$PORT"
