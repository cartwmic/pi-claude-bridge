#!/usr/bin/env bash
# T1.12 — tool-round via PTY driver (model calls bridged tool, pi delivers result, model continues)
set -euo pipefail
if ! command -v claude >/dev/null 2>&1; then
  echo "[T1.12 int-pty-tool-round] skip — claude not on PATH"
  exit 0
fi
if [ "${SKIP_PTY_INT_TESTS:-0}" = "1" ]; then
  echo "[T1.12 int-pty-tool-round] skip — SKIP_PTY_INT_TESTS=1"
  exit 0
fi
cd "$(dirname "$0")/.."
exec node --import tsx tests/int-pty-tool-round.mjs
