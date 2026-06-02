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
	"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" -- "Count from 1 to 100. For EACH number write 2-3 sentences of meditative reflection in markdown. Do not skip any numbers. Take your time."
	"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" Enter

# Poll the bridge log for an in-flight turn, then send Escape MID-stream.
# We want to abort BEFORE 'caching session=' appears (that's the turn-complete marker).
#
# Cross-driver mid-turn signal:
#   - SDK path streams incrementally → a "usage:" line appears mid-stream
#     while content is still flowing; that's the classic abort window.
#   - claude-p path runs `claude --print`, which BUFFERS the whole turn and
#     emits "usage:" only at completion. There is no mid-stream usage line.
#     The only in-flight signal is the spawn line ("fresh spawn"/"fresh
#     query"): once it appears the model is generating (this prompt runs
#     ~50s on haiku), so we wait a few seconds after spawn and abort while
#     the turn is still running (before caching session=).
deadline=$((SECONDS + 30))
sent_escape=0
while (( SECONDS < deadline )); do
	if grep -qE "caching session=" "$BRIDGE_LOG" 2>/dev/null; then
		# Turn already finished — too late to abort mid-stream.
		echo "WARN: model finished before abort window opened" >&2
		break
	fi
	# SDK mid-stream usage line — abort immediately after a brief settle.
	if grep -qE "\"msg\":\"usage:" "$BRIDGE_LOG" 2>/dev/null; then
		sleep 2  # let some content actually appear
		"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" Escape
		sent_escape=1
		break
	fi
	# claude-p (or SDK pre-usage): turn has spawned and is generating but no
	# usage line yet. Give it a few seconds of generation, then abort.
	if grep -qE "fresh spawn|fresh query" "$BRIDGE_LOG" 2>/dev/null; then
		sleep 5  # let the buffered turn accumulate content before interrupting
		# Re-check we didn't already complete during the settle.
		if ! grep -qE "caching session=" "$BRIDGE_LOG" 2>/dev/null; then
			"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" Escape
			sent_escape=1
			break
		fi
	fi
	sleep 0.5
done
sleep 3

# Turn 2 (coherence probe): now wait for completion.
scn_send "What number did you reach before I interrupted you? Reply with just the number, briefly."

echo "==== S7 results ===="

# Architectural: bridge observed onAbort
if grep -qE "onAbort" "$BRIDGE_LOG"; then
	scn_pass "bridge onAbort fired"
else
	scn_fail "bridge onAbort never fired (abort signal didn't reach bridge)"
fi

# Architectural: cachedSessionId preserved across abort (so resume works on T2)
# Look for resume=<id> on a subsequent fresh query.
post_abort_resumes=$(scn_warm_resume_count)
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
#
# NEG was previously over-broad: `i finished` matched "I finished number 1 completely"
# (the model accurately reporting *which* number it completed before interruption).
# Tightened so NEG only fires on whole-task completion claims or explicit interruption denials.
# POS expanded to robustly catch "I reached number 2" / "got to 2" / standalone "2" /
# "stopped at number 2" phrasings.
scn_assert_response \
	"What number did you reach before I interrupted you" \
	"(reached|got to|stopped at).*[0-9]+|number[[:space:]]+(was|[0-9])|^[[:space:]]*[0-9]+[.,!]?[[:space:]]*\$|i (reached|stopped at|got to)[[:space:]]+(number[[:space:]]+)?[0-9]+" \
	"(wasn't|was not) interrupted|didn't interrupt|never interrupted|no interruption|completed (the (entire|full|whole)|all 100|all the numbers|the count)|reached (100|all 100)|finished (the (count|task|whole|entire))|finished all (100|the numbers)|got to 100|i finished everything" \
	"coherence: model reports a specific reached number, not 'wasn't interrupted'"

echo "Cache profile:"
scn_cache_profile

echo "===================="
exit $SCN_FAILED
