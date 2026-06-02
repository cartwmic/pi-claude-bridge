#!/usr/bin/env bash
# T1.10 — end-to-end claude-p main-provider text turn (wrapper).
# Builds the MCP shim dist (so resolveShimPath() finds it), then runs the
# node:test file under tsx. Concurrency 1. Does NOT override
# CLAUDE_CONFIG_DIR/HOME. Requires: pi CLI, claude CLI, node.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

echo "=== int-claude-p-main-turn.sh (T1.10) ==="

# Ensure the built shim exists for resolveShimPath().
npm run build >/dev/null 2>&1

set -a
[ -f .env.test ] && . .env.test
set +a

node --import tsx --test tests/int-claude-p-main-turn.mjs
