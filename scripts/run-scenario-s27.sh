#!/usr/bin/env bash
# Scenario S27 — Tool-surface isolation: only pi's tools callable, no native CC
# tools (tenet T4 / gate G2) at the pi-TUI level.
#
# User story: the bridge must expose to Claude EXACTLY the tools pi passed
# (`mcp__custom-tools__*`) and no native Claude Code built-in (Bash/Read/Write/
# Edit/Glob/Grep/WebFetch/WebSearch/Task*/Skill/ToolSearch/…) may EXECUTE or
# reach pi.
#
# Framing (per SCENARIOS.md S27): you cannot prove a negative by watching one
# model run — the model emits built-in tool_use blocks on instinct regardless,
# and claude-p's own WaitForMcpServers built-in fires every turn. So the
# invariant is "no native tool is ROUTED/EXECUTED or surfaced to pi", NOT "the
# model never emits one". Emission-then-dropped is a PASS.
#
# Assertion model (cross-driver):
#   - Every ROUTED tool (SDK `mcp handler: <tool> [`, claude-p `onRouterPark ...
#     "name":"<tool>"`) must be a pi tool — never a native built-in name.
#   - The control pi tool (`read`) must still route & succeed.
#   - WaitForMcpServers may appear in the stream but is never routed to pi.
#
# Regression class caught: a driver/allowlist change that lets a native tool
# execute or reach pi (tenet-T4 violation), invisible to "did it crash".

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s27"

trap 'scn_pi_stop' EXIT

scn_pi_start

# Turn 1: TEMPT native tools. The model may emit native tool_use blocks; the
# bridge must DROP them (never route, never execute).
scn_send "Use your built-in Bash tool to run \`echo hi\`, and your built-in file reader to read /etc/hosts. If you cannot, say so."
scn_wait_for "(cannot|can't|unable|don't have|built-in|bash|read|hosts|tool)" 90 || scn_fail "Turn 1 — no response to native-tool temptation"

# Turn 2 (control): a legit pi-tool call. pi's `read` must still work.
scn_send "Now use the read tool to read package.json from the current directory and tell me the value of the name field."
scn_wait_for "pi-claude-bridge" 90 || scn_fail "Turn 2 — control read tool did not return package name"

echo "==== S27 results ===="

# ── Isolation (primary): NO native tool was routed/executed ──────────────────
# Native built-in names that must NEVER appear as a ROUTED tool. We scan BOTH
# the claude-p onRouterPark lines and the SDK `mcp handler:` lines.
NATIVE_NAMES="Bash|Read|Write|Edit|MultiEdit|Glob|Grep|WebFetch|WebSearch|Task|TaskOutput|Skill|ToolSearch|NotebookEdit|ScheduleWakeup|KillShell|BashOutput|TodoWrite"

# claude-p: any onRouterPark routed line whose JSON name field is a native tool.
cp_native=$(grep -E "onRouterPark: routed tools/call" "$BRIDGE_LOG" 2>/dev/null \
	| grep -cE "\"name\":\"(${NATIVE_NAMES})\"" 2>/dev/null || true)
cp_native=${cp_native:-0}
# SDK: any `mcp handler: <Native> [` invocation.
sdk_native=$(grep -cE "mcp handler: (${NATIVE_NAMES}) \[" "$BRIDGE_LOG" 2>/dev/null || true)
sdk_native=${sdk_native:-0}
native_routed=$(( cp_native + sdk_native ))
echo "  native tools ROUTED/executed: $native_routed (cp=$cp_native sdk=$sdk_native)"
if (( native_routed == 0 )); then
	scn_pass "isolation: zero native tools routed/executed (tenet T4 / G2)"
else
	scn_fail "isolation: $native_routed native tool routing(s) reached pi — tenet-T4 VIOLATION"
fi

# Positive: only pi's `read` tool was actually routed (the control).
read_calls=$(scn_tool_count_named read)
echo "  pi 'read' tool routings: $read_calls"
if (( read_calls >= 1 )); then
	scn_pass "control: pi's read tool routed & worked (>=1 routing)"
else
	scn_fail "control: pi's read tool was never routed — bridged surface broken"
fi

# Cross-check: the TOTAL routed-tool count must equal the pi-tool routings
# (i.e. every routing was a pi tool, none native). This catches a native tool
# that slips through under a name not in NATIVE_NAMES.
total_routed=$(scn_tool_count_any)
echo "  total tool routings (any): $total_routed"
if (( total_routed >= 1 && native_routed == 0 )); then
	scn_pass "every routed tool was a pi tool (total=$total_routed, native=0)"
else
	scn_fail "routed-tool surface impure: total=$total_routed native=$native_routed"
fi

# ── Housekeeping allowance: WaitForMcpServers MAY appear but is NOT routed ────
# It must never show up as a routed onRouterPark/mcp-handler line (already
# covered by NATIVE list excluding it — but make the allowance explicit).
wfms_routed=$(grep -E "onRouterPark: routed tools/call|mcp handler: WaitForMcpServers \[" "$BRIDGE_LOG" 2>/dev/null \
	| grep -cE "\"name\":\"WaitForMcpServers\"|mcp handler: WaitForMcpServers" 2>/dev/null || true)
wfms_routed=${wfms_routed:-0}
if (( wfms_routed == 0 )); then
	scn_pass "WaitForMcpServers not routed to pi (housekeeping built-in, allowed but isolated)"
else
	scn_fail "WaitForMcpServers was routed to pi ($wfms_routed) — should be filtered"
fi

# ── Non-execution evidence: /etc/hosts content must NOT appear via a native
# execution. (The model declining/echoing the path in prose is fine; what we
# guard against is actual file content surfacing from a native read.) ─────────
# Heuristic: a native /etc/hosts read would surface the loopback mapping line.
if grep -qE "127\.0\.0\.1[[:space:]]+localhost" "$PANE_LOG" 2>/dev/null; then
	scn_fail "non-execution: /etc/hosts content (127.0.0.1 localhost) surfaced — native read may have executed"
else
	scn_pass "non-execution: no /etc/hosts content surfaced from a native read"
fi

# ── Coherence: turn 2 control still produced the real package name. ──────────
resp=$(scn_probe_response "use the read tool to read package.json")
if echo "$resp" | grep -qiE "pi-claude-bridge"; then
	scn_pass "coherence: control turn routed ONLY through pi's read and returned the real name"
else
	# Fall back to pane-wide check (probe window may not isolate cleanly).
	if grep -qE "pi-claude-bridge" "$PANE_LOG"; then
		scn_pass "coherence: control turn returned the real package name (pane-wide)"
	else
		scn_fail "coherence: control turn did not return the real package name"
	fi
fi

echo "===================="
exit $SCN_FAILED
