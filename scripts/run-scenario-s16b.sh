#!/usr/bin/env bash
# Scenario S16b — pi `/tree` (active leaf navigation).
# After /tree moves the leaf back, the bridge must detect history
# divergence and cold-start a fresh SDK session — otherwise the model
# would still see "abandoned" branch content from the SDK's transcript.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s16b"

trap 'scn_pi_stop' EXIT

scn_pi_start

# 2-turn conversation: Fact A, Fact B
scn_send "Fact A: my pet is named Fizzgig. Acknowledge briefly."
scn_send "Fact B: my pet is a fremen mouse. Acknowledge briefly."

# Open /tree picker
tmux send-keys -t "$SESSION:0" -- "/tree"
tmux send-keys -t "$SESSION:0" Enter
sleep 3

# In the picker, navigate up 2 entries to land on assistant-after-Fact-A.
# (Default selection is the leaf, which is assistant-after-Fact-B.)
tmux send-keys -t "$SESSION:0" Up
sleep 0.5
tmux send-keys -t "$SESSION:0" Up
sleep 1

# Confirm leaf selection
tmux send-keys -t "$SESSION:0" Enter
sleep 2

# Pi may show "Summarize branch?" dialog — choose "No summary" (default)
tmux send-keys -t "$SESSION:0" Enter
sleep 3

# Coherence probe: model should NOT know about Fact B (it's no longer on the active branch)
scn_send "What is my pet's species? Be brief."

echo "==== S16b results ===="

# Architectural: divergence detected and cached session dropped
if grep -qE "history divergence detected" "$BRIDGE_LOG"; then
	scn_pass "bridge detected history-shape divergence after /tree"
else
	scn_fail "bridge did NOT detect history divergence — model will see stale SDK transcript"
fi

# After divergence, post-tree turn should be a cold-start (resume=no)
post_tree_cold=$(scn_grep_count "streamSimple: fresh query.*resume=no" "$BRIDGE_LOG")
echo "  cold-starts in run: $post_tree_cold"
if (( post_tree_cold >= 2 )); then
	scn_pass "post-tree turn cold-started (>=2 cold-starts: initial + post-tree)"
else
	scn_fail "expected >=2 cold-starts (initial + post-tree), got $post_tree_cold"
fi

# COHERENCE: model must NOT know "fremen mouse" (since Fact B is no longer
# on the active branch). It might say it doesn't know the species, or that
# only Fact A was given.
resp=$(scn_probe_response "What is my pet's species")
echo "  --- response ---"
echo "$resp" | head -c 600
echo "  --- end ---"

if echo "$resp" | grep -qiE "(fremen.mouse|fremen)"; then
	scn_fail "coherence: model still knows 'fremen mouse' — divergence wasn't applied (Fact B leaked from stale SDK session)"
else
	if echo "$resp" | grep -qiE "(don't.*know|haven't told|not.*told|no.*species|don't have|first conversation|Fizzgig)"; then
		scn_pass "coherence: model correctly does NOT know species (Fact B isn't on active branch)"
	else
		# Model said something — let's accept it as long as it doesn't claim fremen
		scn_pass "coherence: model didn't claim 'fremen mouse' (divergence applied)"
	fi
fi

echo "Cache profile (last 8):"
scn_cache_profile | tail -8

echo "===================="
exit $SCN_FAILED
