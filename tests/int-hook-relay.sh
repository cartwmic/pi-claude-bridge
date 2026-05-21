#!/usr/bin/env bash
# T1.14 — hook-relay end-to-end (SessionStart + Stop payloads reach bridge over IPC)
set -euo pipefail
if ! command -v claude >/dev/null 2>&1; then
  echo "[T1.14 int-hook-relay] skip — claude not on PATH"
  exit 0
fi
if [ "${SKIP_PTY_INT_TESTS:-0}" = "1" ]; then
  echo "[T1.14 int-hook-relay] skip — SKIP_PTY_INT_TESTS=1"
  exit 0
fi
cd "$(dirname "$0")/.."
exec node --import tsx tests/int-hook-relay.mjs
