#!/usr/bin/env bash
# Scenario S5 — Steering mid-stream.
# Send long-content prompt; while assistant is generating, send a steer.
# The new architecture supersedes (interrupts active query, starts fresh).

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s5"

trap 'scn_pi_stop' EXIT

scn_pi_start

# Turn 1: long output (do NOT use scn_send's wait — we want to interrupt mid-generation)
tmux send-keys -t "$SESSION:0" -- "Write me a long, detailed essay about the history of the printing press. Include specific dates and people. Take your time."
tmux send-keys -t "$SESSION:0" Enter

# Wait for streaming to start (some text appears in the bridge log indicating streaming)
sleep 4

# Steer mid-stream — send via Escape first (treat as steer; pi sees abort + new msg)
# Per pi's keybindings, Escape is app.interrupt. After interrupt, send new msg.
tmux send-keys -t "$SESSION:0" "Escape"
sleep 1
scn_send "Actually stop — make it about the typewriter instead. Be brief."

# Turn 2 coherence probe
scn_send "Did I ever ask you about the printing press in this conversation?"
scn_wait_for "(yes|printing|press|did|originally|first)" 60 || scn_fail "Coherence probe — no recall"

echo "==== S5 results ===="

# Architectural: at least one supersession or abort observed
if grep -qE "(superseding|onAbort|Operation aborted|interrupt)" "$BRIDGE_LOG"; then
	scn_pass "supersession/abort observed in bridge log"
else
	scn_fail "no supersession path triggered"
fi

# No legacy deferred-replay markers
if grep -qE "(deferredUserMessages|continuation query)" "$BRIDGE_LOG"; then
	scn_fail "legacy deferred-replay path triggered (should be gone)"
else
	scn_pass "no deferred-replay path triggered"
fi

# Coherence: probe response should affirm printing press WAS asked about
if grep -qiE "(printing|press|yes|did|first|originally)" "$PANE_LOG"; then
	scn_pass "coherence: model acknowledged abandoned topic in history"
else
	scn_fail "coherence: model did not acknowledge prior printing-press request"
fi

echo "Cache profile:"
scn_cache_profile

echo "===================="
exit $SCN_FAILED
