#!/usr/bin/env bash
# T1.14 — late tool-result after abort, against real pi + real claude-p.
# Builds the bridge, then runs int-claude-p-abort-late-tool-result.mjs.
# Concurrency 1. Does NOT override CLAUDE_CONFIG_DIR/HOME.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"
npm run build >/dev/null
exec node --test tests/int-claude-p-abort-late-tool-result.mjs
