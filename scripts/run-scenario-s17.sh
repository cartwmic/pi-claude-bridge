#!/usr/bin/env bash
# Scenario S17 — Compaction (pi-driven).
# Pi compacts via /compact; bridge requires zero compaction-specific code.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s17"

trap 'scn_pi_stop' EXIT

scn_pi_start

# Plant a token early so we can verify it survives compaction
scn_send "The launch code is RUSTED-PHOENIX-7. Acknowledge."
scn_wait_for "(RUSTED|PHOENIX|got|noted|acknowledge)" 60 || scn_fail "Turn 1"

# Filler turns to inflate context
for i in 1 2 3 4 5 6 7 8; do
	scn_send "Filler $i: respond with just 'ok $i'."
	scn_wait_for "(ok|$i|filler)" 60 || scn_fail "Filler $i"
done

# Trigger /compact
tmux send-keys -t "$SESSION:0" -- "/compact"
tmux send-keys -t "$SESSION:0" Enter
sleep 8

# Probe for token after compaction
scn_send "What was the launch code?"
scn_wait_for "(RUSTED|PHOENIX|7|launch)" 90 || scn_fail "Post-compact — no recall"

echo "==== S17 results ===="

# Architectural: bridge did not crash
if grep -qE "stack|Traceback|TypeError" "$BRIDGE_LOG"; then
	scn_fail "bridge errored during /compact"
else
	scn_pass "no bridge errors during /compact"
fi

# Bridge code does NOT mention compaction directly (none should exist)
if grep -qE "compaction|compactionEntry|CompactionEntry" "$BRIDGE_LOG"; then
	scn_fail "bridge log mentions compaction — code may have compaction-specific path"
else
	scn_pass "bridge has no compaction-specific code path (as designed)"
fi

# Coherence: token recalled exactly
if grep -qE "RUSTED-PHOENIX-7" "$PANE_LOG"; then
	scn_pass "coherence: exact token 'RUSTED-PHOENIX-7' recalled after compaction"
else
	scn_fail "coherence: token not recalled (could be pi compaction lossiness — see notes)"
fi

# After compaction, bridge sees changed history → expect at least one cold-start
cold=$(grep -cE "streamSimple: fresh query.*resume=no" "$BRIDGE_LOG" || echo 0)
warm=$(grep -cE "streamSimple: fresh query.*resume=[a-f0-9]" "$BRIDGE_LOG" || echo 0)
echo "  cold-starts: $cold  warm-resumes: $warm"

echo "Cache profile (last 8):"
scn_cache_profile | tail -8

echo "===================="
exit $SCN_FAILED
