#!/usr/bin/env bash
# Scenario S20 — Abort visibility and SDK-session fidelity (TDD guard).
#
# Captures three failure modes around user aborts:
#
#   FM1 (Case C — silent abort during tool execution):
#     Pi has dispatched a long-running tool. The SDK has emitted message_stop
#     with toolUse and we've nulled frame.currentPiStream. User presses
#     Escape. onAbort runs but currentPiStream is null, so the bridge
#     never pushes an error/aborted event to pi's outer stream. Pi's TUI
#     sees nothing from us — silent abort.
#
#   FM2 (Case 2 — orphan tool-result reported as success):
#     If pi's tool finishes AFTER the abort and pi delivers the result,
#     streamSimple's "no active frame" path emits { type: "done", reason:
#     "stop" } — pi's TUI sees a normal completion event for an aborted
#     turn. Doubly silent.
#
#   FM3 (SDK transcript fidelity):
#     The MCP-handler resolver returns content "Operation aborted" with
#     isError=true on abort. The SDK records this as a tool_result. On
#     resume the model reads it. The text is ambiguous — could be read
#     as a tool failure rather than a user-initiated interrupt.
#
# Detection:
#   - Bridge instrumentation logs (added by the fix) record where each
#     error/aborted push happens. S20 asserts those exist.
#   - Coherence probe: the model's next-turn answer must reference user
#     interruption (not "the tool returned an error").

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s20"

trap 'scn_pi_stop' EXIT
scn_pi_start

# ---- Phase 1: dispatch a long-running tool, abort mid-execution -------------
# Use a sentinel that MUST NOT appear in the bridge or coherence response.
tmux send-keys -t "$SESSION:0" -- "Run this exact bash command: 'sleep 60 && echo S20-MUST-NOT-PRINT'"
tmux send-keys -t "$SESSION:0" Enter

# Poll bridge log until pi is mid-tool-execution: we wait for a
# `mcp handler: bash [...] — awaiting pi` line, which fires only when
# the SDK has called the MCP handler and we're blocked on pi delivering
# the tool result. That's exactly the window where currentPiStream is null
# and abort would otherwise be silent.
deadline=$((SECONDS + 30))
mid_tool=0
while (( SECONDS < deadline )); do
	if grep -q "mcp handler: bash .* awaiting pi" "$BRIDGE_LOG" 2>/dev/null; then
		mid_tool=1
		break
	fi
	sleep 0.5
done
(( mid_tool == 1 )) || { scn_fail "could not enter mid-tool-execution window (test setup failure)"; exit $SCN_FAILED; }

# A breath of sleep so abort lands FIRMLY in the silent window.
sleep 2
tmux send-keys -t "$SESSION:0" Escape
sleep 4

# ---- Phase 2: coherence probe ----------------------------------------------
scn_send "Did the sleep command actually complete and print anything? Be specific: was it interrupted by me, or did it fail with an error, or did it print something?"

echo "==== S20 results ===="

# Architectural: bridge observed onAbort
if grep -q "onAbort:" "$BRIDGE_LOG"; then
	scn_pass "bridge onAbort fired"
else
	scn_fail "no onAbort in bridge log"
fi

# FM1 — Case C must produce an explicit error/aborted push to pi's stream.
# The fix instruments this with the canonical message
# `pushAbortedError: pi was awaiting tool result, surfacing aborted to pi stream`.
if grep -q "pushAbortedError: pi was awaiting tool result" "$BRIDGE_LOG"; then
	scn_pass "FM1: aborted error pushed to pi stream during tool-execution window (Case C)"
else
	scn_fail "FM1: silent abort — bridge never pushed error/aborted to pi while pi was awaiting tool result"
fi

# FM2 — Case 2 (orphan tool result post-abort) must NOT report success.
# Two possibilities:
#   (a) pi cancelled the bash and never delivered a tool result → no orphan
#       path was hit, so this assertion is N/A and we skip it.
#   (b) pi delivered a delayed tool result → bridge must emit
#       `pushAbortedError: orphan tool result post-abort` instead of done/stop.
orphan_warn=$(grep -c "orphaned tool result, no active query" "$BRIDGE_LOG" 2>/dev/null || true)
orphan_warn=${orphan_warn:-0}
if (( orphan_warn > 0 )); then
	if grep -q "pushAbortedError: orphan tool result post-abort" "$BRIDGE_LOG"; then
		scn_pass "FM2: orphan tool result reported as aborted (not done/stop)"
	else
		scn_fail "FM2: orphan tool result reported as success (would emit phantom done/stop on pi)"
	fi
else
	echo "  FM2: orphan path not hit this run (pi cancelled tool cleanly) — assertion skipped"
fi

# FM3 — SDK-session fidelity: the resolver content fed back to the SDK on
# abort must clearly attribute the interruption to the user. Under Option H,
# the synthetic drain only fires when pi DOESN'T deliver a real tool_result
# (Case 3 supersede or clearSession). When pi DOES deliver one (typical
# single-level abort like S20's bash sleep), the resolver gets the real
# tool_result and the synthetic text is never written. So FM3 is satisfied
# if EITHER:
#   (a) the synthetic 'interrupted by user' text was used (drained via
#       supersede), OR
#   (b) the resolver got a real tool_result (Case 1 / orphan-frame
#       lookup) with isError=true — the SDK's session JSONL records pi's
#       authentic abort-related text instead of our synthetic.
real_delivery_to_aborted=$(grep -c "tool-result delivery to aborted frame" "$BRIDGE_LOG" 2>/dev/null || true)
real_delivery_to_aborted=${real_delivery_to_aborted:-0}
if grep -q "interrupted by user" "$BRIDGE_LOG"; then
	scn_pass "FM3 (a): synthetic drain used canonical 'interrupted by user' text"
elif (( real_delivery_to_aborted > 0 )); then
	scn_pass "FM3 (b): resolver received a real post-abort tool_result (pi's authentic content, not synthetic)"
else
	scn_fail "FM3: neither synthetic drain nor real-result-to-aborted-frame fired"
fi

# No fabricated tool output — sentinel must NOT appear anywhere.
if grep -q "S20-MUST-NOT-PRINT" "$BRIDGE_LOG" 2>/dev/null; then
	scn_fail "tool sentinel leaked into bridge log (tool actually completed)"
else
	scn_pass "no fabricated tool output (sentinel absent)"
fi

# COHERENCE: model must affirm the abort, not claim a tool failure or success.
scn_assert_response \
	"Did the sleep command actually complete and print anything" \
	"(interrupted|aborted|cancel|stopped|did not (complete|finish|run)|never (printed|completed|finished)|you (interrupted|stopped|cancel))" \
	"(yes.*(completed|printed)|the command (completed|printed|succeeded)|tool (failed|errored|returned an error)|exit code [0-9]+)" \
	"coherence: model attributes the stop to user interruption, not tool failure or completion"

# No legacy abort surgery
if grep -qE "(UUID rotation|pendingTruncate|truncating)" "$BRIDGE_LOG"; then
	scn_fail "legacy abort-surgery detected"
else
	scn_pass "no UUID rotation / no JSONL surgery"
fi

echo "Cache profile:"
scn_cache_profile

echo "===================="
exit $SCN_FAILED
