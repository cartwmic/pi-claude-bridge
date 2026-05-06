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
# Coherence regex design (validated against 12 response shapes including
# bare "Yes.", explicit "Yes, you asked...", "No, you didn't...", denial
# phrases, and false-positive guards like "Yesterday" / "No problem"):
#   POS — clear affirmatives only:
#     1. Standalone "Yes" with non-alpha boundaries (catches Yes. Yes, Yes!).
#     2. Recall phrasings ("earlier you asked", "originally you did", etc).
#   NEG — clear denials only:
#     1. "No" followed by a relevant pronoun/topic word.
#     2. A line that's literally just "No" / "No." / "No!".
#     3. Denial phrases (don't recall, haven't asked, no prior, etc).
#   Both regexes use POSIX [^[:alpha:]] boundaries (portable across BSD/GNU
#   grep) instead of \b. "Yesterday" / "Now" / "No problem" all correctly
#   fail to match in either direction.
scn_assert_response \
	"Earlier in this conversation, did I ever ask you about the printing press" \
	"(^|[^[:alpha:]])[Yy]es([^[:alpha:]]|\$)|(earlier|originally|first|previously)[[:space:]]+you[[:space:]]+(asked|did|wanted|brought)|you[[:space:]]+(originally|earlier|first|previously)[[:space:]]+(asked|did)|yes,[[:space:]]+you" \
	"(^|[^[:alpha:]])[Nn]o[,.!?]?[[:space:]]+(you|i|prior|previous|that|earlier|haven|never|record|recall)|^[[:space:]]*[Nn]o[.,!?]?[[:space:]]*\$|don't[[:space:]]+(recall|remember|have|see)|haven't[[:space:]]+(asked|received|seen|mentioned)|never[[:space:]]+asked|no[[:space:]]+(prior|previous|earlier|record|mention)|cannot[[:space:]]+find|i[[:space:]]+have[[:space:]]+no[[:space:]]+(record|memory|recollection)|first[[:space:]]+request[[:space:]]+from[[:space:]]+you|only[[:space:]]+(one|the)[[:space:]]+(thing|message|request)" \
	"coherence: model affirms prior printing-press request was made"

echo "Cache profile:"
scn_cache_profile

echo "===================="
exit $SCN_FAILED
