#!/usr/bin/env bash
# Scenario S11 — Concurrent tool calls (parallel tool_use in one assistant message).
# Regression test for the legacy index-based queue race.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s11"

trap 'scn_pi_stop' EXIT

scn_pi_start

scn_send "Read both package.json and convert.ts in parallel and tell me one fact about each. Use the read tool for both, in the same response."
scn_wait_for "(package|convert|TypeScript|json)" 90 || scn_fail "Turn 1 — no facts"

echo "==== S11 results ===="

# Architectural: at least 2 read invocations
reads=$(scn_tool_count_named read)
echo "  read invocations: $reads"
if (( reads >= 2 )); then
	scn_pass ">=2 read tool calls observed"
else
	scn_fail "expected >=2 reads, got $reads"
fi

# tool-result deliveries (each tool yields one delivery line)
deliveries=$(scn_grep_count "tool-result delivery" "$BRIDGE_LOG")
echo "  tool-result deliveries: $deliveries"
if (( deliveries >= 1 )); then
	scn_pass "tool-result deliveries observed"
else
	scn_fail "no tool-result deliveries"
fi

# No bridge-log warnings about toolUseId mismatch (FIFO match held)
if grep -qE "no toolUseId in queue|BUG" "$BRIDGE_LOG"; then
	scn_fail "FIFO match broke (toolUseId mismatch in queue)"
else
	scn_pass "FIFO toolUseId match held across parallel calls"
fi

# Coherence: response should mention BOTH files
if grep -qiE "package.json" "$PANE_LOG" && grep -qiE "convert" "$PANE_LOG"; then
	scn_pass "coherence: both files referenced"
else
	scn_fail "coherence: did not reference both files"
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
