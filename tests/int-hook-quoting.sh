#!/usr/bin/env bash
# T1.20 — hook command with shim path containing a space (D19/Round-5 A.P2)
set -euo pipefail
if ! command -v claude >/dev/null 2>&1; then
  echo "[T1.20 int-hook-quoting] skip — claude not on PATH"
  exit 0
fi
if [ "${SKIP_PTY_INT_TESTS:-0}" = "1" ]; then
  echo "[T1.20 int-hook-quoting] skip — SKIP_PTY_INT_TESTS=1"
  exit 0
fi
cd "$(dirname "$0")/.."
exec node --import tsx tests/int-hook-quoting.mjs
