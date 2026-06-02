#!/usr/bin/env bash
# T1.13 — abort mid-turn (mechanics) against real pi + real claude-p.
# Builds the bridge, then runs int-claude-p-abort.mjs under node --test.
# Concurrency 1 (single test process). Does NOT override CLAUDE_CONFIG_DIR/HOME.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"
npm run build >/dev/null
exec node --test tests/int-claude-p-abort.mjs
