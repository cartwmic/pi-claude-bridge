#!/usr/bin/env bash
# confirm-example-repo.sh — end-to-end confirmation in a FRESH example repo (not
# chezmoi, not the bridge repo): drive pi + the bridge with the model the user
# actually uses (opus-4-7) and prove a real tool round-trip works AND no
# tool-protocol leak fires. SCENARIO_CWD points pi at the example project.
set -uo pipefail
source "$(dirname "$0")/scenario-lib.sh"

: "${EXAMPLE_DIR:=/tmp/pi-bridge-example}"
export SCENARIO_CWD="$EXAMPLE_DIR"
: "${SCENARIO_MODEL:=claude-bridge/claude-opus-4-7}"; export SCENARIO_MODEL

SCN_FAILED=0
scn_setup "example-confirm"
trap 'scn_pi_stop' EXIT
scn_pi_start

# Turn 1 — force a real tool round-trip in the example repo.
scn_send "Use the read tool to read package.json in this directory, then tell me the package name and version."
scn_wait_for "widget-inventory" 90 || scn_fail "T1 — package name not in response"
scn_wait_for "2\.4\.1" 90 || scn_fail "T1 — version not in response"

# Turn 2 — coherence: answer from the prior tool result (should NOT re-read).
scn_send "What is this package's main entry file?"
scn_wait_for "src/index\.js|index\.js" 90 || scn_fail "T2 — main entry not in response"

echo "==== example-repo confirmation ===="

# A real tool actually routed to pi (not a text-leaked pseudo-call).
if grep -qE "onRouterPark: routed tools/call|mcp handler: read .*(awaiting pi|early result)" "$BRIDGE_LOG" 2>/dev/null \
   && grep -qE "tool-result delivery" "$BRIDGE_LOG" 2>/dev/null; then
	scn_pass "real tool round-trip routed to pi and result delivered (opus, fresh repo)"
else
	scn_fail "no real tool round-trip in bridge log — tool surface did not work"
fi

# No tool-protocol leak at all (the scn_pi_stop trap also enforces this).
if grep -qE "toolProtocolLeak" "$BRIDGE_LOG" 2>/dev/null; then
	scn_fail "tool-protocol leak event in bridge log (opus emitted tool calls as text)"
else
	scn_pass "no tool-protocol leak event in bridge log"
fi

read_calls=$(scn_tool_count_named read)
echo "  read tool invocations: $read_calls"

echo "===================="
exit $SCN_FAILED
