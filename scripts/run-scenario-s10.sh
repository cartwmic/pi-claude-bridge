#!/usr/bin/env bash
# Scenario S10 — Durable warm session resume across pi restart.
# Bridge process dies, then a new bridge instance restores the validated
# driver-qualified sidecar and resumes the same Claude session.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s10"

# Use a session-dir we control so we can pass --session on restart.
SESSION_DIR="$(mktemp -d /tmp/s10-pi-sessions.XXXXXX)"
RESTART_SESSION="pi-bridge-s10-restart-$$"
cleanup_s10() {
	local rc=$?
	trap - EXIT
	scn_pi_stop || true
	rm -rf "$SESSION_DIR"
	exit "$rc"
}
trap cleanup_s10 EXIT

# Use the harness's session_dir override path
"${TMUX_CMD[@]}" new-session -d -s "$SESSION" -x 200 -y 50 \
	"cd '$SCENARIO_CWD' && CLAUDE_BRIDGE_DEBUG=1 CLAUDE_BRIDGE_DEBUG_PATH='$BRIDGE_LOG' \
	 PATH='$PATH' pi -ne -e '$REPO_DIR' --session-dir '$SESSION_DIR' --provider claude-bridge --model '$SCENARIO_MODEL'"
scn_wait_ready

scn_send "My favorite number is 137. What is the package name? Use the read tool to read package.json."
scn_wait_for "pi-claude-bridge" 60 || { scn_fail "Turn 1 failed"; echo "===================="; exit $SCN_FAILED; }

# Quit pi via its supported /quit slash command so session JSONL and bridge
# sidecar flush cleanly before restart.
	"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" -- "/quit"
	"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" Enter
sleep 4
scn_pi_stop

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
	 PATH='$PATH' pi -ne -e '$REPO_DIR' --session-dir '$SESSION_DIR' --session '$session_uuid' --provider claude-bridge --model '$SCENARIO_MODEL'"
scn_wait_ready

# Coherence probe — should remember from previous run. Assertions below inspect
# only this response; whole-pane matches would also see the original prompt.
S10_PROBE="What was the package name from earlier, and what was my favorite number?"
scn_send "$S10_PROBE" || scn_fail "Resume — probe turn did not complete"

echo "==== S10 results ===="

# Architectural: initial turn is cold; restarted bridge must restore its
# persisted sidecar and validate a warm resume instead of replaying cold.
cold=$(scn_cold_count)
warm=$(scn_warm_resume_count)
echo "  cold-starts: $cold  warm-resumes: $warm"
if (( cold >= 1 && warm >= 1 )); then
	scn_pass "restart restored validated warm session (cold initial + warm post-restart)"
else
	scn_fail "expected initial cold start plus post-restart warm resume, got cold=$cold warm=$warm"
fi

# Coherence: package name AND favorite number must occur in the model's probe
# response, with no explicit loss-of-memory disclaimer.
resume_response=$(scn_probe_response "$S10_PROBE")
echo "  resume response: $(printf '%s' "$resume_response" | tr '\n' ' ' | cut -c1-180)"
if printf '%s\n' "$resume_response" | grep -qiE "(do not|don't|cannot|can't|unable to) (remember|recall)|no (memory|record)|wasn.t (given|told)"; then
	scn_fail "coherence: model explicitly denied recalling the pre-restart facts"
elif printf '%s\n' "$resume_response" | grep -q "pi-claude-bridge" \
	&& printf '%s\n' "$resume_response" | grep -qE "(^|[^0-9])137([^0-9]|$)"; then
	scn_pass "coherence: probe response recalled both pre-restart facts"
else
	scn_fail "coherence: probe response omitted package name or favorite number"
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
