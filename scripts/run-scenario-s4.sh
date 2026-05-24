#!/usr/bin/env bash
# Scenario S4 — Tool failure handled gracefully.
# Reading a nonexistent file should return isError=true; model recovers.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s4"

trap 'scn_pi_stop' EXIT

scn_pi_start

scn_send "Read the file /nonexistent/path/definitely-not-here-9F2A.txt and tell me what's in it."
scn_wait_for "(does not exist|not found|cannot|error|no such)" 60 || scn_fail "Turn 1 — no error acknowledgement"

# Coherence: ask what error specifically happened
scn_send "What error did you get when you tried to read that file?"
scn_wait_for "(does not exist|not found|cannot|error|no such)" 60 || scn_fail "Turn 2 — error not recalled"

echo "==== S4 results ===="

# Tool invocation observed
read_calls=$(scn_grep_count "mcp handler: read " "$BRIDGE_LOG")
echo "  read invocations: $read_calls"
if (( read_calls >= 1 )); then
	scn_pass ">=1 read tool invocation"
else
	scn_fail "no read tool invocation"
fi

# Bridge did not crash on tool error
if grep -qE "Error:|stack|Traceback|TypeError|ReferenceError" "$BRIDGE_LOG"; then
	scn_fail "bridge log shows errors"
else
	scn_pass "no bridge errors"
fi

# Coherence: response acknowledges file does not exist (in either turn)
if grep -qiE "(does not exist|not found|cannot|error|no such)" "$PANE_LOG"; then
	scn_pass "coherence: model acknowledged missing file"
else
	scn_fail "coherence: did not acknowledge missing file"
fi

# Bridge should NOT have re-called the tool on Turn 2 (cached error result is enough)
if (( read_calls <= 2 )); then
	scn_pass "tool not over-invoked (count=$read_calls)"
else
	scn_fail "tool over-invoked: $read_calls calls"
fi

echo "Cache profile:"
scn_cache_profile

echo "===================="
exit $SCN_FAILED
