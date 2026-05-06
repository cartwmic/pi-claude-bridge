#!/usr/bin/env bash
# Scenario S25 — Capture call during in-flight user turn.
#
# Validates that pi-ai.complete() with a capture tool (submit_digest) can run
# concurrently with a normal user turn that has a SlowTool mid-execution.
# The capture path is isolated from the agent loop: it must not abort, corrupt,
# or supersede the in-progress user turn; the user turn must complete normally;
# and the second user turn must warm-resume on the same CC session_id.
#
# Assertions:
#   A1. SlowTool is observed in "awaiting pi" state before /fire-capture fires.
#   A2. Capture call completes (runCaptureQuery: done in bridge log).
#   A3. Zero "superseding active frame" lines — capture did NOT abort user turn.
#   A4. Exactly ONE new caching session= line from turn 1 (capture does not mutate cachedSessionId).
#   A5. Turn 1 completes normally ("SlowTool completed" visible in pane).
#   A6. Turn 2 warm-resumes (streamSimple: fresh query ... resume=<session1-id>).
#   A7. Turn 2 produces its response token (coherence).
#
# Model: claude-bridge/claude-haiku-4-5

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s25"

trap 'scn_pi_stop' EXIT

# Load the bridge (via -e '$REPO_DIR' from scn_pi_start) plus two fixtures:
#   slow-tool-extension.ts — registers SlowTool so the model can invoke it
#   fire-capture-extension.ts — registers /fire-capture slash command
scn_pi_start \
	"-e $REPO_DIR/tests/fixtures/slow-tool-extension.ts -e $REPO_DIR/tests/fixtures/fire-capture-extension.ts"

# ─── Step 1: Send a prompt that triggers a long-running SlowTool turn ─────────
# Use --no-wait: we must NOT block here — we need to inject /fire-capture
# while SlowTool is still mid-execution (before caching session= appears).
pre_cache_count=$(scn_grep_count "caching session=" "$BRIDGE_LOG")

"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" -- \
	"Please call SlowTool with seconds=10, then tell me exactly what it returned."
"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" Enter

# ─── Wait for SlowTool to enter the "awaiting pi" state in the bridge ─────────
# The bridge logs "mcp handler: SlowTool [toolu_...] — awaiting pi" once the
# SDK has called our MCP handler and it's blocking on pi's tool result.
echo "  Waiting for SlowTool to reach awaiting-pi state..."
deadline=$((SECONDS + 60))
slowtool_waiting=0
while (( SECONDS < deadline )); do
	if grep -qE "mcp handler: SlowTool.*awaiting pi" "$BRIDGE_LOG" 2>/dev/null; then
		slowtool_waiting=1
		break
	fi
	sleep 0.5
done

# A1: SlowTool mid-execution confirmed.
if (( slowtool_waiting )); then
	scn_pass "A1: SlowTool mid-execution observed (mcp handler: SlowTool.*awaiting pi)"
else
	scn_fail "A1: SlowTool never entered awaiting-pi state — bridge log missing the 'mcp handler: SlowTool.*awaiting pi' line"
fi

# Give the tool handler a moment to settle in the blocked state.
sleep 0.5

# ─── Step 2: Trigger /fire-capture while SlowTool is still in flight ──────────
# Send the slash command directly via tmux (NOT via scn_send, which would wait
# for caching session= that the capture path intentionally never emits).
"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" -- "/fire-capture"
"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" Enter

# ─── Step 3: Wait for the capture call to complete ────────────────────────────
# Check the bridge log for "runCaptureQuery: done" — more reliable than waiting
# for the transient pi.ui.notify pane message (notify may vanish before the
# next capture-pane poll).
echo "  Waiting for capture call to complete..."
deadline=$((SECONDS + 60))
capture_done=0
while (( SECONDS < deadline )); do
	if grep -qE "runCaptureQuery: done" "$BRIDGE_LOG" 2>/dev/null; then
		capture_done=1
		break
	fi
	sleep 0.5
done

# A2: Capture completed.
if (( capture_done )); then
	scn_pass "A2: capture call completed (runCaptureQuery: done in bridge log)"
else
	scn_fail "A2: capture call did not complete within timeout (runCaptureQuery: done never appeared)"
fi

# A3: No supersession — user turn was NOT disturbed.
if grep -qE "streamSimple: superseding active frame" "$BRIDGE_LOG" 2>/dev/null; then
	scn_fail "A3: bridge log shows 'superseding active frame' — capture call wrongly aborted user turn"
else
	scn_pass "A3: no 'superseding active frame' — user turn not disturbed by capture call"
fi

# Also check pane for the notify (best-effort; may be transient).
"${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -2000 > "$PANE_LOG" 2>/dev/null || true
if grep -qE "\[Capture done\]" "$PANE_LOG"; then
	echo "  NOTE: [Capture done] notification visible in pane."
else
	echo "  NOTE: [Capture done] not visible in pane at this moment (may have been transient — bridge log is authoritative)."
fi

# ─── Step 4: Wait for the original user turn to complete ──────────────────────
# SlowTool.execute() returns "SlowTool completed after Nms". Pi renders tool
# output in the pane, and the model's final reply echoes it.
scn_wait_for "SlowTool completed" 30 || scn_fail "A5: original turn never showed 'SlowTool completed' in pane"
scn_pass "A5: original user turn completed normally (SlowTool result visible in pane)"

# Poll until caching session= count increments (turn 1 fully cached).
deadline=$((SECONDS + 30))
while (( SECONDS < deadline )); do
	cur=$(scn_grep_count "caching session=" "$BRIDGE_LOG")
	(( cur > pre_cache_count )) && break
	sleep 0.5
done
post_t1_cache_count=$(scn_grep_count "caching session=" "$BRIDGE_LOG")

# A4: Exactly ONE new caching session= line (from turn 1 only, not the capture call).
extra_cache=$((post_t1_cache_count - pre_cache_count))
if (( extra_cache == 1 )); then
	scn_pass "A4: exactly 1 new caching session= line — capture path did not mutate cachedSessionId"
elif (( extra_cache == 0 )); then
	scn_fail "A4: no caching session= line appeared — turn 1 may not have completed or bridge never cached"
else
	scn_fail "A4: expected 1 new caching session= line, got $extra_cache — capture call may have leaked a caching event"
fi

# Capture the session ID for warm-resume verification in step 5.
session_id=$(grep -oE "caching session=[a-f0-9]+" "$BRIDGE_LOG" | tail -1 | sed 's/caching session=//')
echo "  CC session_id after T1: $session_id"

# ─── Step 5: Second normal turn — verify warm-resume on the original session ──
scn_send "Reply with exactly the single token WARM-RESUME-S25 and nothing else."

# A6: Turn 2 resumed on the same session_id (no cold-start caused by capture call).
post_t2_resumes=0
if [[ -n "$session_id" ]]; then
	post_t2_resumes=$(scn_grep_count "streamSimple: fresh query.*resume=${session_id}" "$BRIDGE_LOG")
fi
echo "  warm-resume hits for session=${session_id}: $post_t2_resumes"

if (( post_t2_resumes >= 1 )); then
	scn_pass "A6: turn 2 warm-resumed on session=${session_id} (cachedSessionId preserved through capture call)"
else
	if [[ -z "$session_id" ]]; then
		scn_fail "A6: could not extract session_id from bridge log — cannot verify warm-resume"
	else
		scn_fail "A6: turn 2 did NOT warm-resume on session=${session_id} — capture call may have clobbered cachedSessionId"
	fi
fi

# A7: Coherence — response token must appear.
"${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -2000 > "$PANE_LOG"
if grep -q "WARM-RESUME-S25" "$PANE_LOG"; then
	scn_pass "A7: turn 2 produced response token WARM-RESUME-S25 (bridge still functional after concurrent capture)"
else
	scn_fail "A7: turn 2 never produced response token WARM-RESUME-S25"
fi

echo "==== S25 results ===="
echo "Cache profile:"
scn_cache_profile

echo ""
echo "Bridge log — capture-relevant lines:"
grep -E "mode.*capture|runCaptureQuery|mcp handler: SlowTool" "$BRIDGE_LOG" 2>/dev/null || echo "  (none found)"

echo ""
echo "Session counts:"
echo "  caching session= events: $(scn_session_count)"

echo "===================="
exit $SCN_FAILED
