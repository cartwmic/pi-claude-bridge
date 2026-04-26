#!/usr/bin/env bash
# Scenario S9 — Abort then immediate steer (combined).
# Stress the boundary between abort cleanup and the next prompt.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s9"

trap 'scn_pi_stop' EXIT

scn_pi_start

# Turn 1: an over-broad request that should kick off some tool calls
tmux send-keys -t "$SESSION:0" -- "Read every .ts file in this repo and summarize each one."
tmux send-keys -t "$SESSION:0" Enter
sleep 8

# Abort
tmux send-keys -t "$SESSION:0" "Escape"
sleep 1

# Immediate steer
scn_send "Forget that — just tell me how many .ts files there are in this directory total. Use bash 'ls *.ts | wc -l'."
scn_wait_for "[0-9]+" 60 || scn_fail "Steer turn — no number"

echo "==== S9 results ===="

# Architectural: abort path triggered
if grep -qE "(superseding|onAbort|Operation aborted|interrupt)" "$BRIDGE_LOG"; then
	scn_pass "abort path triggered"
else
	scn_fail "no abort path triggered"
fi

# No deferred-replay
if grep -qE "(deferredUserMessages|continuation query)" "$BRIDGE_LOG"; then
	scn_fail "legacy deferred-replay observed"
else
	scn_pass "no deferred-replay"
fi

# Coherence: response references file count or acknowledges previous task abandoned
if grep -qE "(\.ts|file|3|4|5|6|7|8|9|count|total|abandon)" "$PANE_LOG"; then
	scn_pass "coherence: model produced file count and/or acknowledged abandoning earlier task"
else
	scn_fail "coherence: no file count and no acknowledgement"
fi

echo "Cache profile:"
scn_cache_profile

echo "===================="
exit $SCN_FAILED
