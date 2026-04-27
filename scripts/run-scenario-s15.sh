#!/usr/bin/env bash
# Scenario S15 — Subagent: claude-bridge parent → openai-codex/gpt-5.4 child.
# Validates the bridge is NOT invoked for the child turn.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s15"

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

"${TMUX_CMD[@]}" new-session -d -s "$SESSION" -x 200 -y 50 \
	"cd '$SCENARIO_CWD' && CLAUDE_BRIDGE_DEBUG=1 CLAUDE_BRIDGE_DEBUG_PATH='$BRIDGE_LOG' \
	 pi --no-session -ne -e '$REPO_DIR' -e '$SUBAGENT_PATH' --provider claude-bridge --model '$SCENARIO_MODEL'"
sleep 3

# Snapshot bridge usage lines BEFORE subagent dispatch
pre_usage=$(grep -cE "\"msg\":\"usage:" "$BRIDGE_LOG" 2>/dev/null || echo 0)

scn_send "Use the subagent tool to dispatch a worker on the openai-codex/gpt-5.4-mini model to write a one-paragraph summary of what convert.ts does in this repo. Tell it to write the summary to /tmp/s15-summary.txt and return the first sentence."

scn_wait_for "(summary|sentence|convert)" 240 || scn_fail "Subagent — no result"

# Take usage delta — DURING the subagent run, bridge should not be called.
# Bridge is called for parent's turn (initial call + tool-result delivery turn).
# Other usage lines during subagent execution would indicate the bridge was
# also invoked for the child turn.
post_usage=$(grep -cE "\"msg\":\"usage:" "$BRIDGE_LOG" 2>/dev/null || echo 0)
echo "  bridge usage lines during scenario: $((post_usage - pre_usage))"

scn_send "What was the first sentence the subagent returned, and which model wrote it?"
scn_wait_for "(gpt|codex|5\.4|mini|model)" 60 || scn_fail "Verification — no model attribution"

echo "==== S15 results ===="

# Coherence: response should mention the openai-codex model
if grep -qiE "(gpt.5\.4|gpt-5\.4|codex|openai)" "$PANE_LOG"; then
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
