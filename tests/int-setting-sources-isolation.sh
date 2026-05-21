#!/usr/bin/env bash
# T1.16 — user-global permissions.allow does not re-enable disallowed tool
set -euo pipefail
if ! command -v claude >/dev/null 2>&1; then
  echo "[T1.16 int-setting-sources-isolation] skip — claude not on PATH"
  exit 0
fi
if [ "${SKIP_PTY_INT_TESTS:-0}" = "1" ]; then
  echo "[T1.16 int-setting-sources-isolation] skip — SKIP_PTY_INT_TESTS=1"
  exit 0
fi
cd "$(dirname "$0")/.."
exec node --import tsx tests/int-setting-sources-isolation.mjs
