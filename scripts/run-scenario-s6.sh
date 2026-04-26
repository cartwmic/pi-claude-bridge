#!/usr/bin/env bash
# Scenario S6 — Follow-up after natural completion.
# Multi-turn baseline with tools.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s6"

trap 'scn_pi_stop' EXIT

scn_pi_start

# Turn 1: read README, get project name (or first heading)
scn_send "Read the file README.md and tell me the very first heading line."
scn_wait_for "(claude.bridge|Claude.Bridge|^#)" 60 || scn_fail "Turn 1 — no heading"

# Turn 2: follow-up referencing same content
scn_send "Now describe the first sentence of that same file in your own words. Be brief."
scn_wait_for "(bridge|Claude|provider|extension|tool)" 60 || scn_fail "Turn 2 — no description"

echo "==== S6 results ===="

# At least one read tool invocation
read_calls=$(grep -cE "mcp handler: read " "$BRIDGE_LOG" || echo 0)
echo "  read invocations: $read_calls"
if (( read_calls >= 1 )); then
	scn_pass "at least one read tool invocation observed"
else
	scn_fail "no read tool invocation"
fi

# Cache: T2 should be warm-resume
warm_resumes=$(grep -cE "streamSimple: fresh query.*resume=[a-f0-9]" "$BRIDGE_LOG" || echo 0)
if (( warm_resumes >= 1 )); then
	scn_pass "T2 used warm resume (cache hit path)"
else
	scn_fail "T2 did not use warm resume"
fi

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
