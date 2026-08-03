#!/usr/bin/env bash
# Scenario S31 — Large cold-start prompt accepted end-to-end.
# AC: scenario-coverage.large-cold-start-prompt-coverage
# AC: claude-p-driver.fixed-claude-p-fork-pin
# Regression class: either selected driver must submit an 801+ byte first
# prompt without truncation, early submission, or non-delivery.

set -euo pipefail

# Opus follows exact sentinel instructions more reliably, but callers may override.
: "${SCENARIO_MODEL:=claude-bridge/claude-opus-4-8}"
export SCENARIO_MODEL

source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s31-large-cold-start-prompt"

trap 'scn_pi_stop' EXIT

scn_pi_start

SENTINEL="S31_SENTINEL_$(date +%s)_$$"
PROMPT_MARKER="S31-FINAL-RESPONSE-RULE"

large_prompt=$(cat <<EOF2
S31 large cold start regression prompt. This is the first user message in a fresh pi --no-session process. It intentionally exceeds the Claude/Ink paste-collapse threshold proven by the prompt-not-accepted spike: prompts of 800 bytes passed, while prompts of 801 bytes and above failed before the fixed claude-p fork accepted the normalized paste marker. The unique sentinel token for this run is ${SENTINEL}. Treat this as a delivery audit, not a creative writing request. You need to demonstrate that the entire first prompt reached the model through the bridge, claude-p, and the interactive Claude TUI path. The bridge scenario will inspect the bridge log for the mechanical lifecycle, including a cold fresh spawn, a completed caching session, and absence of the named PromptNotAccepted failure. It will also inspect your answer for the sentinel and for absence of any disclaimer saying you did not receive or could not see the prompt. Additional padding keeps the prompt safely above the threshold without requiring tools: alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu. Repeat the audit context once more for byte safety: this first turn is deliberately large, it is cold-started, it contains one sentinel, and it expects a minimal exact reply so the scenario can distinguish real model delivery from a prompt that was dropped before inference. ${PROMPT_MARKER}: reply with exactly the sentinel token named in the audit block and nothing else.
EOF2
)
# Keep this as one submitted pi message; avoid embedded newlines becoming extra turns.
large_prompt=${large_prompt//$'\n'/ }
prompt_bytes=$(printf '%s' "$large_prompt" | wc -c | tr -d ' ')
echo "==== S31 large cold-start prompt (driver=$SCENARIO_DRIVER model=$SCENARIO_MODEL bytes=$prompt_bytes sentinel=$SENTINEL) ===="
if (( prompt_bytes <= 800 )); then
	scn_fail "setup: prompt is not above 800 bytes (bytes=$prompt_bytes)"
fi

scn_send "$large_prompt"
scn_capture > /dev/null

echo "==== S31 results ===="

pna_count=$(scn_grep_count "PromptNotAccepted" "$BRIDGE_LOG")
echo "  PromptNotAccepted count: $pna_count"
if [[ "$pna_count" == "0" ]]; then
	scn_pass "mechanical: no PromptNotAccepted in bridge log"
else
	scn_fail "mechanical: bridge log contains PromptNotAccepted"
fi

cold_count=$(scn_cold_count)
echo "  cold fresh-spawn count: $cold_count"
if (( cold_count >= 1 )); then
	scn_pass "mechanical: first turn used cold fresh spawn (resume=no)"
else
	scn_fail "mechanical: no cold fresh spawn observed"
fi

selected_count=$(scn_grep_count "streamSimple\\[${SCENARIO_DRIVER}\\]: fresh spawn" "$BRIDGE_LOG")
if (( selected_count >= 1 )); then
	scn_pass "mechanical: selected driver $SCENARIO_DRIVER owned the turn"
else
	scn_fail "mechanical: no selected-driver dispatch for $SCENARIO_DRIVER"
fi

completed_turns=$(scn_grep_count "caching session=" "$BRIDGE_LOG")
echo "  completed turn count: $completed_turns"
if (( completed_turns >= 1 )); then
	scn_pass "mechanical: cold-start turn completed and cached a session"
else
	scn_fail "mechanical: no completed turn / caching session observed"
fi

if grep -qE "stopReason=error|closed pi stream with error|driver.lifecycle.stateDump" "$BRIDGE_LOG" 2>/dev/null; then
	scn_fail "mechanical: bridge recorded an error path during S31"
else
	scn_pass "mechanical: no bridge error path recorded"
fi

# Coherence: the response after PROMPT_MARKER must contain the sentinel and no
# non-delivery disclaimer. The marker appears after the prompt's only sentinel,
# so scn_probe_response will not pass merely by seeing the user's prompt echo.
scn_assert_response \
	"$PROMPT_MARKER" \
	"$SENTINEL" \
	"(did not receive|didn't receive|do not see|don't see|cannot see|can't see|no prompt|empty prompt|unable to access|not provided)" \
	"coherence: large cold-start prompt reached the model"

echo "===================="
exit $SCN_FAILED
