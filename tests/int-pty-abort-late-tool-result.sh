#!/usr/bin/env bash
# T1.17 — abort mid-tool-round preserves late-tool-result coherence (D15)
set -euo pipefail
if ! command -v claude >/dev/null 2>&1; then
  echo "[T1.17 int-pty-abort-late-tool-result] skip — claude not on PATH"
  exit 0
fi
if [ "${SKIP_PTY_INT_TESTS:-0}" = "1" ]; then
  echo "[T1.17 int-pty-abort-late-tool-result] skip — SKIP_PTY_INT_TESTS=1"
  exit 0
fi
cd "$(dirname "$0")/.."
exec node --import tsx tests/int-pty-abort-late-tool-result.mjs
