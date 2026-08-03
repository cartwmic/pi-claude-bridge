#!/usr/bin/env bash
# Scenario S15 — Subagent: claude-bridge parent → openai-codex/gpt-5.4 child.
# Validates the bridge is NOT invoked for the child turn.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s15"

# Opus reliably follows explicit subagent tool arguments without exploratory
# list/default-worker calls that can exceed scenario timeout.
SCENARIO_MODEL="${S15_MODEL:-claude-bridge/claude-opus-4-7}"
SCENARIO_SEND_TIMEOUT=300

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
	exit 0
fi

trap 'scn_pi_stop' EXIT

# Give this scenario a child definition with ambient extensions disabled.
# Otherwise the subprocess inherits CLAUDE_BRIDGE_DRIVER from its parent and
# may auto-load a separately installed, older bridge copy. That tests local
# machine package state instead of the intended non-bridge child boundary.
SCN_CLEANUP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/pi-s15-agent.XXXXXX")
export SCN_CLEANUP_DIR
cat > "$SCN_CLEANUP_DIR/s15-openai-worker.md" <<'EOF'
---
name: s15-openai-worker
description: Isolated non-bridge scenario worker
tools: read, write
extensions:
defaultContext: fresh
inheritProjectContext: true
acceptance: false
---
Complete the assigned file task directly and report the requested result.
EOF

"${TMUX_CMD[@]}" new-session -d -s "$SESSION" -x 200 -y 50 \
	"cd '$SCENARIO_CWD' && CLAUDE_BRIDGE_DEBUG=1 CLAUDE_BRIDGE_DEBUG_PATH='$BRIDGE_LOG' \
	 PI_SUBAGENT_EXTRA_AGENT_DIRS='$SCN_CLEANUP_DIR' PATH='$PATH' pi --no-session -ne -e '$REPO_DIR' -e '$SUBAGENT_PATH' --provider claude-bridge --model '$SCENARIO_MODEL'"
scn_wait_ready

# Snapshot bridge usage lines BEFORE subagent dispatch
pre_usage=$(scn_grep_count "\"msg\":\"usage:" "$BRIDGE_LOG")

scn_send "Call the subagent tool once. Do not call list first. Set agent to s15-openai-worker and model to openai-codex/gpt-5.4-mini. Task: read convert.ts, write a one-paragraph technical summary to /tmp/s15-summary.txt, then return its first sentence."

scn_wait_for "(summary|sentence|convert)" 240 || scn_fail "Subagent — no result"

# Take usage delta — DURING the subagent run, bridge should not be called.
# Bridge is called for parent's turn (initial call + tool-result delivery turn).
# Other usage lines during subagent execution would indicate the bridge was
# also invoked for the child turn.
post_usage=$(scn_grep_count "\"msg\":\"usage:" "$BRIDGE_LOG")
echo "  bridge usage lines during scenario: $((post_usage - pre_usage))"

scn_send "What was the first sentence the subagent returned, and which model wrote it?"
scn_wait_for "(gpt|codex|5\.4|mini|model)" 60 || scn_fail "Verification — no model attribution"

echo "==== S15 results ===="

# Coherence: response should mention the openai-codex model and no child
# startup failure may have been rendered.
if grep -qiE "(Subagent invocation failed|Subagent dispatch failed|✗ s15-openai-worker|MCP initialization failed)" "$PANE_LOG"; then
	scn_fail "non-bridge child reported a startup or invocation failure"
elif grep -qiE "(gpt.5\.4|gpt-5\.4|codex|openai)" "$PANE_LOG"; then
	scn_pass "coherence: parent attributed result to openai-codex / gpt-5.4"
else
	scn_fail "coherence: parent did not attribute model"
fi

# /tmp/s15-summary.txt was written by the subagent
if [[ -f /tmp/s15-summary.txt ]]; then
	scn_pass "subagent wrote /tmp/s15-summary.txt"
	echo "  first line: $(head -1 /tmp/s15-summary.txt)"
else
	scn_fail "subagent did not write /tmp/s15-summary.txt"
fi

# CC session_ids: parent's path uses 1, child's path uses 0 → expect exactly 1.
# If we see >1 distinct session_ids, the bridge was unexpectedly invoked for
# the child too — that's a charter violation.
unique_sids=$(scn_session_count)
echo "  bridge CC session_ids: $unique_sids"
if (( unique_sids == 1 )); then
	scn_pass "bridge owned only the parent's CC session (child went elsewhere)"
elif (( unique_sids == 0 )); then
	scn_fail "no CC session captured — parent didn't use bridge?"
else
	scn_fail "bridge handled $unique_sids sessions; expected 1 (parent only)"
fi

echo "Cache profile:"
scn_cache_profile | tail -10

echo "===================="
rm -f /tmp/s15-summary.txt
exit $SCN_FAILED
