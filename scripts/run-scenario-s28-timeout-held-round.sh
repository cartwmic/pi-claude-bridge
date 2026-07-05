#!/usr/bin/env bash
# Scenario S28 — a long-running HELD tool round must SURVIVE with NO liveness
# timeout machinery present (post `no-liveness-timeouts-add-visibility`).
#
# DESIGN (current): the bridge has NO idle/wedge watchdog and NO claude-p
# --timeout. A held round (claude-p alive but idle, blocked on the MCP
# round-trip while pi runs the tool) is NEVER killed by any timer — there is no
# timer. Liveness is entirely caller-driven (pi's own per-tool timeout / abort).
# So a tool round of ANY duration must complete and its result must reach the
# model. This scenario proves the long held round survives AND that none of the
# removed timeout/wedge machinery is present in the log.
#
# Tier: submit + coherence probe (the tool result must reach the model).

set -euo pipefail

# Tool-call reliability: pin opus (haiku sometimes narrates a tool instead of
# invoking it — see scenario-overrides.conf rationale for s20). Respect an
# external override.
export SCENARIO_MODEL="${SCENARIO_MODEL:-claude-bridge/claude-opus-4-7}"

# No watchdog/timeout knobs: those env vars were removed with the watchdog and
# claude-p --timeout. A long held round survives because nothing can time it out.

source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
SENTINEL="HELDROUND-OK-7K3"
scn_setup "s28-timeout-held-round"

trap 'scn_pi_stop' EXIT
scn_pi_start

# ---- Phase 1: run a real bash tool that holds the round open for ~20s --------
scn_send "Use the bash tool right now to run exactly: sleep 20 && echo $SENTINEL — actually invoke the tool, do not just describe it. After it returns, tell me what it printed."

echo "==== S28 results ===="

# Mechanical: a real bash tool round actually routed (the held round opened).
bash_routed=$(scn_tool_count_named "bash")
if (( bash_routed >= 1 )); then
	scn_pass "bash tool round actually routed (held round opened): $bash_routed"
else
	scn_fail "no bash tool round routed — held round never opened (test setup failure)"
fi

# Mechanical (NEGATIVE): NO liveness-timeout / wedge machinery may appear. These
# strings belonged to the removed watchdog + killWedged path. Their ABSENCE
# during a long held round is the load-bearing signal of the new design.
if grep -qE "watchdog|declaring wedge|killing wedged claude-p|wedgeKill|deferring" "$BRIDGE_LOG"; then
	scn_fail "removed timeout/wedge machinery still active in the log (watchdog not fully removed?)"
else
	scn_pass "no watchdog / wedge / timeout machinery in the log — held round left alone by design"
fi

# Mechanical: the held tool round completed (the result was delivered back).
if grep -qE "tool-result delivery|mcp handler: bash .* early result|caching session=" "$BRIDGE_LOG"; then
	scn_pass "held round completed (tool result delivered + turn finalized)"
else
	scn_fail "held round did not complete (no tool-result delivery / no completion)"
fi

# COHERENCE: the tool's output must have reached the model end-to-end. If the
# held round had been killed, the bash result would never have reached the model
# and it could not echo the sentinel.
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
