#!/usr/bin/env bash
# Scenario S16b — /tree: navigate to an earlier branch leaf.
# Different from /fork: same session file, leaf moves within the tree.
# Bridge sees a different (shorter) history on the next turn.
#
# Note: /tree opens an interactive picker UI which is hard to drive
# deterministically via tmux. We assert behavior on what we CAN drive:
# the mere act of opening /tree should not break the bridge state.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s16b"

SESSION_DIR="$(mktemp -d /tmp/s16b-pi-sessions.XXXXXX)"
trap 'tmux kill-session -t "$SESSION" 2>/dev/null || true; rm -rf "$SESSION_DIR"' EXIT

tmux new-session -d -s "$SESSION" -x 200 -y 50 \
	"cd '$SCENARIO_CWD' && CLAUDE_BRIDGE_DEBUG=1 CLAUDE_BRIDGE_DEBUG_PATH='$BRIDGE_LOG' \
	 pi -ne -e '$REPO_DIR' --session-dir '$SESSION_DIR' --provider claude-bridge --model '$SCENARIO_MODEL'"
sleep 3

# Build a 3-turn conversation
scn_send "My pet's name is Fizzgig."
scn_wait_for "(Fizzgig|got|noted)" 60 || scn_fail "Turn 1"
scn_send "And my pet is a fremen mouse."
scn_wait_for "(fremen|mouse|got|noted)" 60 || scn_fail "Turn 2"

# Open /tree (UI picker — we can verify it opens and that we can dismiss it)
tmux send-keys -t "$SESSION:0" -- "/tree"
tmux send-keys -t "$SESSION:0" Enter
sleep 2
# Try to navigate up to an earlier entry, then dismiss
tmux send-keys -t "$SESSION:0" "Up"
sleep 1
tmux send-keys -t "$SESSION:0" "Up"
sleep 1
tmux send-keys -t "$SESSION:0" "Enter"
sleep 3

# After tree navigation, send a new message
scn_send "What's my pet's species?"
scn_wait_for "(mouse|fremen|species|don't know|not sure)" 60 || scn_fail "Post-tree — no answer"

echo "==== S16b results ===="

# Architectural: bridge did not crash
if grep -qE "stack|Traceback|TypeError" "$BRIDGE_LOG"; then
	scn_fail "bridge errored during /tree workflow"
else
	scn_pass "no bridge errors during /tree workflow"
fi

# Bridge log should show normal activity (queries continued)
caches=$(grep -cE "caching session=" "$BRIDGE_LOG" || echo 0)
echo "  caching events: $caches"
if (( caches >= 2 )); then
	scn_pass "bridge continued caching across /tree"
else
	scn_fail "bridge did not cache after /tree (count=$caches)"
fi

echo "Cache profile (last 8):"
scn_cache_profile | tail -8

echo "===================="
exit $SCN_FAILED
