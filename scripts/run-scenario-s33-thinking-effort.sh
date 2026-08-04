#!/usr/bin/env bash
# Scenario S33 — claude-print reasoning selection and visible thinking.
#
# Regression class: Pi's selected reasoning level reaches the direct Claude
# subprocess as --effort, Claude emits thinking, and Pi renders that thinking
# before the final answer instead of dropping or merging it.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

if [[ "$SCENARIO_DRIVER" != "claude-print" ]]; then
	echo "SKIP: S33 is a claude-print-only thinking visibility gate"
	exit 77
fi

SCN_FAILED=0
scn_setup "s33-thinking-effort"

# Isolate Pi settings so user-global hideThinkingBlock cannot make visible
# thinking assertions machine-dependent. Claude auth remains owned by Claude CLI.
export SCN_CLEANUP_DIR
SCN_CLEANUP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pi-bridge-s33.XXXXXX")"
printf '%s\n' '{"hideThinkingBlock":false}' > "$SCN_CLEANUP_DIR/settings.json"
SCN_PI_ENV="PI_CODING_AGENT_DIR='$SCN_CLEANUP_DIR'"
export SCN_PI_ENV

# Exercise provider metadata as well as runtime translation. The :high suffix
# must be accepted by Pi because bridge models advertise thinkingLevelMap.
SCENARIO_MODEL="${SCENARIO_MODEL%%:*}:high"
export SCENARIO_MODEL

trap 'scn_pi_stop' EXIT
scn_pi_start

if scn_capture | grep -qE '• high|thinking high'; then
	scn_pass "Pi selected high reasoning for bridge model"
else
	scn_fail "Pi footer did not expose selected high reasoning"
fi

prompt="Compute 37*43 carefully. Put calculation steps in your thinking block, then make your final answer exactly S33_FINAL_1591 with no other final-answer text. S33_PROMPT_END"
if ! scn_send "$prompt"; then
	scn_fail "reasoning turn did not complete through claude-print"
fi

scn_capture > /dev/null
response="$(scn_probe_response "S33_PROMPT_END")"
final_line="$(echo "$response" | grep -nE '^[[:space:]]*S33_FINAL_1591[[:space:]]*$' | tail -1 | cut -d: -f1 || true)"
if [[ "$final_line" =~ ^[0-9]+$ ]]; then
	scn_pass "coherence: exact arithmetic final answer rendered"
else
	scn_fail "coherence: exact final answer missing"
fi
if echo "$response" | grep -qiE 'cannot|unable|refus|no reasoning'; then
	scn_fail "coherence negative: refusal or missing-reasoning disclaimer present"
else
	scn_pass "coherence negative: no refusal"
fi

# Prompt asks for no answer prose. Any visible calculation before the exact
# final line, paired with driver-side thinking-start evidence below, proves Pi
# rendered the thinking block rather than only the final text block.
calculation_line="$(echo "$response" | grep -nE '(1,?480|111|37[^0-9]+43|40[^0-9]+3)' | head -1 | cut -d: -f1 || true)"
if [[ "$calculation_line" =~ ^[0-9]+$ && "$final_line" =~ ^[0-9]+$ ]] && (( calculation_line < final_line )); then
	scn_pass "TUI rendered calculation thinking before distinct final answer"
else
	scn_fail "visible calculation thinking/final answer ordering missing"
fi

if scn_wait_for_log 'streamSimple\[claude-print\]: fresh spawn model=.* effort=high ' 10; then
	scn_pass "driver evidence records selected Claude effort=high"
else
	scn_fail "driver log lacks effort=high spawn evidence"
fi
if scn_wait_for_log 'processDriverEvent: thinking started' 10; then
	scn_pass "driver stream delivered a thinking block"
else
	scn_fail "driver stream produced no thinking block"
fi
if scn_assert_selected_driver_spawn; then
	scn_pass "claude-print owned reasoning turn"
else
	scn_fail "claude-print did not own reasoning turn"
fi

exit "$SCN_FAILED"
