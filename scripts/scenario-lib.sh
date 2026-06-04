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
	export SESSION="pi-bridge-${name}-$$"
	export BRIDGE_LOG="$OUT_DIR/${name}.bridge.log"
	export PANE_LOG="$OUT_DIR/${name}.pane.log"
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
	# -ne disables auto-discovered extensions; -e loads ONLY our local copy.
	# Without -ne, pi would also load the installed copy at
	# ~/.pi/agent/git/github.com/cartwmic/pi-claude-bridge/, and the symbol
	# guard means the installed (legacy) one would win.
	"${TMUX_CMD[@]}" new-session -d -s "$SESSION" -x 200 -y 50 \
		"cd '$SCENARIO_CWD' && CLAUDE_BRIDGE_DEBUG=1 CLAUDE_BRIDGE_DEBUG_PATH='$BRIDGE_LOG' \
		 pi --no-session -ne -e '$REPO_DIR' --provider claude-bridge --model '$SCENARIO_MODEL' $extra_args"

	local deadline=$((SECONDS + 30))
	while (( SECONDS < deadline )); do
		if "${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -50 2>/dev/null | grep -qE "\(claude-bridge\)"; then
			break
		fi
		sleep 0.5
	done
	# Settle the draw loop after the ready marker appears.
	sleep 1
}

scn_pi_stop() {
	# Runs as every scenario's `trap 'scn_pi_stop' EXIT` handler, so $? here is
	# the scenario's pending exit code (from its final `exit $SCN_FAILED`).
	local rc=$?

	# ── Cross-cutting guard: tool-call PROTOCOL markup must NEVER reach the user.
	# When the model can't reach its MCP tools (shim not attached / API 529 /
	# degraded agent loop) it emits tool calls as TEXT —
	#   <function_calls><invoke name="mcp__…"><parameter …>…</parameter></invoke></function_calls>
	# — which claude-p streams as ordinary assistant text. The bridge MUST strip
	# it (src/driver/stream.ts sanitizeLeakedToolProtocol); if raw XML reaches the
	# rendered pane, FAIL the scenario regardless of any positive coherence match.
	# This is the negative invariant the original S0–S27 assertions never checked
	# (they grep for EXPECTED content, never for leaked protocol). Observed:
	# pi session 019e8c37 leaked 27 such blocks. See
	# tests/unit-driver-tool-protocol-leak.mjs.
	"${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -3000 > "$PANE_LOG" 2>/dev/null || true
	if [[ -f "$PANE_LOG" ]] && grep -qE '<(antml:)?(function_calls|tool_use|tool_call|function_call|invoke)[ >]|<(antml:)?parameter[[:space:]]+name=' "$PANE_LOG"; then
		echo "  FAIL: tool-call PROTOCOL markup leaked into the rendered response — raw <function_calls>/<invoke name=\"mcp__…\"> XML visible to the user (bridge sanitizer regression; see tests/unit-driver-tool-protocol-leak.mjs)"
		rc=1
	fi

	# ── Cross-cutting guard #2 (STRIP-PROOF): a leak the bridge SUCCESSFULLY strips
	# never reaches the pane, so guard #1 above is blind to it (it only catches
	# markup that ESCAPED the strip). The reliable signal lives in the bridge log:
	# `claudeP.stream.toolProtocolLeak`. Any such event means the model emitted a
	# tool call as TEXT — no structured call routed for it — which is a real
	# tool-calling failure for that turn even when the user-visible text is clean.
	# This is the gap that let pi session 019e8f5d (21 leaked spans, contained)
	# pass every existing assertion. RCA + repro:
	# .spike-notes/claude-p-gate/coldstart-perpetuation-proof.mjs.
	if [[ -f "$BRIDGE_LOG" ]] && grep -qE "toolProtocolLeak" "$BRIDGE_LOG" 2>/dev/null; then
		local nleak
		nleak=$(grep -cE "toolProtocolLeak" "$BRIDGE_LOG" 2>/dev/null || echo "?")
		echo "  FAIL: bridge log shows ${nleak} tool-protocol leak event(s) — the model emitted tool calls as TEXT (contained by the strip, but the tool surface failed this turn). See claudeP.stream.toolProtocolLeak in $BRIDGE_LOG"
		rc=1
	fi

	# Tear down the entire private tmux server, not just the session. Since the
	# server is dedicated to this scenario (per SCN_TMUX_SOCKET), kill-server
	# cleanly disposes of everything: the session, the pi process inside it, and
	# the server itself. No stray state survives, no broad `pkill` needed, no
	# risk to parallel siblings.
	"${TMUX_CMD[@]}" kill-server 2>/dev/null || true

	# Propagate a leak-induced failure into the scenario's exit status. (When rc
	# is already non-zero from a real assertion, this is a no-op re-assertion;
	# when the scenario otherwise passed but leaked, this flips it to FAIL.)
	if [[ "$rc" -ne 0 ]]; then exit "$rc"; fi
}

# Explicit, documented form of the cross-cutting guard above — call it directly
# in a scenario to assert the rendered response carries no tool-call protocol
# markup. (scn_pi_stop runs it automatically for every scenario; this is for a
# dedicated scenario that wants the check inline with a clear message.)
scn_assert_no_tool_protocol_leak() {
	local descr="${1:-rendered response}"
	"${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -3000 > "$PANE_LOG" 2>/dev/null || true
	if [[ -f "$PANE_LOG" ]] && grep -qE '<(antml:)?(function_calls|tool_use|tool_call|function_call|invoke)[ >]|<(antml:)?parameter[[:space:]]+name=' "$PANE_LOG"; then
		scn_fail "$descr — tool-call PROTOCOL markup leaked (raw <function_calls>/<invoke name=\"mcp__…\"> XML visible to the user)"
	else
		scn_pass "$descr — no tool-call protocol markup leaked"
	fi
}

# Cross-scenario isolation. Now a no-op when each scenario has its own
# private tmux server (the default). Kept for explicit use in scripts
# that want to ensure their server is fresh — idempotent. NEVER use a
# broad `pkill -f "pi --no-session"` here: it would kill parallel
# scenarios' pi processes that happen to share the user.
scn_clean_state() {
	"${TMUX_CMD[@]}" kill-server 2>/dev/null || true
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
# The SDK path logs `mcp handler: <tool> [...]` per tool invocation.
# The claude-p path logs `onRouterPark: routed tools/call to pi (piId=...)`
# with the tool name carried in the structured JSON field `"name":"<tool>"`
# (the message string itself only carries piId). These helpers count tool
# routings on EITHER driver so a single assertion passes on both.

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
# SDK: `streamSimple: fresh query ... resume=<hex>`.
# claude-p: `streamSimple[claude-p]: fresh spawn ... resume=<hex>`.
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
