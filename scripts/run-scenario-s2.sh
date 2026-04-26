#!/usr/bin/env bash
# Scenario S2 — Multi-step tool plan (sequential).
# Validates the SDK's internal tool loop runs to completion in one query()
# without bridge re-entry between tool rounds.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s2"

trap 'scn_pi_stop' EXIT

scn_pi_start

scn_send "List the .ts files in the current directory using bash 'ls *.ts'. Then read the smallest one. Then summarize it in one sentence."
scn_wait_for "(summary|summarize|defines|provides)" 90 || scn_fail "Turn 1 — no summary in response"

# Coherence probe: model should reference the listing it saw
scn_send "What was the second .ts file you considered but didn't read?"
scn_wait_for "(\.ts|index|convert|models)" 60 || scn_fail "Turn 2 — no file reference"

echo "==== S2 results ===="

# Architectural: at least 2 tool calls in T1 (ls + read at minimum)
tool_invocations=$(grep -cE "mcp handler:" "$BRIDGE_LOG" || echo 0)
echo "  total mcp handler invocations: $tool_invocations"
if (( tool_invocations >= 2 )); then
	scn_pass "tool loop ran to completion (>=2 tool calls)"
else
	scn_fail "expected >=2 tool calls, got $tool_invocations"
fi

# Coherence: response should mention a specific .ts filename from the listing
if grep -qE "(index\.ts|convert\.ts|models\.ts)" "$PANE_LOG"; then
	scn_pass "coherence: model referenced specific files from listing"
else
	scn_fail "coherence: no specific file reference in response"
fi

echo "Cache profile:"
scn_cache_profile

unique_sids=$(scn_session_count)
echo "Distinct CC session_ids: $unique_sids"
if [[ "$unique_sids" == "1" ]]; then
	scn_pass "session: 1 cached session_id (single query spanned all tool rounds)"
else
	scn_fail "session: expected 1, got $unique_sids"
fi

echo "===================="
exit $SCN_FAILED
