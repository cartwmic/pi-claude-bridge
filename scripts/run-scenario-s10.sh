#!/usr/bin/env bash
# Scenario S10 — Session resume across pi restart.
# Cold-resume case: bridge process dies, in-memory cachedSessionId lost,
# pi restarts and replays history. SDK creates a fresh session_id.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s10"

# Use a session-dir we control so we can pass --session on restart.
SESSION_DIR="$(mktemp -d /tmp/s10-pi-sessions.XXXXXX)"
RESTART_SESSION="pi-bridge-s10-restart-$$"
cleanup_s10() {
	"${TMUX_CMD[@]}" kill-session -t "$SESSION" 2>/dev/null || true
	"${TMUX_CMD[@]}" kill-session -t "$RESTART_SESSION" 2>/dev/null || true
	rm -rf "$SESSION_DIR"
}
trap cleanup_s10 EXIT

# Use the harness's session_dir override path
"${TMUX_CMD[@]}" new-session -d -s "$SESSION" -x 200 -y 50 \
	"cd '$SCENARIO_CWD' && CLAUDE_BRIDGE_DEBUG=1 CLAUDE_BRIDGE_DEBUG_PATH='$BRIDGE_LOG' \
	 pi -ne -e '$REPO_DIR' --session-dir '$SESSION_DIR' --provider claude-bridge --model '$SCENARIO_MODEL'"
sleep 3

scn_send "My favorite number is 137. What is the package name? Use the read tool to read package.json."
scn_wait_for "pi-claude-bridge" 60 || { scn_fail "Turn 1 failed"; echo "===================="; exit $SCN_FAILED; }

# Quit pi via /exit slash command (more deterministic than Ctrl-D)
	"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" -- "/exit"
	"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" Enter
sleep 4
"${TMUX_CMD[@]}" kill-session -t "$SESSION" 2>/dev/null || true

# Find the saved pi session UUID
saved_session=$(ls -t "$SESSION_DIR"/*.jsonl 2>/dev/null | head -1)
if [[ -z "$saved_session" ]]; then
	# pi may save under a project subdir
	saved_session=$(find "$SESSION_DIR" -name "*.jsonl" -type f -print0 | xargs -0 ls -t 2>/dev/null | head -1)
fi
if [[ -z "$saved_session" ]]; then
	scn_fail "no pi session JSONL written under $SESSION_DIR"
	echo "===================="
	exit $SCN_FAILED
fi
# Pi's filename is "<timestamp>_<uuid>.jsonl"; --session accepts a partial UUID.
session_uuid=$(basename "$saved_session" .jsonl | awk -F_ '{print $NF}')
echo "  saved pi session: $saved_session  uuid=$session_uuid"

# Restart pi with --session
SESSION="$RESTART_SESSION"
"${TMUX_CMD[@]}" new-session -d -s "$SESSION" -x 200 -y 50 \
	"cd '$SCENARIO_CWD' && CLAUDE_BRIDGE_DEBUG=1 CLAUDE_BRIDGE_DEBUG_PATH='$BRIDGE_LOG' \
	 pi -ne -e '$REPO_DIR' --session-dir '$SESSION_DIR' --session '$session_uuid' --provider claude-bridge --model '$SCENARIO_MODEL'"
sleep 4

# Coherence probe — should remember from previous run
scn_send "What was the package name from earlier, and what was my favorite number?"
scn_wait_for "(pi-claude-bridge|137)" 60 || scn_fail "Resume — no recall"

echo "==== S10 results ===="

# Architectural: bridge restarted, so we expect at least one cold-start
cold=$(grep -cE "streamSimple: fresh query.*resume=no" "$BRIDGE_LOG" || echo 0)
warm=$(grep -cE "streamSimple: fresh query.*resume=[a-f0-9]" "$BRIDGE_LOG" || echo 0)
echo "  cold-starts: $cold  warm-resumes: $warm"
if (( cold >= 2 )); then
	scn_pass "expected cold-resume after restart (>=2 cold-starts in run)"
else
	scn_fail "expected >=2 cold-starts (initial + post-restart), got $cold"
fi

# Coherence: package name AND favorite number both recalled
mentions_pkg=$(grep -cE "pi-claude-bridge" "$PANE_LOG" || echo 0)
mentions_num=$(grep -cE "137" "$PANE_LOG" || echo 0)
echo "  mentions: pkg=$mentions_pkg num=$mentions_num"
if (( mentions_pkg >= 1 && mentions_num >= 1 )); then
	scn_pass "coherence: both pre-restart facts recalled"
else
	scn_fail "coherence: missing either pkg name or favorite number"
fi

# No JSONL surgery
if grep -qE "(UUID rotation|pendingTruncate|truncating)" "$BRIDGE_LOG"; then
	scn_fail "legacy JSONL surgery"
else
	scn_pass "no JSONL surgery"
fi

echo "Cache profile (last 6):"
scn_cache_profile | tail -6

echo "===================="
exit $SCN_FAILED
