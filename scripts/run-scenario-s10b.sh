#!/usr/bin/env bash
# Scenario S10b — Warm cache resume within the same pi process.
# Counterpart to S10's cold restart.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s10b"

trap 'scn_pi_stop' EXIT

scn_pi_start

scn_send "My favorite color is octarine. Remember it."
scn_wait_for "(octarine|got|noted|remember)" 60 || scn_fail "Turn 1 — no acknowledgement"

scn_send "What was my favorite color?"
scn_wait_for "octarine" 60 || scn_fail "Turn 2 — color not recalled"

echo "==== S10b results ===="

# Architectural: T1 cold-start, T2 warm-resume
cold=$(grep -cE "streamSimple: fresh query.*resume=no" "$BRIDGE_LOG" || echo 0)
warm=$(grep -cE "streamSimple: fresh query.*resume=[a-f0-9]" "$BRIDGE_LOG" || echo 0)
echo "  cold-starts: $cold  warm-resumes: $warm"
if (( cold == 1 && warm == 1 )); then
	scn_pass "1 cold + 1 warm (correct shape)"
else
	scn_fail "expected 1 cold + 1 warm, got $cold cold + $warm warm"
fi

# Coherence: must answer "octarine"
if grep -qiE "octarine" "$PANE_LOG"; then
	scn_pass "coherence: model recalled 'octarine'"
else
	scn_fail "coherence: no recall"
fi

# Cache profile: T2's read tokens should be > 0
echo "Cache profile:"
scn_cache_profile

unique_sids=$(scn_session_count)
if [[ "$unique_sids" == "1" ]]; then
	scn_pass "session: 1 cached session_id"
else
	scn_fail "session: expected 1, got $unique_sids"
fi

echo "===================="
exit $SCN_FAILED
