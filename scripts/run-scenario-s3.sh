#!/usr/bin/env bash
# Scenario S3 — Long-running tool execution (≥30s).
# Validates no bridge timeout / no generator restart while a tool runs.
# Uses bash 'sleep 30' for portability vs. requiring a 45s wall-clock test.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s3"

trap 'scn_pi_stop' EXIT

scn_pi_start

scn_send "Run this exact bash command and confirm you saw the marker: 'sleep 30 && echo DONE-MARKER-9F2A'"
scn_wait_for "(DONE-MARKER-9F2A|9F2A|complete|finished)" 120 || scn_fail "Turn 1 — marker not seen"

# Coherence probe: ask about the duration
scn_send "How long did that sleep take, roughly?"
scn_wait_for "(30|thirty|second)" 60 || scn_fail "Turn 2 — no duration mention"

echo "==== S3 results ===="

# Tool: bash invocation
bash_calls=$(grep -cE "mcp handler: bash " "$BRIDGE_LOG" || echo 0)
echo "  bash invocations: $bash_calls"
if (( bash_calls >= 1 )); then
	scn_pass ">=1 bash tool invocation"
else
	scn_fail "no bash tool invocation"
fi

# Architectural: no MCP handler timed out / no warning about toolUseId
if grep -qE "BUG|WARN|no toolUseId" "$BRIDGE_LOG"; then
	scn_fail "bridge logged BUG/WARN during long tool"
else
	scn_pass "no errors during long tool execution"
fi

# Coherence: marker must appear in response (not made up)
if grep -qE "DONE-MARKER-9F2A|9F2A" "$PANE_LOG"; then
	scn_pass "coherence: model quoted exact marker"
else
	scn_fail "coherence: marker not quoted"
fi

echo "Cache profile:"
scn_cache_profile

echo "===================="
exit $SCN_FAILED
