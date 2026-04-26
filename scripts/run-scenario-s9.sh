#!/usr/bin/env bash
# Scenario S9 — Abort then immediate steer.
# Stress the boundary between abort cleanup and the next prompt.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s9"

trap 'scn_pi_stop' EXIT

scn_pi_start

# Over-broad request that will trigger tool calls
tmux send-keys -t "$SESSION:0" -- "Read every .ts file in this repo and write a long detailed summary of each one with code citations."
tmux send-keys -t "$SESSION:0" Enter
sleep 7

# Abort
tmux send-keys -t "$SESSION:0" Escape
sleep 2

# Immediate steer
scn_send "Forget that — just tell me how many .ts files there are total. Use bash 'ls *.ts | wc -l'. Be brief."

# Coherence probe — does the model remember the abandoned task?
scn_send "Briefly: what did I originally ask, and what did I switch to? In one sentence each."

echo "==== S9 results ===="

if grep -qE "onAbort:" "$BRIDGE_LOG"; then
	scn_pass "onAbort fired"
else
	scn_fail "no onAbort"
fi

if grep -qE "(deferredUserMessages|continuation query)" "$BRIDGE_LOG"; then
	scn_fail "legacy deferred-replay observed"
else
	scn_pass "no deferred-replay"
fi

# COHERENCE: enumeration must reference both the abandoned task (long summaries / read .ts)
# AND the actual task done (count .ts).
resp=$(scn_probe_response "what did I originally ask, and what did I switch to")
echo "  --- response ---"
echo "$resp" | head -c 800
echo "  --- end ---"

if echo "$resp" | grep -qiE "(no.*previous|don't.*see|can't see|can't.*recall|only.*one)"; then
	scn_fail "coherence: model claims it doesn't see prior request"
else
	mentions_orig=$(echo "$resp" | grep -ciE "(summari[sz]e|long|read every|detail|each one|original.*read)")
	mentions_switch=$(echo "$resp" | grep -ciE "(count|how many|number of|wc -l|total)")
	echo "  mentions: original=$mentions_orig switch=$mentions_switch"
	if (( mentions_orig >= 1 && mentions_switch >= 1 )); then
		scn_pass "coherence: model recalls both abandoned and current tasks"
	else
		scn_fail "coherence: missing reference to either abandoned or current task"
	fi
fi

echo "Cache profile:"
scn_cache_profile

echo "===================="
exit $SCN_FAILED
