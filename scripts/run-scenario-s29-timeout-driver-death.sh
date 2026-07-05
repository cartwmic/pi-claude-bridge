#!/usr/bin/env bash
# Scenario S29 — a disruption MID-HELD-TOOL surfaces an error, never a hang, and
# pi recovers (Layer 1 of the hung-turn fix), under the caller-driven-kill model.
#
# DESIGN (current): claude-p has NO --timeout and the bridge has NO watchdog, so
# the only thing that ends a wedged/held turn is a CALLER-DRIVEN abort. The
# Layer-1 protection must still hold: when the driver goes away mid-held-tool
# (here: the user aborts with Escape → the bridge SIGINT→grace→SIGKILLs the
# claude-p process GROUP), the late tool-result pi delivers afterward must CLOSE
# pi's stream with a terminal error/abort instead of wiring into a corpse and
# hanging on a spinner. Then pi must RECOVER on the next turn.
#
# (Previously this forced claude-p's own --timeout to fire mid-tool; that knob
# was removed with the no-liveness-timeouts change. The abort path is the
# faithful current trigger for "driver death mid-held-tool".)
#
# Tier: submit + abort + log assertions + recovery coherence probe.

set -euo pipefail

# Pin opus for reliable tool invocation (see s20 rationale). Respect override.
export SCENARIO_MODEL="${SCENARIO_MODEL:-claude-bridge/claude-opus-4-7}"

source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
SENTINEL="DRIVERDEATH-LEAK-Q8"
scn_setup "s29-timeout-driver-death"

trap 'scn_pi_stop' EXIT
scn_pi_start

# ---- Phase 1: park a long bash tool, then ABORT mid-held-tool ----------------
# Send WITHOUT waiting for "caching session=" — this turn is aborted, so that
# completion signal never appears. We poll for the Layer 1 markers instead.
"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" -- "As your very first action, immediately invoke the bash tool to run exactly: sleep 25 && echo $SENTINEL. Do not write any text before calling the tool."
"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" Enter

# Confirm the tool actually parked (the held round opened) before we abort.
if scn_wait_for_log "onRouterPark: routed tools/call|mcp handler: bash" 30; then
	scn_pass "bash tool parked — held round opened"
else
	scn_fail "bash never parked (model narrated, or boot too slow) — cannot test the mid-held-tool disruption"
fi

# Abort the turn WHILE the tool is still held (sleep 25 is well underway).
sleep 3
"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" Escape

# The abort must SIGKILL the claude-p process GROUP (caller-driven kill).
if scn_wait_for_log "SIGINT to the process group|SIGKILL|aborting claude-p|abort" 20; then
	scn_pass "abort propagated: claude-p group signalled (caller-driven kill)"
else
	scn_fail "no abort/group-kill logged after Escape — abort path not wired"
fi

# THE LAYER 1 ASSERTION: the frame is errored/aborted and the late tool-result
# delivered into the dead frame must CLOSE pi's stream (terminal error/aborted)
# — not wire into a corpse and hang. Deadline > the bash sleep (25s).
if scn_wait_for_log "errored frame|aborted frame|closed pi stream|finalizeClaudePFrame: (error|aborted)|driverErrored" 45; then
	scn_pass "LAYER 1: dead/aborted frame closed pi's stream terminally (no hang)"
else
	scn_fail "LAYER 1 REGRESSION: no errored/aborted-frame close — pi likely hung on the late tool result"
fi

# Negative: the sleep must NOT be reported as a successful completion.
sleep 3
"${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -3000 > "$PANE_LOG" 2>/dev/null || true
if grep -qiE "error|interrupted|aborted|stopped|failed|did not (complete|finish)" "$PANE_LOG"; then
	scn_pass "pane shows an interrupted/error indication for the turn (not a phantom success)"
else
	scn_fail "pane shows no interruption indication after the abort (possible silent hang or phantom success)"
fi

# ---- Phase 2: RECOVERY — the real no-hang proof -----------------------------
# After the abort, pi must be idle and able to take another turn. If pi had hung
# on a spinner, this follow-up would never complete.
RECOVER="PONG-RECOVER-5T"
scn_send "Reply with exactly this token and nothing else: $RECOVER"
scn_assert_response \
	"Reply with exactly this token" \
	"$RECOVER" \
	"(spinner|still (working|running)|no response)" \
	"recovery: pi accepted and completed a new turn after the mid-tool abort (it did NOT hang)"

echo "Cache profile:"
scn_cache_profile
echo "===================="
exit $SCN_FAILED
