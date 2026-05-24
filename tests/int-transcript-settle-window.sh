#!/usr/bin/env bash
# T1.18 — Stop arrives before terminal result; bounded settle catches it (D17)
set -euo pipefail
if ! command -v claude >/dev/null 2>&1; then
  echo "[T1.18 int-transcript-settle-window] skip — claude not on PATH"
  exit 0
fi
if [ "${SKIP_PTY_INT_TESTS:-0}" = "1" ]; then
  echo "[T1.18 int-transcript-settle-window] skip — SKIP_PTY_INT_TESTS=1"
  exit 0
fi
cd "$(dirname "$0")/.."
exec node --import tsx tests/int-transcript-settle-window.mjs
