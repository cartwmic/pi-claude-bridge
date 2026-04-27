#!/usr/bin/env bash
# Scenario S5 — Steering mid-stream.
# Send long-content prompt; while assistant is generating, send Escape +
# new prompt. Architecture: bridge interrupts active query, next user
# message resumes the (now-interrupted) session — model sees both topics.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s5"

trap 'scn_pi_stop' EXIT

scn_pi_start

# Turn 1: long output. Do NOT wait for completion.
	"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" -- "Write a long, detailed essay about the history of the printing press. Include specific dates, people, and several paragraphs. Take your time."
	"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" Enter

# Wait for the model to actually start producing content.
sleep 6

# Steer: Escape to interrupt + new prompt.
	"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" Escape
sleep 2
scn_send "Actually stop — make it brief and about the typewriter instead."

# Coherence probe (separate turn to make assertion clean).
scn_send "Earlier in this conversation, did I ever ask you about the printing press? Reply yes or no, briefly."

echo "==== S5 results ===="

# Architectural: onAbort fired
if grep -qE "onAbort:" "$BRIDGE_LOG"; then
	scn_pass "onAbort fired (steer interrupted active turn)"
else
	scn_fail "no onAbort — steer didn't actually interrupt mid-stream"
fi

# No legacy deferred-replay
if grep -qE "(deferredUserMessages|continuation query)" "$BRIDGE_LOG"; then
	scn_fail "legacy deferred-replay observed"
else
	scn_pass "no deferred-replay"
fi

# COHERENCE: model must affirm prior printing-press request was made.
scn_assert_response \
	"Earlier in this conversation, did I ever ask you about the printing press" \
	"^[^\n]*(yes|did|asked|originally|first|earlier).*(print|press|essay)|^[^\n]*(yes,)" \
	"(no, you|don't recall|don't have|no prior|no.*previous|no.*earlier|haven't asked|first request|only one|i don't have any (previous|prior) context|cannot find any|no record)" \
	"coherence: model affirms prior printing-press request was made"

echo "Cache profile:"
scn_cache_profile

echo "===================="
exit $SCN_FAILED
