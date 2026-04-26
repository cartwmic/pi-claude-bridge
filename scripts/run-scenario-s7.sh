#!/usr/bin/env bash
# Scenario S7 — User abort during text generation (Escape).
#
# CRITICAL: do NOT use scn_send (which waits for turn completion). The
# abort must arrive WHILE the model is mid-stream. We use raw tmux
# send-keys for the long prompt, sleep briefly, then send Escape.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s7"

trap 'scn_pi_stop' EXIT

scn_pi_start

# Turn 1: long output. Do NOT wait for completion — we want to abort mid-stream.
# Use a verbose prompt that forces the model to write substantial prose between
# numbers, so we have a wide window to abort. Plain "1 to 100" finishes in ~4s
# on haiku and the abort hits idle.
tmux send-keys -t "$SESSION:0" -- "Count from 1 to 100. For EACH number write 2-3 sentences of meditative reflection in markdown. Do not skip any numbers. Take your time."
tmux send-keys -t "$SESSION:0" Enter

# Poll the bridge log for streaming activity, then send Escape MID-stream.
# We want to abort BEFORE 'caching session=' appears (that's the turn-complete marker).
deadline=$((SECONDS + 30))
sent_escape=0
while (( SECONDS < deadline )); do
	if grep -qE "caching session=" "$BRIDGE_LOG" 2>/dev/null; then
		# Turn already finished — too late to abort mid-stream.
		echo "WARN: model finished before abort window opened" >&2
		break
	fi
	# Wait for the SDK to have started streaming (first usage line means content is flowing).
	if grep -qE "^\[.*\] usage: " "$BRIDGE_LOG" 2>/dev/null; then
		sleep 2  # let some content actually appear
		tmux send-keys -t "$SESSION:0" Escape
		sent_escape=1
		break
	fi
	sleep 0.5
done
sleep 3

# Turn 2 (coherence probe): now wait for completion.
scn_send "What number did you reach before I interrupted you? Reply with just the number, briefly."

echo "==== S7 results ===="

# Architectural: bridge observed onAbort
if grep -qE "onAbort:" "$BRIDGE_LOG"; then
	scn_pass "bridge onAbort fired"
else
	scn_fail "bridge onAbort never fired (abort signal didn't reach bridge)"
fi

# Architectural: cachedSessionId preserved across abort (so resume works on T2)
# Look for resume=<id> on a subsequent fresh query.
post_abort_resumes=$(grep -cE "streamSimple: fresh query.*resume=[a-f0-9]" "$BRIDGE_LOG" 2>/dev/null | head -1 | tr -d ' \n' || echo 0)
post_abort_resumes=${post_abort_resumes:-0}
echo "  post-abort resumes: $post_abort_resumes"
if (( post_abort_resumes >= 1 )); then
	scn_pass "post-abort turn used resume (session preserved)"
else
	scn_fail "post-abort turn cold-started (session was dropped — model lost context)"
fi

# No legacy abort-surgery
if grep -qE "(UUID rotation|pendingTruncate|truncating)" "$BRIDGE_LOG"; then
	scn_fail "legacy abort-surgery (should have been deleted)"
else
	scn_pass "no UUID rotation / no JSONL surgery"
fi

# COHERENCE: model must report a specific number AND must NOT claim it wasn't interrupted.
scn_assert_response \
	"What number did you reach before I interrupted you" \
	"(reached|got to|stopped at|number).*[0-9]+|[0-9]+.*reached|^[0-9]+$|number was [0-9]+|interrupted.*[0-9]+" \
	"(wasn't interrupted|was not interrupted|didn't interrupt|completed.*all|reached.*100|finished.*count|i finished|no interruption|completed the (entire|full))" \
	"coherence: model reports a specific reached number, not 'wasn't interrupted'"

echo "Cache profile:"
scn_cache_profile

echo "===================="
exit $SCN_FAILED
