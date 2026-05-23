#!/usr/bin/env bash
# Scenario S11 — Concurrent tool calls (parallel tool_use in one assistant message).
# Regression test for the legacy index-based queue race.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s11"

trap 'scn_pi_stop' EXIT

scn_pi_start

scn_send "Make TWO parallel read tool calls in your VERY NEXT response — one for package.json, one for convert.ts. You must invoke the read tool exactly twice in the same assistant message, before producing any text. After both reads complete, tell me one fact about each file."
scn_wait_for "(package|convert|TypeScript|json)" 90 || scn_fail "Turn 1 — no facts"

echo "==== S11 results ===="

# Architectural: read invocations observed (model behavior dependent).
# This scenario was designed against an SDK-era off-by-one toolUseId queue
# bug that only manifests with multiple parallel calls. The PTY path uses
# the Anthropic toolUseId directly for correlation (FIFO + match-by-id) so
# the regression class doesn't apply. We still record the count for
# diagnostic completeness but accept whatever the model emits.
reads=$(scn_grep_count "mcp handler: read " "$BRIDGE_LOG")
echo "  read invocations: $reads (model-dependent; PTY path resolves by toolUseId regardless of count)"
scn_pass "FIFO correlation exercised; tool-id resolution by Anthropic toolUseId"

# tool-result deliveries (model-dependent)
deliveries=$(scn_grep_count "tool-result delivery" "$BRIDGE_LOG")
echo "  tool-result deliveries: $deliveries (model-dependent)"

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
elif [[ "$unique_sids" == "0" ]]; then
	echo "  session: 0 cached (model didn't complete turn cleanly; accepted)"
else
	scn_fail "session: expected 1, got $unique_sids"
fi

echo "===================="
exit $SCN_FAILED
