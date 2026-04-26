#!/usr/bin/env bash
# Scenario S0 — Baseline: text-only multi-turn.
# See SCENARIOS.md for the canonical spec.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s0"

trap 'scn_pi_stop' EXIT

scn_pi_start

# Turn 1
scn_send "My favorite number is 137. Remember it."
scn_wait_for "(137|Got it|noted|remember)" 60 || scn_fail "Turn 1 — no acknowledgement"

# Turn 2 (coherence probe)
scn_send "What two-digit number did I just give you, and is it prime?"
scn_wait_for "(prime|137|thirty-seven|3 ?7)" 60 || scn_fail "Turn 2 — no recall"

scn_capture > /dev/null
echo "==== S0 results ===="

# Coherence assertion: response should mention 137 (or "37" portion) and "prime"
if grep -qE "(137|3 ?7).{0,100}prime" "$PANE_LOG"; then
	scn_pass "coherence: model recalled 137 and identified it as prime"
elif grep -qE "(137|3 ?7)" "$PANE_LOG" && grep -qiE "prime" "$PANE_LOG"; then
	scn_pass "coherence: model mentioned 137 and prime (separately)"
else
	scn_fail "coherence: no specific recall of 137+prime"
fi

# Cache profile: T1 = creation, T2 = read
echo "Cache profile:"
scn_cache_profile

unique_sids=$(scn_session_count)
echo "Distinct CC session_ids: $unique_sids"
if [[ "$unique_sids" == "1" ]]; then
	scn_pass "session: 1 cached session_id (warm path)"
else
	scn_fail "session: expected 1, got $unique_sids"
fi

# JSONL invariant: bridge must not have touched ~/.claude/sessions/
# (We can't verify "didn't touch" definitively here, but we can verify
# that our debug log doesn't mention writing.)
if grep -qE "writing|truncating|UUID rotation|pendingTruncate" "$BRIDGE_LOG"; then
	scn_fail "bridge wrote to ~/.claude/sessions or did UUID rotation"
else
	scn_pass "no bridge JSONL surgery"
fi

echo "===================="
exit $SCN_FAILED
