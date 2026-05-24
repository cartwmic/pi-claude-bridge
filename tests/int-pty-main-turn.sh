#!/usr/bin/env bash
# T1.11 — end-to-end main-provider turn via PTY driver (text-only).
# Skips if `claude` binary not on PATH (CI safety).
set -euo pipefail
if ! command -v claude >/dev/null 2>&1; then
  echo "[T1.11 int-pty-main-turn] skip — claude not on PATH"
  exit 0
fi
cd "$(dirname "$0")/.."
exec node --import tsx tests/int-pty-main-turn.mjs
