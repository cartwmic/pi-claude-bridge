#!/usr/bin/env bash
# Scenario S28 — a held tool round LONGER than the idle watchdog window must
# SURVIVE (Layer 2 of the hung-turn fix; the user's actual bug).
#
# THE BUG: a long-running tool/subagent (a HELD round — claude-p is alive but
# idle, blocked on the MCP round-trip while pi runs the tool) was killed when a
# fixed timeout fired during that idle wait. The fix: the bridge's idle watchdog
# is HELD-ROUND-AWARE — while a tool is parked (pendingResolvers > 0) it NEVER
# fires; it defers entirely to the tool's own (pi-enforced) timeout.
#
# This scenario sets a deliberately SHORT watchdog window (8s) and runs a real
# bash tool that sleeps LONGER than that (20s). If the watchdog were not
# held-round-aware it would kill the turn mid-tool. It must instead:
#   - tick during the held round and DEFER (positive log signal),
#   - never declare a wedge / never kill claude-p,
#   - let the tool round complete and the result reach the model.
#
# Tier: submit + coherence probe (the tool result must reach the model).

set -euo pipefail

# Tool-call reliability: pin opus (haiku sometimes narrates a tool instead of
# invoking it — see scenario-overrides.conf rationale for s20). Respect an
# external override.
export SCENARIO_MODEL="${SCENARIO_MODEL:-claude-bridge/claude-opus-4-7}"

# Layer 2 knob: a SHORT watchdog window so the 20s held round clearly outlasts
# it (must exceed boot+first-output, which on opus is a few seconds → 8s margin).
export SCN_PI_ENV="CLAUDE_BRIDGE_WATCHDOG_IDLE_MS=8000"

source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
SENTINEL="HELDROUND-OK-7K3"
scn_setup "s28-timeout-held-round"

trap 'scn_pi_stop' EXIT
scn_pi_start

# ---- Phase 1: run a real bash tool that outlasts the watchdog window ---------
# Be explicit so the model actually INVOKES bash (not narrate it). The sleep
# (20s) is > the 8s watchdog window, so a non-held-round-aware watchdog would
# fire mid-tool.
scn_send "Use the bash tool right now to run exactly: sleep 20 && echo $SENTINEL — actually invoke the tool, do not just describe it. After it returns, tell me what it printed."

echo "==== S28 results ===="

# Mechanical: a real bash tool round actually routed (the held round opened).
bash_routed=$(scn_tool_count_named "bash")
if (( bash_routed >= 1 )); then
	scn_pass "bash tool round actually routed (held round opened): $bash_routed"
else
	scn_fail "no bash tool round routed — held round never opened (test setup failure)"
fi

# Mechanical (POSITIVE): the watchdog ticked DURING the held round and deferred.
# This is the load-bearing signal: it proves the watchdog was active, its window
# elapsed while the tool was parked, and it chose NOT to kill.
deferrals=$(scn_grep_count "watchdog: tick during held round" "$BRIDGE_LOG")
if (( deferrals >= 1 )); then
	scn_pass "watchdog ticked during the held round and DEFERRED ($deferrals time(s))"
else
	scn_fail "watchdog never logged a held-round deferral — it may not have ticked (window too long?) or not be wired"
fi

# Mechanical (NEGATIVE): the watchdog must NOT have declared a wedge / killed.
if grep -qE "declaring wedge|killing wedged claude-p|wedgeKill" "$BRIDGE_LOG"; then
	scn_fail "watchdog WRONGLY declared a wedge / killed claude-p during a healthy held round"
else
	scn_pass "no wedge declared, no kill — healthy held round left alone"
fi

# Mechanical: the held tool round completed (the result was delivered back).
if grep -qE "tool-result delivery|mcp handler: bash .* early result|caching session=" "$BRIDGE_LOG"; then
	scn_pass "held round completed (tool result delivered + turn finalized)"
else
	scn_fail "held round did not complete (no tool-result delivery / no completion)"
fi

# COHERENCE: the tool's output must have reached the model end-to-end. If the
# watchdog had killed the held round, the bash result would never have reached
# the model and it could not echo the sentinel.
scn_send "What exact text did that bash command print? Reply with only that text."
scn_assert_response \
	"What exact text did that bash command print" \
	"$SENTINEL" \
	"(did not|didn't|no output|never (ran|printed|completed)|interrupted|error|timed out|timeout)" \
	"coherence: the held tool's output reached the model (sentinel echoed back)"

echo "Cache profile:"
scn_cache_profile
echo "===================="
exit $SCN_FAILED
