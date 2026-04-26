#!/usr/bin/env bash
# scenario-lib.sh — shared helpers for tmux-driven pi scenario validation.
# Source from any scenario script: `source "$(dirname "$0")/scenario-lib.sh"`.
#
# Conventions:
#   - tmux session name is exported as $SESSION
#   - tmux pane is always 0 (single-pane sessions)
#   - bridge debug log is piped to .test-output/scenarios/<scenario>.bridge.log
#   - pane captures go to .test-output/scenarios/<scenario>.pane.log
#
# Reads from environment (with sensible defaults):
#   SCENARIO_MODEL  default: claude-bridge/claude-haiku-4-5
#   SCENARIO_CWD    default: $(pwd)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="$REPO_DIR/.test-output/scenarios"
mkdir -p "$OUT_DIR"

: "${SCENARIO_MODEL:=claude-bridge/claude-haiku-4-5}"
: "${SCENARIO_CWD:=$REPO_DIR}"

# Pi's interrupt key is Escape, not Ctrl-C. (See SCENARIOS.md.)
PI_INTERRUPT_KEY="Escape"

scn_setup() {
	local name="$1"
	export SESSION="pi-bridge-${name}-$$"
	export BRIDGE_LOG="$OUT_DIR/${name}.bridge.log"
	export PANE_LOG="$OUT_DIR/${name}.pane.log"
	rm -f "$BRIDGE_LOG" "$PANE_LOG"
	export CLAUDE_BRIDGE_DEBUG=1
	export CLAUDE_BRIDGE_DEBUG_PATH="$BRIDGE_LOG"
}

scn_pi_start() {
	# Start pi in a fresh tmux session. Background; returns immediately.
	local extra_args=""
	if (( $# > 0 )); then extra_args="$*"; fi
	# -ne disables auto-discovered extensions; -e loads ONLY our local copy.
	# Without -ne, pi would also load the installed copy at
	# ~/.pi/agent/git/github.com/cartwmic/pi-claude-bridge/, and the symbol
	# guard means the installed (legacy) one would win.
	tmux new-session -d -s "$SESSION" -x 200 -y 50 \
		"cd '$SCENARIO_CWD' && CLAUDE_BRIDGE_DEBUG=1 CLAUDE_BRIDGE_DEBUG_PATH='$BRIDGE_LOG' \
		 pi --no-session -ne -e '$REPO_DIR' --provider claude-bridge --model '$SCENARIO_MODEL' $extra_args"
	# Give pi time to render its prompt
	sleep 3
}

scn_pi_stop() {
	tmux kill-session -t "$SESSION" 2>/dev/null || true
}

scn_send() {
	# scn_send "<text>"
	# Sends text + Enter, then waits for the bridge to finish processing this
	# turn. "Finish" = a new "caching session=" line appears in the bridge
	# log (one per completed query() call). Falls back to wall-clock timeout.
	#
	# Pass --no-wait as the first arg to skip the wait (e.g. for steering).
	local wait_for_completion=1
	if [[ "${1:-}" == "--no-wait" ]]; then wait_for_completion=0; shift; fi

	local pre_count=0
	if [[ -f "$BRIDGE_LOG" ]]; then
		pre_count=$(grep -cE "caching session=" "$BRIDGE_LOG" 2>/dev/null | head -1 | tr -d ' \n' || echo 0)
		pre_count=${pre_count:-0}
	fi

	tmux send-keys -t "$SESSION:0" -- "$1"
	tmux send-keys -t "$SESSION:0" Enter

	if (( wait_for_completion )); then
		local timeout=120
		local start=$SECONDS
		while (( SECONDS - start < timeout )); do
			local cur=0
			if [[ -f "$BRIDGE_LOG" ]]; then
				cur=$(grep -cE "caching session=" "$BRIDGE_LOG" 2>/dev/null | head -1 | tr -d ' \n' || echo 0)
				cur=${cur:-0}
			fi
			if (( cur > pre_count )); then
				sleep 0.5
				return 0
			fi
			sleep 0.5
		done
		echo "WARN: scn_send timed out waiting for turn completion ('$1')" >&2
	fi
}

scn_send_keys() {
	# scn_send_keys Escape   (pass tmux key names, no Enter appended)
	tmux send-keys -t "$SESSION:0" "$@"
}

scn_capture() {
	# Save the entire scrollback to PANE_LOG, then stream to stdout.
	tmux capture-pane -t "$SESSION:0" -p -S -2000 > "$PANE_LOG"
	cat "$PANE_LOG"
}

scn_wait_for() {
	# scn_wait_for "regex" timeout_seconds
	# Polls capture-pane until regex matches OR timeout.
	local pat="$1"
	local timeout="${2:-30}"
	local start=$SECONDS
	while ((SECONDS - start < timeout)); do
		tmux capture-pane -t "$SESSION:0" -p -S -2000 > "$PANE_LOG" 2>/dev/null || true
		if grep -qE "$pat" "$PANE_LOG"; then return 0; fi
		sleep 0.5
	done
	echo "TIMEOUT waiting for: $pat" >&2
	return 1
}

# Bridge log helpers — extract cache stats per turn from the debug log.
scn_cache_profile() {
	# Print the (creation, read) tuple per usage line in the bridge log.
	# Last usage entry per turn is the "final" usage (post-stream completion).
	grep -E "^\[.*\] usage:" "$BRIDGE_LOG" | awk '{
		for (i = 1; i <= NF; i++) {
			if ($i ~ /^cacheRead=/) { gsub(/^cacheRead=/, "", $i); read = $i }
			if ($i ~ /^cacheWrite=/) { gsub(/^cacheWrite=/, "", $i); write = $i }
		}
		printf "  creation=%s read=%s\n", write, read
	}'
}

scn_session_count() {
	# How many distinct CC session_ids did the bridge cache during this run?
	grep -oE "caching session=[a-f0-9]+" "$BRIDGE_LOG" | sort -u | wc -l | tr -d ' '
}

scn_pass() { echo "  PASS: $1"; }
scn_fail() { echo "  FAIL: $1"; SCN_FAILED=1; }

# Each scenario script begins with `SCN_FAILED=0` and ends with
# `exit $SCN_FAILED`. scn_pass/scn_fail collect into that.
