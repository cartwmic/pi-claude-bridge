#!/usr/bin/env bash
# T1.13 — abort mid-turn (SIGINT propagation + done(aborted))
set -euo pipefail
if ! command -v claude >/dev/null 2>&1; then
  echo "[T1.13 int-pty-abort] skip — claude not on PATH"
  exit 0
fi
if [ "${SKIP_PTY_INT_TESTS:-0}" = "1" ]; then
  echo "[T1.13 int-pty-abort] skip — SKIP_PTY_INT_TESTS=1"
  exit 0
fi
cd "$(dirname "$0")/.."
exec node --import tsx tests/int-pty-abort.mjs
