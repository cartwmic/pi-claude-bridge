#!/usr/bin/env bash
# Scenario S12 — Long conversation (cache + context behavior).
# 8+ turns including a planted token; final coherence probe checks recall.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s12"

trap 'scn_pi_stop' EXIT

scn_pi_start

# Turn 1: plant the token
scn_send "My session token is XYZZY-7. Acknowledge it briefly."
scn_wait_for "(XYZZY|token|noted|acknowledge|remember)" 60 || scn_fail "Turn 1 failed"

# 6 filler turns — text only to keep this fast
for i in 1 2 3 4 5 6; do
	scn_send "Quick filler turn $i — just say 'turn $i ok' and nothing else."
	scn_wait_for "(turn $i|ok|filler|$i)" 60 || scn_fail "Filler turn $i failed"
done

# Probe: recall the token
scn_send "What was my session token?"
scn_wait_for "XYZZY" 60 || scn_fail "Recall — token not returned"

echo "==== S12 results ===="

# Architectural: 1 cold-start, many warm-resumes
cold=$(scn_grep_count "streamSimple: fresh query.*resume=no" "$BRIDGE_LOG")
warm=$(scn_grep_count "streamSimple: fresh query.*resume=[a-f0-9]" "$BRIDGE_LOG")
echo "  cold-starts: $cold  warm-resumes: $warm"
if (( cold == 1 && warm >= 6 )); then
	scn_pass "1 cold + >=6 warm (long-conversation cache contract)"
else
	scn_fail "expected 1 cold + >=6 warm, got $cold cold + $warm warm"
fi

# Coherence: token must appear EXACTLY in final response
if grep -qE "XYZZY-7" "$PANE_LOG"; then
	scn_pass "coherence: exact token 'XYZZY-7' recalled"
else
	scn_fail "coherence: exact token NOT recalled"
fi

echo "Cache profile (last 3):"
scn_cache_profile | tail -6

unique_sids=$(scn_session_count)
if [[ "$unique_sids" == "1" ]]; then
	scn_pass "session: 1 cached session_id (no churn across $((cold + warm)) turns)"
else
	scn_fail "session: expected 1, got $unique_sids"
fi

echo "===================="
exit $SCN_FAILED
