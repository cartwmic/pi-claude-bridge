#!/usr/bin/env bash
# Scenario S16a — /fork: pi forks mid-conversation.
# Bridge must drop cached session_id when pi creates a fork.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s16a"

SESSION_DIR="$(mktemp -d /tmp/s16a-pi-sessions.XXXXXX)"
trap 'tmux kill-session -t "$SESSION" 2>/dev/null || true; rm -rf "$SESSION_DIR"' EXIT

tmux new-session -d -s "$SESSION" -x 200 -y 50 \
	"cd '$SCENARIO_CWD' && CLAUDE_BRIDGE_DEBUG=1 CLAUDE_BRIDGE_DEBUG_PATH='$BRIDGE_LOG' \
	 pi -ne -e '$REPO_DIR' --session-dir '$SESSION_DIR' --provider claude-bridge --model '$SCENARIO_MODEL'"
sleep 3

# Establish two facts pre-fork
scn_send "My favorite number is 137."
scn_wait_for "(137|got|noted)" 60 || scn_fail "Turn 1"
scn_send "And my favorite color is octarine."
scn_wait_for "(octarine|got|noted)" 60 || scn_fail "Turn 2"

# Trigger /fork
tmux send-keys -t "$SESSION:0" -- "/fork"
tmux send-keys -t "$SESSION:0" Enter
sleep 4

# On forked branch — should see BOTH facts (history up to fork point preserved)
scn_send "What did I tell you about myself?"
scn_wait_for "(137|octarine)" 60 || scn_fail "Forked turn — no recall"

echo "==== S16a results ===="

# Architectural: clearSession was triggered by fork
if grep -qE "session_start:fork|dropping cached session" "$BRIDGE_LOG"; then
	scn_pass "fork triggered clearSession"
else
	scn_fail "fork did not trigger clearSession"
fi

# Coherence: forked branch saw both facts
if grep -qiE "137" "$PANE_LOG" && grep -qiE "octarine" "$PANE_LOG"; then
	scn_pass "coherence: both facts recalled on forked branch"
else
	scn_fail "coherence: not all facts on forked branch"
fi

# Forked branch's CC session_id is fresh (cold-start expected)
forked_cold=$(grep -cE "streamSimple: fresh query.*resume=no" "$BRIDGE_LOG" || echo 0)
echo "  total cold-starts: $forked_cold (>=2 expected: initial + post-fork)"
if (( forked_cold >= 2 )); then
	scn_pass "post-fork cold-start observed"
else
	scn_fail "expected >=2 cold-starts (pre + post fork), got $forked_cold"
fi

echo "Cache profile (last 6):"
scn_cache_profile | tail -6

echo "===================="
exit $SCN_FAILED
