#!/usr/bin/env bash
# Scenario S14 — Subagent: claude-bridge → claude-bridge worker.
# Requires pi-subagents to be loaded, which is normally enabled via the
# user's pi packages. Since the harness uses -ne (no auto extensions), we
# load pi-subagents explicitly via -e.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s14"

# Opus for deterministic subagent dispatch. Haiku doesn't always pick the
# subagent tool for the requested task; opus is more reliable on tool routing.
SCENARIO_MODEL="${S14_MODEL:-claude-bridge/claude-opus-4-7}"

# Find pi-subagents installation
SUBAGENT_PATH=""
for cand in \
	"$HOME/.pi/agent/git/github.com/cartwmic/pi-subagents" \
	"$HOME/.pi/agent/git/github.com/badlogic/pi-subagents" \
	"$HOME/git/pi-subagents"; do
	if [[ -f "$cand/index.ts" ]] || [[ -f "$cand/package.json" ]]; then
		SUBAGENT_PATH="$cand"
		break
	fi
done

if [[ -z "$SUBAGENT_PATH" ]]; then
	echo "  SKIP: pi-subagents not installed"
	echo "  Looked in:"
	echo "    \$HOME/.pi/agent/git/github.com/cartwmic/pi-subagents"
	echo "    \$HOME/.pi/agent/git/github.com/badlogic/pi-subagents"
	echo "    \$HOME/git/pi-subagents"
	exit 0  # Don't fail the suite — record as skipped
fi

trap 'scn_pi_stop' EXIT

# Pin the child to this worktree's bridge copy. Ambient child extension loading
# can otherwise select a separately installed legacy bridge and make the
# scenario test machine package state instead of parent→child bridge routing.
SCN_CLEANUP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/pi-s14-agent.XXXXXX")
export SCN_CLEANUP_DIR
cat > "$SCN_CLEANUP_DIR/s14-bridge-worker.md" <<EOF
---
name: s14-bridge-worker
description: Scenario worker pinned to current bridge worktree
tools: bash
extensions: $REPO_DIR
defaultContext: fresh
inheritProjectContext: true
acceptance: false
---
Run the assigned command and return its exact result.
EOF

# Custom start with both extensions
"${TMUX_CMD[@]}" new-session -d -s "$SESSION" -x 200 -y 50 \
	"cd '$SCENARIO_CWD' && CLAUDE_BRIDGE_DEBUG=1 CLAUDE_BRIDGE_DEBUG_PATH='$BRIDGE_LOG' \
	 PI_SUBAGENT_EXTRA_AGENT_DIRS='$SCN_CLEANUP_DIR' PATH='$PATH' pi --no-session -ne -e '$REPO_DIR' -e '$SUBAGENT_PATH' --provider claude-bridge --model '$SCENARIO_MODEL'"
scn_wait_ready

pre_completions=$(scn_grep_count "caching session=" "$BRIDGE_LOG")
scn_send --no-wait "Use the subagent tool ONCE to dispatch agent s14-bridge-worker on claude-bridge/claude-haiku-4-5. Task: run bash 'ls *.ts | wc -l' to count .ts files, then return the count in its message. Do not call list first."
# Both child and parent use the bridge. Waiting for only the first new caching
# line races: the child completes first and the harness would kill the parent
# before it consumes the subagent result.
scn_wait_for_log_count "caching session=" $((pre_completions + 2)) 240 || scn_fail "parent and child bridge turns did not both complete"
scn_assert_selected_driver_spawn || scn_fail "selected driver did not own S14"
scn_capture >/dev/null

echo "==== S14 results ===="

# Subagent tool was invoked
subagent_calls=$(scn_tool_count_named subagent)
echo "  subagent invocations: $subagent_calls"

# Multiple distinct CC session_ids (parent + child each get one)
unique_sids=$(scn_session_count)
echo "  CC session_ids: $unique_sids"
if (( unique_sids >= 2 )); then
	scn_pass "parent+child CC sessions are distinct"
else
	scn_fail "child did not establish a distinct bridge session"
fi

if grep -qiE "(Subagent invocation failed|Subagent dispatch failed|✗ s14-bridge-worker|MCP initialization failed)" "$PANE_LOG"; then
	scn_fail "bridge child reported a startup or invocation failure"
else
	scn_pass "bridge child completed without rendered failure"
fi

# Architectural: subagent tool was actually invoked at least once
subagent_calls_check=$(scn_tool_count_named subagent)
if (( subagent_calls_check >= 1 )); then
	scn_pass "subagent tool was invoked through the bridge (>=1 routed tool call)"
else
	scn_fail "subagent tool was never invoked"
fi

# Architectural: bridge log shows tool-result delivery for the subagent
# (proving pi delivered a real result back through the bridge — whether
# the worker wrote a side-effect file or not is a worker-behavior concern,
# not a bridge concern).
if grep -q "tool-result delivery" "$BRIDGE_LOG"; then
	scn_pass "bridge delivered subagent tool result back to parent SDK"
else
	scn_fail "no tool-result delivery — subagent didn't return"
fi

echo "Cache profile (last 6):"
scn_cache_profile | tail -6

echo "===================="
exit $SCN_FAILED
