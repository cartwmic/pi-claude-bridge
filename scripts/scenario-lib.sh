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
: "${SCENARIO_DRIVER:=${CLAUDE_BRIDGE_DRIVER:-claude-p}}"
case "$SCENARIO_DRIVER" in
	claude-p|claude-print) ;;
	*) echo "ERROR: unsupported SCENARIO_DRIVER=$SCENARIO_DRIVER" >&2; exit 2 ;;
esac
export CLAUDE_BRIDGE_DRIVER="$SCENARIO_DRIVER"

# Pi's interrupt key is Escape, not Ctrl-C. (See SCENARIOS.md.)
PI_INTERRUPT_KEY="Escape"

# ─── Private tmux server (parallel-safe) ─────────────────────────────────────
# Every scenario runs against its own tmux server (selected via `tmux -L`).
# This makes scenarios independent: kill-server in one cannot affect another,
# stray pi processes from one cannot poison another, and parallel runs
# trivially don't collide. The socket is namespaced by PID so concurrent
# scripts each get a unique one.
: "${SCN_TMUX_SOCKET:=pi-scn-$$}"
TMUX_CMD=(tmux -L "$SCN_TMUX_SOCKET")

scn_setup() {
	local name="$1"
	local qualified="${SCENARIO_DRIVER}.${name}"
	# tmux canonicalizes dots in session names to underscores, making later
	# exact-target commands fail. Keep dots only in evidence filenames.
	export SESSION="pi-bridge-${SCENARIO_DRIVER}-${name}-$$"
	export BRIDGE_LOG="$OUT_DIR/${qualified}.bridge.log"
	export PANE_LOG="$OUT_DIR/${qualified}.pane.log"
	rm -f "$BRIDGE_LOG" "$PANE_LOG"
	export CLAUDE_BRIDGE_DEBUG=1
	export CLAUDE_BRIDGE_DEBUG_PATH="$BRIDGE_LOG"
}

scn_pi_start() {
	# Start pi in a fresh tmux session. Background; returns when pi is ready.
	#
	# Readiness: poll the pane until pi has rendered its bottom status line
	# `(claude-bridge) <model>` rather than a fixed `sleep 3`. A fixed sleep
	# loses keystrokes when pi's startup is slow (tmux contention, opus
	# boot) — the tmux session exists but pi's input isn't focused yet, so
	# `tmux send-keys` fires into the void and the test silently hangs.
	# Symptom: bridge log only shows "provider: registered" with no fresh
	# query line.
	local extra_args=""
	if (( $# > 0 )); then extra_args="$*"; fi
	# SCN_PI_ENV: optional extra `KEY=val KEY=val` env a scenario wants in pi's
	# process (e.g. CLAUDE_BRIDGE_WATCHDOG_IDLE_MS, CLAUDE_BRIDGE_CLAUDE_P_TIMEOUT_SECONDS
	# for the timeout scenarios). Spliced in just before `pi` so it overrides nothing
	# the lib sets and is visible to the bridge running inside pi.
	local pi_env="${SCN_PI_ENV:-}"
	# -ne disables auto-discovered extensions; -e loads ONLY our local copy.
	# Without -ne, pi would also load the installed copy at
	# ~/.pi/agent/git/github.com/cartwmic/pi-claude-bridge/, and the symbol
	# guard means the installed (legacy) one would win.
	"${TMUX_CMD[@]}" new-session -d -s "$SESSION" -x 200 -y 50 \
		"cd '$SCENARIO_CWD' && CLAUDE_BRIDGE_DEBUG=1 CLAUDE_BRIDGE_DEBUG_PATH='$BRIDGE_LOG' \
		 $pi_env PATH='$PATH' pi --no-session -ne -e '$REPO_DIR' --provider claude-bridge --model '$SCENARIO_MODEL' $extra_args"

	scn_wait_ready
}

scn_wait_ready() {
	# Wait until custom or shared Pi startup has rendered bridge status and input
	# focus is stable. Custom scenario launchers must call this before scn_send.
	local timeout="${1:-30}"
	local deadline=$((SECONDS + timeout))
	while (( SECONDS < deadline )); do
		if ! "${TMUX_CMD[@]}" has-session -t "$SESSION" 2>/dev/null; then
			echo "FAIL: pi exited before scenario startup completed" >&2
			return 1
		fi
		if "${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -50 2>/dev/null | grep -qE "\(claude-bridge\)"; then
			# Settle draw loop after ready marker appears.
			sleep 1
			return 0
		fi
		sleep 0.5
	done
	"${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -100 >&2 2>/dev/null || true
	echo "FAIL: pi scenario startup timed out waiting for claude-bridge status" >&2
	return 1
}

scn_descendant_pids() {
	# Snapshot descendants before tmux removes their parent. Driver subprocesses
	# create independent process groups, so killing tmux alone can orphan them.
	local parent="$1" child
	while read -r child; do
		[[ -n "$child" ]] || continue
		scn_descendant_pids "$child"
	done < <(pgrep -P "$parent" 2>/dev/null || true)
	printf '%s\n' "$parent"
}

scn_pi_stop() {
	# Runs as every scenario's `trap 'scn_pi_stop' EXIT` handler, so $? here is
	# the scenario's pending exit code (from its final `exit $SCN_FAILED`).
	local rc=$?

	# Capture the final pane for post-mortem/debugging. NOTE: claude-p is a faithful
	# model completion endpoint — if the model emits tool-call markup as TEXT, that
	# is the model's REAL output and is passed through verbatim (not a bridge bug),
	# so we do NOT fail a scenario merely for markup appearing in the response.
	# Tool-calling FAILURES are caught where they matter: tool scenarios assert a
	# real round-trip (onRouterPark + tool-result delivery in the bridge log), which
	# fails when no structured tool actually routed that turn.
	"${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -3000 > "$PANE_LOG" 2>/dev/null || true

	# Snapshot pane process tree before tmux removes its parent. Both drivers use
	# detached process groups; tmux kill-server alone does not reap those groups.
	# PID-scoped cleanup avoids broad pkill and cannot touch parallel siblings.
	local pane_pid="" descendants=""
	pane_pid=$("${TMUX_CMD[@]}" display-message -p -t "$SESSION:0" '#{pane_pid}' 2>/dev/null || true)
	if [[ "$pane_pid" =~ ^[0-9]+$ ]]; then
		descendants=$(scn_descendant_pids "$pane_pid")
		if [[ -n "$descendants" ]]; then
			# shellcheck disable=SC2086 # intentional PID word splitting
			kill -TERM $descendants 2>/dev/null || true
		fi
	fi
	"${TMUX_CMD[@]}" kill-server 2>/dev/null || true
	if [[ -n "$descendants" ]]; then
		sleep 0.5
		local pid
		while read -r pid; do
			[[ "$pid" =~ ^[0-9]+$ ]] || continue
			kill -KILL "$pid" 2>/dev/null || true
		done <<< "$descendants"
	fi

	# Scenario-specific temporary fixture cleanup. Keep this inside the shared
	# trap so cleanup commands cannot overwrite the scenario's pending status.
	if [[ -n "${SCN_CLEANUP_DIR:-}" ]]; then
		rm -rf -- "$SCN_CLEANUP_DIR"
	fi

	# Preserve pending scenario status after cleanup. (When rc
	# is already non-zero from a real assertion, this is a no-op re-assertion;
	# when the scenario otherwise passed but leaked, this flips it to FAIL.)
	if [[ "$rc" -ne 0 ]]; then exit "$rc"; fi
}

# Cross-scenario isolation. Kept for explicit use in scripts that want to
# ensure their private server is fresh. NEVER use broad `pkill -f
# "pi --no-session"`: it would kill parallel scenarios sharing user.
scn_clean_state() {
	"${TMUX_CMD[@]}" kill-server 2>/dev/null || true
}

scn_assert_selected_driver_spawn() {
	local pattern="streamSimple\\[${SCENARIO_DRIVER}\\]: fresh spawn"
	if [[ -f "$BRIDGE_LOG" ]] && grep -qE "$pattern" "$BRIDGE_LOG" 2>/dev/null; then
		return 0
	fi
	echo "FAIL: requested driver $SCENARIO_DRIVER did not own any observed spawn" >&2
	return 1
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

	"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" -- "$1"
	"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" Enter

	if (( wait_for_completion )); then
		local timeout="${SCENARIO_SEND_TIMEOUT:-120}"
		local start=$SECONDS
		while (( SECONDS - start < timeout )); do
			local cur=0
			if [[ -f "$BRIDGE_LOG" ]]; then
				cur=$(grep -cE "caching session=" "$BRIDGE_LOG" 2>/dev/null | head -1 | tr -d ' \n' || echo 0)
				cur=${cur:-0}
			fi
			if (( cur > pre_count )); then
				sleep 0.5
				scn_assert_selected_driver_spawn
				return $?
			fi
			sleep 0.5
		done
		echo "FAIL: scn_send timed out waiting for turn completion ('$1')" >&2
		return 1
	fi
}

scn_send_keys() {
	# scn_send_keys Escape   (pass tmux key names, no Enter appended)
	"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" "$@"
}

scn_capture() {
	# Save the entire scrollback to PANE_LOG, then stream to stdout.
	"${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -2000 > "$PANE_LOG"
	cat "$PANE_LOG"
}

scn_wait_for() {
	# scn_wait_for "regex" timeout_seconds
	# Polls capture-pane until regex matches OR timeout.
	local pat="$1"
	local timeout="${2:-30}"
	local start=$SECONDS
	while ((SECONDS - start < timeout)); do
		"${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -2000 > "$PANE_LOG" 2>/dev/null || true
		if grep -qE "$pat" "$PANE_LOG"; then return 0; fi
		sleep 0.5
	done
	echo "TIMEOUT waiting for: $pat" >&2
	return 1
}

scn_wait_for_log() {
	# scn_wait_for_log "regex" timeout_seconds
	# Polls the BRIDGE debug log until regex matches OR timeout. Use for
	# completion/error signals that never reach the pane (e.g. an errored turn
	# that emits no "caching session=" line). Returns 0 on match, 1 on timeout.
	local pat="$1"
	local timeout="${2:-30}"
	local start=$SECONDS
	while ((SECONDS - start < timeout)); do
		if [[ -f "$BRIDGE_LOG" ]] && grep -qE "$pat" "$BRIDGE_LOG" 2>/dev/null; then return 0; fi
		sleep 0.5
	done
	echo "TIMEOUT waiting for bridge-log: $pat" >&2
	return 1
}

scn_wait_for_log_count() {
	# scn_wait_for_log_count "regex" minimum_count timeout_seconds
	# Count barrier for repeated lifecycle events where an earlier match cannot
	# prove the current operation reached the expected phase.
	local pat="$1"
	local minimum="$2"
	local timeout="${3:-30}"
	local start=$SECONDS
	local count=0
	while ((SECONDS - start < timeout)); do
		count=$(grep -cE "$pat" "$BRIDGE_LOG" 2>/dev/null || true)
		count=${count:-0}
		if (( count >= minimum )); then return 0; fi
		sleep 0.5
	done
	echo "TIMEOUT waiting for bridge-log count >= $minimum: $pat (got $count)" >&2
	return 1
}

# Bridge log helpers — extract cache stats per turn from the debug log.
scn_cache_profile() {
	# Print the (creation, read) tuple per usage line in the bridge log.
	# Last usage entry per turn is the "final" usage (post-stream completion).
	grep -E "\"msg\":\"usage:" "$BRIDGE_LOG" | awk '{
		for (i = 1; i <= NF; i++) {
			if ($i ~ /^cacheRead=/) { gsub(/^cacheRead=/, "", $i); read = $i }
			if ($i ~ /^cacheWrite=/) { gsub(/^cacheWrite=/, "", $i); write = $i }
		}
		printf "  creation=%s read=%s\n", write, read
	}'
}

scn_session_count() {
	# How many distinct CC session_ids did the bridge cache during this run?
	# Use a single substitution to avoid the `0\n0` artifact from
	# `pipe-with-grep | ... || echo 0` under pipefail.
	local n
	n=$(grep -oE "caching session=[a-f0-9]+" "$BRIDGE_LOG" 2>/dev/null | sort -u | wc -l | tr -d ' \n' || true)
	echo "${n:-0}"
}

# Cross-driver tool-routing helpers.
#
# Older bridge builds logged `mcp handler: <tool> [...]`; both subprocess
# drivers log `onRouterPark: routed tools/call to pi (piId=...)` with the tool
# name in the structured `"name":"<tool>"` field. Keep both dialects so the
# same scenario assertions remain useful while comparing old evidence.

# scn_tool_count_any -> total tool routings across either driver.
scn_tool_count_any() {
	local sdk cp
	sdk=$(scn_grep_count "mcp handler: [a-zA-Z0-9_]+ \[" "$BRIDGE_LOG")
	cp=$(scn_grep_count "onRouterPark: routed tools/call" "$BRIDGE_LOG")
	echo $(( sdk + cp ))
}

# scn_tool_count_named "<tool>" -> routings of a specific tool across either driver.
# SDK: `mcp handler: <tool> [`. claude-p: onRouterPark line carrying `"name":"<tool>"`.
scn_tool_count_named() {
	local tool="$1"
	local sdk cp
	sdk=$(scn_grep_count "mcp handler: ${tool} \[" "$BRIDGE_LOG")
	# Match the onRouterPark line AND the JSON name field on the same line.
	cp=$(grep -E "onRouterPark: routed tools/call" "$BRIDGE_LOG" 2>/dev/null \
		| grep -cE "\"name\":\"${tool}\"" 2>/dev/null || true)
	cp=${cp:-0}
	echo $(( sdk + cp ))
}

# scn_warm_resume_count -> number of warm-resume turns across either driver.
scn_warm_resume_count() {
	scn_grep_count "(fresh query|fresh spawn).*resume=[a-f0-9]" "$BRIDGE_LOG"
}

# scn_cold_count -> number of cold-start turns across either driver (resume=no).
scn_cold_count() {
	scn_grep_count "(fresh query|fresh spawn).*resume=no" "$BRIDGE_LOG"
}

# Helper: count regex matches, sanitizing output to a single integer.
scn_grep_count() {
	# scn_grep_count "<regex>" "<file>"
	# grep -c returns 1 when no matches — under set -euo pipefail this
	# would abort the whole pipeline if combined with `| head | tr || echo 0`
	# (the `|| echo 0` runs after a partial "0" was already on stdout,
	# producing "0\n0"). Single-call form avoids the issue.
	local n
	n=$(grep -cE "$1" "$2" 2>/dev/null || true)
	echo "${n:-0}"
}

scn_pass() { echo "  PASS: $1"; }
scn_fail() { echo "  FAIL: $1"; SCN_FAILED=1; }

# Extract the model's response text to a specific user prompt by looking at
# the pane log for the prompt line, then capturing lines that follow until
# the next visual separator (blank line followed by separator) or another
# prompt. This lets coherence assertions check ONLY what the model said in
# response to the probe, not the entire pane.
#
# Usage: scn_probe_response "<prompt-substring>" -> writes response text to stdout
scn_probe_response() {
	local prompt_marker="$1"
	"${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -3000 > "$PANE_LOG"
	# Find the LAST occurrence of the prompt and emit lines after it that
	# look like model output (skip pi UI separators).
	awk -v pat="$prompt_marker" '
		BEGIN { capture = 0 }
		# When we hit the prompt line, start a new capture window.
		index($0, pat) > 0 { buf = ""; capture = 1; next }
		# Stop capturing if we hit a clear visual separator (long line of ─) or new prompt
		capture && /^─{20,}/ { capture = 0 }
		capture { buf = buf "\n" $0 }
		END { print buf }
	' "$PANE_LOG"
}

# Assert: the model response to <prompt-substring> contains a positive
# pattern AND does NOT contain a negative pattern. This avoids false-passes
# where the negative reply ("I don't know", "I wasn't interrupted") happens
# to contain the same words as the topic.
scn_assert_response() {
	# scn_assert_response "<prompt-substring>" "<positive-regex>" "<negative-regex>" "<descr>"
	local prompt="$1"; shift
	local positive="$1"; shift
	local negative="$1"; shift
	local descr="$1"
	local resp
	resp=$(scn_probe_response "$prompt")
	if [[ -z "$resp" ]]; then
		scn_fail "$descr — no response captured for prompt"
		return
	fi
	if echo "$resp" | grep -qiE "$negative"; then
		scn_fail "$descr — model gave a NEGATIVE response: '$(echo "$resp" | grep -iE "$negative" | head -1 | tr -d '\n' | cut -c1-120)'"
		return
	fi
	if echo "$resp" | grep -qiE "$positive"; then
		scn_pass "$descr — model affirmed: '$(echo "$resp" | grep -iE "$positive" | head -1 | tr -d '\n' | cut -c1-120)'"
		return
	fi
	scn_fail "$descr — neither positive nor negative pattern matched"
}

# Each scenario script begins with `SCN_FAILED=0` and ends with
# `exit $SCN_FAILED`. scn_pass/scn_fail collect into that.
