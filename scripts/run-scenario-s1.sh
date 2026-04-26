#!/usr/bin/env bash
# Scenario S1 — Single tool call round-trip.
# Validates the MCP-handler-blocks-on-Promise pattern end-to-end.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s1"

trap 'scn_pi_stop' EXIT

scn_pi_start

scn_send "Use the read tool to read package.json from the current directory and tell me the value of the name field."
scn_wait_for "pi-claude-bridge" 60 || scn_fail "Turn 1 — package name not in response"

# Coherence probe: should answer from the existing tool result, NOT re-call the tool.
scn_send "What did that file's version field say?"
scn_wait_for "[0-9]+\.[0-9]+\.[0-9]+" 60 || scn_fail "Turn 2 — version not in response"

echo "==== S1 results ===="

# Tool-flow assertion: bridge log should show MCP handler awaiting + tool-result delivery
if grep -qE "mcp handler:.*awaiting pi" "$BRIDGE_LOG" && \
   grep -qE "tool-result delivery, [0-9]+ results, [0-9]+ resolvers waiting" "$BRIDGE_LOG"; then
	scn_pass "tool-handler/result handshake observed in bridge log"
else
	scn_fail "tool-handler handshake missing in bridge log"
fi

# Tool count: T1 should have 1 read tool. T2 should NOT re-call read (cached result).
read_calls=$(grep -cE "mcp handler: read " "$BRIDGE_LOG" || echo 0)
echo "  read tool invocations: $read_calls"
if [[ "$read_calls" -le "1" ]]; then
	scn_pass "tool result reused (no re-call on Turn 2)"
else
	scn_fail "tool was re-called on Turn 2 (count=$read_calls; should be 1)"
fi

echo "Cache profile:"
scn_cache_profile

unique_sids=$(scn_session_count)
echo "Distinct CC session_ids: $unique_sids"
if [[ "$unique_sids" == "1" ]]; then
	scn_pass "session: 1 cached session_id"
else
	scn_fail "session: expected 1, got $unique_sids"
fi

echo "===================="
exit $SCN_FAILED
