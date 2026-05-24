#!/usr/bin/env bash
# T1.19 — warm-resume with immediate assistant output, baseline offset pre-spawn (D24)
set -euo pipefail
if ! command -v claude >/dev/null 2>&1; then
  echo "[T1.19 int-pty-warm-resume-no-loss] skip — claude not on PATH"
  exit 0
fi
if [ "${SKIP_PTY_INT_TESTS:-0}" = "1" ]; then
  echo "[T1.19 int-pty-warm-resume-no-loss] skip — SKIP_PTY_INT_TESTS=1"
  exit 0
fi
cd "$(dirname "$0")/.."
exec node --import tsx tests/int-pty-warm-resume-no-loss.mjs
