#!/usr/bin/env bash
# S30 — validated warm-resume across a pi RESTART (enable-warm-pi-resume).
#
# User story: I have a multi-turn claude-bridge session, I quit pi and restart it
# resuming the same session, and my next turn warm-resumes the prior `claude`
# driver session (--resume) instead of cold-packing the whole history — and the
# model still remembers the conversation.
#
# Regression class this catches that nothing else does: the END-TO-END cross-
# restart warm path. The unit/roundtrip tests prove the store+gate logic; this
# proves the real wiring — that a fresh pi PROCESS reloading a session via
# --session-id fires session_start (reason "startup"), arms warmResumePending,
# reads the keyed sidecar, validates, and spawns claude-p with --resume.
#
# Two-tier assertions:
#   mechanical — launch-2 bridge log shows `arming validated warm-resume` AND a
#                `fresh spawn ... resume=<hex>` (NOT resume=no); a sidecar file
#                exists after launch 1.
#   coherence  — launch-2 model answer contains the planted secret word (positive)
#                and NOT a "don't recall" phrase (negative regex).
#   RED check  — with the sidecar removed, launch-3 cold-starts (resume=no),
#                proving the sidecar (not something else) drove the warm path.
#
# Harness: NOT the shared scenario-lib (which hardcodes --no-session). Warm-resume
# REQUIRES session persistence, so this drives two/three sequential pi PROCESSES
# that share `--session-id <uuid> --session-dir <tmp>` on a private tmux server.
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL="${SCENARIO_MODEL:-claude-bridge/claude-haiku-4-5}"
SOCK="pcb-scn-s30-$$"
TMUX_CMD=(tmux -L "$SOCK")
SDIR="$(mktemp -d "${TMPDIR:-/tmp}/pcb-s30-sess-XXXXXX")"
RDIR="$(mktemp -d "${TMPDIR:-/tmp}/pcb-s30-resume-XXXXXX")"
# Logs live OUTSIDE the auto-cleaned dirs so a failed run is post-mortem-able.
LOGDIR="$REPO_DIR/.test-output/s30-$$"; mkdir -p "$LOGDIR"
SID="$(uuidgen | tr 'A-Z' 'a-z')"
WORD="quokka$(date +%s | tail -c 5)"
FAILED=0

cleanup() { "${TMUX_CMD[@]}" kill-server 2>/dev/null || true; rm -rf "$SDIR" "$RDIR" 2>/dev/null || true; }
trap cleanup EXIT

pass() { echo "  PASS: $*"; }
fail() { echo "  FAIL: $*"; FAILED=1; }

# Correct turn-count read: grep -c emits one line "0" on no match (exit 1), so the
# `| head -1 | tr -d` buffer yields "0" and `|| echo 0` never double-appends (the
# 0\n0 bad-math trap the scenario skill warns about).
turn_count() { grep -cE "caching session=" "$1" 2>/dev/null | head -1 | tr -d ' \n' || echo 0; }

launch() { # $1=bridgelog
	"${TMUX_CMD[@]}" new-session -d -s w -x 200 -y 50 \
		"cd '$REPO_DIR' && CLAUDE_BRIDGE_DEBUG=1 CLAUDE_BRIDGE_DEBUG_PATH='$1' CLAUDE_BRIDGE_RESUME_DIR='$RDIR' \
		 pi --session-id '$SID' --session-dir '$SDIR' -ne -e '$REPO_DIR/dist/index.js' \
		 --provider claude-bridge --model '$MODEL'"
	local deadline=$((SECONDS + 40))
	while (( SECONDS < deadline )); do
		"${TMUX_CMD[@]}" capture-pane -t w:0 -p -S -50 2>/dev/null | grep -qE "\(claude-bridge\)" && break
		sleep 0.5
	done
	sleep 1
}

# Send a prompt and wait for a SUCCESSFUL turn (a new "caching session=" line).
# The claude-p MCP shim handshake can lose the boot race under contention and the
# turn errors (McpNotReady, exhausted retries); that is transient, so RESEND the
# prompt up to 3 times until a success line appears. Returns 0 on success, 1 if
# all attempts errored/timed out.
send_wait() { # $1=bridgelog $2=text
	local attempt pre cur err start
	for attempt in 1 2 3; do
		pre="$(turn_count "$1")"; pre="${pre:-0}"
		"${TMUX_CMD[@]}" send-keys -t w:0 -- "$2"
		"${TMUX_CMD[@]}" send-keys -t w:0 Enter
		start=$SECONDS
		while (( SECONDS - start < 120 )); do
			cur="$(turn_count "$1")"; cur="${cur:-0}"
			if (( cur > pre )); then sleep 1; return 0; fi
			# turn errored (boot race) -> break to resend
			err="$(grep -cE "finalizeClaudePFrame: error" "$1" 2>/dev/null | head -1 | tr -d ' \n' || echo 0)"
			if (( ${err:-0} >= attempt )); then echo "  (attempt $attempt errored — resending)"; break; fi
			sleep 1
		done
	done
	echo "  WARN: send_wait exhausted attempts ('$2')"; return 1
}

stop() { "${TMUX_CMD[@]}" kill-server 2>/dev/null || true; sleep 1; }

B1="$LOGDIR/b1.log"; B2="$LOGDIR/b2.log"; B3="$LOGDIR/b3.log"

echo "==== S30 warm-resume (model=$MODEL word=$WORD) ===="

# --- Launch 1: establish the session, plant a secret word ---
launch "$B1"
send_wait "$B1" "Remember this secret word for later: $WORD. Just acknowledge with 'ok'."
stop

if compgen -G "$RDIR/*.json" >/dev/null; then
	pass "sidecar persisted after launch 1"
else
	fail "no sidecar written after a successful launch-1 turn (warm-resume cannot engage)"
fi

# --- Launch 2: fresh process, same session -> should WARM-resume ---
launch "$B2"
send_wait "$B2" "What is the secret word I told you to remember? Reply with ONLY that word."
PANE2="$("${TMUX_CMD[@]}" capture-pane -t w:0 -p -S -300 2>/dev/null)"
stop

grep -qE "arming validated warm-resume" "$B2" && pass "launch 2 armed warm-resume on session_start" \
	|| fail "launch 2 did not arm warm-resume (session_start reason not handled?)"

if grep -qE "fresh spawn .*resume=[a-f0-9]{6,}" "$B2"; then
	pass "launch 2 spawned claude-p with --resume=<id> (WARM, no cold re-pack)"
else
	fail "launch 2 cold-started (resume=no) — expected WARM"
	grep -oE "warm-resume not applicable.*|fresh spawn .*resume=[a-z0-9]+" "$B2" | head -3
fi

# Coherence: paired positive + negative (the negative guards "I don't recall WORD"
# satisfying a bare positive check for WORD).
if echo "$PANE2" | grep -qiE "$WORD"; then
	pass "coherence: model recalled the secret word across the restart"
else
	fail "coherence: model did NOT recall '$WORD' after warm resume"
fi
if echo "$PANE2" | grep -qiE "(don't|do not|cannot|can't|no) (recall|remember|have)"; then
	fail "coherence(negative): model disclaimed memory of the word"
else
	pass "coherence(negative): no memory-disclaimer in the answer"
fi

# --- RED check: remove the sidecar, restart again -> must COLD-start ---
rm -f "$RDIR"/*.json
launch "$B3"
send_wait "$B3" "Say hello."
stop
if grep -qE "fresh spawn .*resume=no" "$B3"; then
	pass "RED check: with the sidecar removed, the restart cold-started (sidecar drove the warm path)"
else
	fail "RED check: expected cold-start with no sidecar present"
fi

echo "===================="
echo "(bridge logs: $B1 $B2 $B3)"
[[ "$FAILED" -eq 0 ]] && echo "S30: PASS" || echo "S30: FAIL"
exit "$FAILED"
