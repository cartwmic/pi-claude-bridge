#!/usr/bin/env bash
# T1.11 — end-to-end held-open claude-p tool round-trip (wrapper).
# Builds the MCP shim dist (so resolveShimPath() finds it), then runs the
# node:test file under tsx. Concurrency 1. Does NOT override
# CLAUDE_CONFIG_DIR/HOME. Requires: pi CLI, claude CLI, node.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

echo "=== int-claude-p-tool-round.sh (T1.11) ==="

# Ensure the built shim exists for resolveShimPath().
npm run build >/dev/null 2>&1

set -a
[ -f .env.test ] && . .env.test
set +a

node --import tsx --test tests/int-claude-p-tool-round.mjs
