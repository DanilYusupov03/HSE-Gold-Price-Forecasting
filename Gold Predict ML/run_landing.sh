#!/usr/bin/env zsh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUNDLED_NODE="/Users/danilyusupov/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"

if command -v node >/dev/null 2>&1; then
  NODE_BIN="node"
elif [ -x "$BUNDLED_NODE" ]; then
  NODE_BIN="$BUNDLED_NODE"
else
  echo "Node.js не найден. Установите Node.js или запустите проект из Codex runtime."
  exit 1
fi

PORT="${PORT:-8765}"

echo "Starting landing backend on http://localhost:${PORT}"
cd "$SCRIPT_DIR"
PORT="$PORT" "$NODE_BIN" landing/app.js
