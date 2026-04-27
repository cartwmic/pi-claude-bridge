#!/usr/bin/env bash
# Scenario S16a — pi `/fork` (via CLI --fork flag).
#
# Drives forking via the CLI flag rather than the interactive `/fork` picker
# so we can keep the claude-bridge provider active in the forked session.
# (In-app `/fork` switches to pi's default model, bypassing the bridge —
# pi-side behavior, not a bridge issue. The architectural test of
# bridge-handles-fork is preserved by --fork.)

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s16a"

# Opus for deterministic recall in the forked branch.
SCENARIO_MODEL="${S16A_MODEL:-claude-bridge/claude-opus-4-7}"

SESSION_DIR="$(mktemp -d /tmp/s16a-pi.XXXXXX)"
RESTART_SESSION="pi-bridge-s16a-fork-$$"
cleanup() {
	"${TMUX_CMD[@]}" kill-session -t "$SESSION" 2>/dev/null || true
	"${TMUX_CMD[@]}" kill-session -t "$RESTART_SESSION" 2>/dev/null || true
	rm -rf "$SESSION_DIR"
}
trap cleanup EXIT

# Phase 1: establish a 2-turn conversation
"${TMUX_CMD[@]}" new-session -d -s "$SESSION" -x 200 -y 50 \
	"cd '$SCENARIO_CWD' && CLAUDE_BRIDGE_DEBUG=1 CLAUDE_BRIDGE_DEBUG_PATH='$BRIDGE_LOG' \
	 pi -ne -e '$REPO_DIR' --session-dir '$SESSION_DIR' --provider claude-bridge --model '$SCENARIO_MODEL'"
sleep 4
scn_send "My favorite number is 137. Acknowledge briefly."
scn_send "And my favorite color is octarine. Acknowledge briefly."

# Quit pi gracefully
	"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" -- "/exit"
	"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" Enter
sleep 4
"${TMUX_CMD[@]}" kill-session -t "$SESSION" 2>/dev/null || true

# Find the saved session UUID
saved=$(ls -t "$SESSION_DIR"/*.jsonl 2>/dev/null | head -1)
if [[ -z "$saved" ]]; then
	scn_fail "no pi session JSONL written"
	echo "===================="
	exit $SCN_FAILED
fi
uuid=$(basename "$saved" .jsonl | awk -F_ '{print $NF}')
echo "  parent session uuid: $uuid"

# Phase 2: fork via --fork (creates new session in same dir, claude-bridge active)
SESSION="$RESTART_SESSION"
"${TMUX_CMD[@]}" new-session -d -s "$SESSION" -x 200 -y 50 \
	"cd '$SCENARIO_CWD' && CLAUDE_BRIDGE_DEBUG=1 CLAUDE_BRIDGE_DEBUG_PATH='$BRIDGE_LOG' \
	 pi -ne -e '$REPO_DIR' --session-dir '$SESSION_DIR' --fork '$uuid' --provider claude-bridge --model '$SCENARIO_MODEL'"
sleep 5

# Coherence probe on the forked branch
scn_send "What facts have I told you about myself in this conversation?"

echo "==== S16a results ===="

# Architectural: pi created a new session file (the fork)
session_count=$(ls "$SESSION_DIR"/*.jsonl 2>/dev/null | wc -l | tr -d ' \n')
echo "  pi session files in dir: $session_count"
if (( session_count >= 2 )); then
	scn_pass "fork created a new session file (parent + fork)"
else
	scn_fail "expected >=2 session files (parent + fork), got $session_count"
fi

# Architectural: bridge clearSession or new cold-start observed for the forked session
fork_clear=$(scn_grep_count "session_start:fork|session_start:resume|dropping cached session" "$BRIDGE_LOG")
echo "  fork-related session_start events: $fork_clear"

# COHERENCE: forked branch must remember both facts (history was preserved through fork)
resp=$(scn_probe_response "What facts have I told you about myself in this conversation")
if echo "$resp" | grep -qiE "(no.*previous|don't see|no facts|haven't told|nothing|no conversation|first conversation|don't have access)"; then
	scn_fail "coherence: model claims it has no record of prior conversation"
elif echo "$resp" | grep -qiE "137" && echo "$resp" | grep -qiE "octarine"; then
	scn_pass "coherence: forked branch recalls BOTH 137 and octarine"
else
	scn_fail "coherence: only one or zero facts recalled (137=$(echo "$resp" | grep -ciE 137), octarine=$(echo "$resp" | grep -ciE octarine))"
fi

echo "Cache profile (last 6):"
scn_cache_profile | tail -6

echo "===================="
exit $SCN_FAILED
