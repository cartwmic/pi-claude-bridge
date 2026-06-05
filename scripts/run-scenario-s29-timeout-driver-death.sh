#!/usr/bin/env bash
# Scenario S29 — claude-p dying MID-HELD-TOOL surfaces an error, never a hang
# (Layer 1 of the hung-turn fix), and pi recovers.
#
# THE BUG: when claude-p errored/exited (e.g. its own --timeout firing) WHILE pi
# was running a held tool, the bridge swallowed the error (currentPiStream was
# null) and the tool-result that pi delivered afterward was wired into the dead
# frame → pi hung forever on a spinner. The fix: finalizeClaudePFrame marks the
# frame `driverErrored`, and the tool-result delivery path closes pi's stream
# with a terminal ERROR instead of wiring into a corpse.
#
# This scenario forces the exact race deterministically: set claude-p's own
# --timeout SHORT (18s) and run a real bash tool that sleeps LONGER (25s). The
# tool parks (~boot+a few s, well under 18s), claude-p's --timeout fires while
# the tool is still held, then pi delivers the late result. Expectations:
#   - the bridge logs the error finalize + the errored-frame delivery close,
#   - pi shows an error (not a successful sleep, not a hang),
#   - pi RECOVERS: a follow-up turn completes (the real no-hang proof).
#
# Tier: submit + log assertions + recovery coherence probe.

set -euo pipefail

# Pin opus for reliable tool invocation (see s20 rationale). Respect override.
export SCENARIO_MODEL="${SCENARIO_MODEL:-claude-bridge/claude-opus-4-7}"

# Layer 2 knob: a SHORT claude-p --timeout so it fires while the bash tool is
# still held. (Leave the watchdog at its default 180s so it does NOT interfere —
# this scenario is specifically about claude-p's OWN --timeout, the backstop.)
export SCN_PI_ENV="CLAUDE_BRIDGE_CLAUDE_P_TIMEOUT_SECONDS=18"

source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
SENTINEL="DRIVERDEATH-LEAK-Q8"
scn_setup "s29-timeout-driver-death"

trap 'scn_pi_stop' EXIT
scn_pi_start

# ---- Phase 1: park a long bash tool, let claude-p's --timeout kill it --------
# Send WITHOUT waiting for "caching session=" — this turn ERRORS, so that
# completion signal never appears. We poll for the Layer 1 markers instead.
"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" -- "As your very first action, immediately invoke the bash tool to run exactly: sleep 25 && echo $SENTINEL. Do not write any text before calling the tool."
"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" Enter

# Confirm the tool actually parked (the held round opened) before --timeout.
if scn_wait_for_log "onRouterPark: routed tools/call|mcp handler: bash" 30; then
	scn_pass "bash tool parked — held round opened before --timeout"
else
	scn_fail "bash never parked (model narrated, or boot too slow) — cannot test the mid-held-tool death"
fi

# Wait for claude-p's --timeout to fire mid-held-tool: finalize must hit its
# error branch (clears the cached session). Deadline > --timeout(18s) + margin.
if scn_wait_for_log "finalizeClaudePFrame: error|error — cleared cached session" 40; then
	scn_pass "claude-p --timeout fired mid-held-tool → finalize error branch"
else
	scn_fail "claude-p did not error within the window (did --timeout fire?)"
fi

# THE LAYER 1 ASSERTION: the late tool-result delivered into the dead frame must
# CLOSE pi's stream with an error — not wire into a corpse and hang. Deadline >
# the bash sleep (25s) so pi has delivered the late result. Wait up to 45s.
if scn_wait_for_log "tool-result delivery to errored frame|closed pi stream with error" 45; then
	scn_pass "LAYER 1: late tool-result into the dead frame closed pi's stream with an ERROR (no hang)"
else
	scn_fail "LAYER 1 REGRESSION: no errored-frame delivery close — pi likely hung on the late tool result"
fi

# Negative: the sleep must NOT be reported as a successful completion. claude-p
# died before it could use the result, so the sentinel must not surface as a
# successful tool output in pi's response.
sleep 3
"${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -3000 > "$PANE_LOG" 2>/dev/null || true
if grep -qiE "error|interrupted|failed|exited|did not (complete|finish)" "$PANE_LOG"; then
	scn_pass "pane shows an error/non-completion for the turn (not a phantom success)"
else
	scn_fail "pane shows no error indication after a driver death (possible silent hang or phantom success)"
fi

# ---- Phase 2: RECOVERY — the real no-hang proof -----------------------------
# After the error, pi must be idle and able to take another turn. If pi had hung
# on a spinner, this follow-up would never complete.
RECOVER="PONG-RECOVER-5T"
scn_send "Reply with exactly this token and nothing else: $RECOVER"
scn_assert_response \
	"Reply with exactly this token" \
	"$RECOVER" \
	"(spinner|still (working|running)|no response)" \
	"recovery: pi accepted and completed a new turn after the driver-death error (it did NOT hang)"

echo "Cache profile:"
scn_cache_profile
echo "===================="
exit $SCN_FAILED
