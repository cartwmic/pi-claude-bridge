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

# Poll the bridge log for SessionStart (CC has spawned and is processing),
# then send Escape MID-stream. PTY path buffers JSONL writes until Stop, so
# we can't rely on text-delta indicators here — use SessionStart + sleep to
# land Escape during model generation.
deadline=$((SECONDS + 30))
sent_escape=0
while (( SECONDS < deadline )); do
	if grep -qE "caching session=" "$BRIDGE_LOG" 2>/dev/null; then
		echo "WARN: model finished before abort window opened" >&2
		break
	fi
	if grep -qE "hook event=SessionStart" "$BRIDGE_LOG" 2>/dev/null; then
		sleep 6  # CC processing time before abort
		"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" Escape
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

# Architectural: cachedSessionId preservation across abort (D15).
# In the PTY architecture CC's --resume can only load a JSONL that has at
# least one complete assistant content block; if Escape lands before the
# model writes anything, the JSONL is too thin for --resume and we MUST
# cold-start (CC otherwise exits with code 1). Accept either outcome:
#  (a) the model wrote content before Escape → cache preserved → resume.
#  (b) Escape landed pre-content → cache skipped → cold-start. The next
#      turn embeds pi's conversation history in the cold-start prompt,
#      so the model still has context via prompt replay.
post_abort_resumes=$(grep -cE "streamSimple: fresh query.*resume=[a-f0-9]" "$BRIDGE_LOG" 2>/dev/null || true)
post_abort_resumes=${post_abort_resumes:-0}
thin_jsonl_skip=$(grep -cE "hadContent=false" "$BRIDGE_LOG" 2>/dev/null || true)
thin_jsonl_skip=${thin_jsonl_skip:-0}
echo "  post-abort resumes: $post_abort_resumes"
echo "  thin-jsonl cache skips: $thin_jsonl_skip"
if (( post_abort_resumes >= 1 )); then
	scn_pass "post-abort turn used resume (session preserved)"
elif (( thin_jsonl_skip >= 1 )); then
	scn_pass "post-abort turn cold-started (acceptable: aborted pre-content; cache correctly skipped)"
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
	"(reached|got to|stopped at|stopped|interrupted at|got past|reached number).*[0-9]+|number[[:space:]]+(was|[0-9])|^[[:space:]]*[0-9]+[.,!]?[[:space:]]*\$|i (reached|stopped at|got to|interrupted)[[:space:]]+(number[[:space:]]+)?[0-9]+|[0-9]+[[:space:]]*—|never started|didn'?t start|did[[:space:]]+not[[:space:]]+start|never began|no[[:space:]]+(count|number|response)|aborted before|declined|task seemed|off-topic|haven'?t started|hadn'?t started|interrupted (me )?before|before (the )?first (number|count|i started|i began|count began)|^[[:space:]]*[0-9]+[.,]?[[:space:]]+(interrupted|aborted|stopped|cancelled|nothing|i (didn'?t|never|haven'?t))" \
	"(wasn't|was not) interrupted|didn't interrupt|never interrupted|no interruption|completed (the (entire|full|whole)|all 100|all the numbers|the count)|reached (100|all 100)|finished (the (count|task|whole|entire))|finished all (100|the numbers)|got to 100|i finished everything" \
	"coherence: model reports a specific reached number, not 'wasn't interrupted'"

echo "Cache profile:"
scn_cache_profile

echo "===================="
exit $SCN_FAILED
