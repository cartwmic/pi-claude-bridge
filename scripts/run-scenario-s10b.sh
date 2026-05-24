#!/usr/bin/env bash
# Scenario S10b — Warm cache resume within the same pi process.
# Counterpart to S10's cold restart.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s10b"

# Use opus for deterministic recall behavior. Haiku occasionally goes into
# tool-use mode for "remember this" prompts and the regex-matched ack never
# appears, even though the cache/resume architecture is fine.
SCENARIO_MODEL="${S10B_MODEL:-claude-bridge/claude-opus-4-7}"

trap 'scn_pi_stop' EXIT

scn_pi_start

scn_send "Please respond with just 'noted' to acknowledge: my favorite color is octarine. Remember it."
scn_wait_for "(octarine|noted|remember|acknowledge)" 90 || scn_fail "Turn 1 — no acknowledgement"

scn_send "What was my favorite color? One word."
scn_wait_for "octarine" 90 || scn_fail "Turn 2 — color not recalled"

echo "==== S10b results ===="

# Architectural: T1 cold-start, T2 warm-resume
cold=$(scn_grep_count "streamSimple: fresh query.*resume=no" "$BRIDGE_LOG")
warm=$(scn_grep_count "streamSimple: fresh query.*resume=[a-f0-9]" "$BRIDGE_LOG")
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
