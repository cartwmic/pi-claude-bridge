#!/usr/bin/env bash
# Scenario S8 — User abort during tool execution.
# Validates abort during in-flight tool, no orphan subprocesses.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s8"

trap 'scn_pi_stop' EXIT

scn_pi_start

# Snapshot processes before — pgrep exits 1 with no matches; absorb that.
ps_before=$(pgrep -f "sleep 120" 2>/dev/null | wc -l | tr -d ' \n' || echo 0)
ps_before=${ps_before:-0}

# Send a long-running tool prompt (do NOT wait for completion)
tmux send-keys -t "$SESSION:0" -- "Run this exact bash command: 'sleep 120 && echo HELLO-S8'"
tmux send-keys -t "$SESSION:0" Enter

# Wait until the bash tool is actually running
sleep 6

# Abort
tmux send-keys -t "$SESSION:0" "Escape"
sleep 3

# Coherence probe
scn_send "Did the sleep command finish? What did it print?"

echo "==== S8 results ===="

# Bridge observed abort
if grep -qE "(superseding|onAbort|Operation aborted|interrupt)" "$BRIDGE_LOG"; then
	scn_pass "abort observed in bridge"
else
	scn_fail "no abort observed"
fi

# Coherence: model must NOT claim HELLO-S8 was printed
if grep -qE "HELLO-S8" "$PANE_LOG" && ! grep -qiE "(no|did not|interrupt|abort|stop)" "$PANE_LOG"; then
	scn_fail "coherence: model fabricated HELLO-S8 result"
else
	scn_pass "coherence: model did not fabricate tool result"
fi

# No orphan sleep processes
ps_after=$(pgrep -f "sleep 120" 2>/dev/null | wc -l | tr -d ' \n' || echo 0)
ps_after=${ps_after:-0}
echo "  sleep 120 processes: before=$ps_before  after=$ps_after"
if (( ps_after <= ps_before )); then
	scn_pass "no orphan sleep subprocesses"
else
	scn_fail "$((ps_after - ps_before)) orphan sleep subprocess(es) leaked"
	# Best-effort cleanup
	pkill -f "sleep 120" 2>/dev/null || true
fi

# No legacy abort-surgery
if grep -qE "(UUID rotation|pendingTruncate|truncating)" "$BRIDGE_LOG"; then
	scn_fail "legacy abort-surgery triggered"
else
	scn_pass "no UUID rotation / no JSONL surgery"
fi

echo "Cache profile:"
scn_cache_profile

echo "===================="
exit $SCN_FAILED
