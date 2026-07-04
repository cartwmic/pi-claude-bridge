#!/usr/bin/env bash
# Scenario S31 — /claude-peek live overlay (claude-peek-overlay capability).
#
# Regression class: peek overlay renders, live-updates during a streaming
# turn, never steals editor focus, toggles off cleanly, and mirroring never
# pollutes the turn (NDJSON/stream unaffected).
#
# ACs exercised end-to-end:
#   claude-peek-overlay.overlay-toggle-command
#   claude-peek-overlay.live-screen-during-main-provider-turn
#   claude-peek-overlay.explicit-idle-and-error-states (idle before first turn)
#   claude-p-fork.write-only-pty-output-mirror (turn output unaffected)
#
# Mechanical: overlay marker present/absent; live header during turn; mirror
# file exists and is non-empty; bridge log shows a completed cached turn.
# Coherence: arithmetic answer correct (positive) + no refusal (negative) —
# the prompt was typed and submitted WHILE the overlay was open, so a correct
# answer proves nonCapturing left the editor usable.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s31"

# Peek dir private to this scenario (also proves the env override).
export SCN_PEEK_DIR="$OUT_DIR/s31-peek"
rm -rf "$SCN_PEEK_DIR"
SCN_PI_ENV="CLAUDE_BRIDGE_PEEK_DIR='$SCN_PEEK_DIR'"
export SCN_PI_ENV

trap 'scn_pi_stop' EXIT

scn_pi_start

# ── Open the overlay (idle: no turn yet) ────────────────────────────────────
scn_send_keys -- '/claude-peek'
sleep 0.5
scn_send_keys Enter
sleep 1.5
if scn_capture | grep -q "claude-peek"; then
	scn_pass "overlay visible after /claude-peek"
else
	scn_fail "overlay marker not found after /claude-peek"
fi
if scn_capture | grep -q "idle (no active claude session)"; then
	scn_pass "explicit idle state before first turn"
else
	scn_fail "idle state header missing"
fi

# ── Submit a turn WHILE the overlay is open; watch it go live ───────────────
# No completion wait here: we need mid-turn captures.
scn_send --no-wait "What is 379*53? Think step by step out loud in detail, then end with just the number."
live_seen=0
deadline=$((SECONDS + 60))
while (( SECONDS < deadline )); do
	if scn_capture | grep -q "claude-peek — live"; then live_seen=1; break; fi
	sleep 0.5
done
if (( live_seen )); then
	scn_pass "overlay switched to live during the streaming turn"
else
	scn_fail "overlay never showed live state during the turn"
fi

# Mid-turn content advance: SIGNAL-based — poll up to 30s for the overlay
# region to change from its first live capture (a fixed 2s pair flaked when
# the model paused thinking under machine load), or for the turn to finish
# (advance check moot).
mid_a="$(scn_capture | grep -A 3 "claude-peek — live" || true)"
advanced=0
adv_deadline=$((SECONDS + 30))
while (( SECONDS < adv_deadline )); do
	mid_b="$(scn_capture | grep -A 3 "claude-peek — live" || true)"
	if [[ -n "$mid_a" && -n "$mid_b" && "$mid_a" != "$mid_b" ]]; then advanced=1; break; fi
	if scn_capture | grep -qE "20,?087"; then break; fi
	sleep 1
done
if (( advanced )); then
	scn_pass "overlay content advanced between mid-turn captures"
elif scn_capture | grep -qE "20,?087"; then
	scn_pass "turn finished before overlay content changed (advance check moot)"
else
	scn_fail "overlay content did not advance during the turn"
fi

# ── Completion + coherence (typed while overlay open → focus never stolen) ──
scn_wait_for "20,?087" 120 || true
pane="$(scn_capture)"
if echo "$pane" | grep -qE "20,?087"; then
	scn_pass "coherence: correct answer (prompt submitted while overlay open)"
else
	scn_fail "coherence: answer 20087 not found"
fi
if echo "$pane" | grep -qiE "cannot help|unable to answer|I can.t assist"; then
	scn_fail "coherence negative: refusal text present"
else
	scn_pass "coherence negative: no refusal"
fi

# ── Mirror file exists, non-empty, in the scenario peek dir ────────────────
if compgen -G "$SCN_PEEK_DIR/*.raw" > /dev/null; then
	sz=$(wc -c < "$(ls -t "$SCN_PEEK_DIR"/*.raw | head -1)" | tr -d ' ')
	if (( sz > 1000 )); then
		scn_pass "mirror file written under CLAUDE_BRIDGE_PEEK_DIR (${sz} bytes)"
	else
		scn_fail "mirror file suspiciously small (${sz} bytes)"
	fi
else
	scn_fail "no mirror file under $SCN_PEEK_DIR"
fi

# ── Turn unaffected by mirroring: bridge completed + cached the session ────
# finalize (which writes 'caching session=') lands a moment after the answer
# reaches the pane — wait on the LOG, not an instant grep.
if scn_wait_for_log "caching session=" 30; then
	scn_pass "bridge log shows completed turn (NDJSON stream unaffected)"
else
	scn_fail "no 'caching session=' in bridge log — turn did not complete cleanly"
fi

# ── Toggle off ──────────────────────────────────────────────────────────────
scn_send_keys -- '/claude-peek'
sleep 0.5
scn_send_keys Enter
sleep 1.5
if scn_capture | grep -q "claude-peek —"; then
	scn_fail "overlay still visible after toggle off"
else
	scn_pass "overlay removed on toggle off"
fi

exit $SCN_FAILED
