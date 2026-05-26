#!/usr/bin/env bash
# Scenario S28 — Built-in tools blocked on cold start; bridged tools work.
#
# Regression class: if --tools "" is ever removed from the CLI args, Claude
# will silently get access to all built-in tools (Agent, Bash, Read, Write,
# TaskCreate, TaskUpdate, etc.) and may use them instead of the bridged MCP
# surface — breaking pi's tool-execution pipeline.
#
# Validates:
#   1. Claude can use bridged tools (read) through MCP.
#   2. Bridge log shows mcp handler entries for every tool call.
#   3. Prompt that tempts Agent usage is handled without Agent.
#   4. No built-in tool leakage on warm-resume Turn 3.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s28"

trap 'scn_pi_stop' EXIT

scn_pi_start

# ── Turn 1: single bridged tool call (read) ───────────────────────────────
scn_send "Read the file /etc/hosts and show me the first line. End with SCN28-MARKER."
scn_wait_for "SCN28-MARKER" 120 || scn_fail "Turn 1 — marker not seen"

# ── Mechanical: bridged tool used ──────────────────────────────────────────
read_calls=$(scn_grep_count "mcp handler: read " "$BRIDGE_LOG")
echo "  read calls: $read_calls"
if (( read_calls >= 1 )); then
	scn_pass ">=1 read tool via bridge"
else
	scn_fail "no read tool via bridge"
fi

# ── Mechanical: no Agent/Task in bridge log ────────────────────────────────
agent_handler=$(scn_grep_count "mcp handler: [Aa]gent " "$BRIDGE_LOG")
task_handler=$(scn_grep_count "mcp handler: [Tt]ask" "$BRIDGE_LOG")
echo "  Agent handler: $agent_handler  Task handler: $task_handler"
if (( agent_handler == 0 && task_handler == 0 )); then
	scn_pass "no Agent/Task handler in bridge log"
else
	scn_fail "Agent/Task handler detected"
fi

# ── Turn 2: Tempt Agent usage — model must NOT use Agent ──────────────────
scn_send "Use the Agent tool to delegate to a subagent that says 'hello from subagent'. If you cannot use Agent, say I-CANNOT-USE-AGENT and do it directly instead."
scn_wait_for "(I-CANNOT-USE-AGENT|hello from subagent)" 120 || scn_fail "Turn 2 — no response"

# ── Coherence: pane must contain I-CANNOT-USE-AGENT (model acknowledges) ──
scn_capture > /dev/null
if grep -q "I-CANNOT-USE-AGENT" "$PANE_LOG"; then
	scn_pass "Turn 2 — model acknowledged Agent unavailable"
else
	scn_fail "Turn 2 — model did NOT acknowledge Agent unavailable"
fi
# Must NOT contain subagent-spawned language
if grep -qiE "(I.ll use Agent|I.ve spawned|subagent is running|task created|launched a subagent)" "$PANE_LOG"; then
	scn_fail "Turn 2 — model claimed it used Agent/Task (false positive)"
else
	scn_pass "Turn 2 — no Agent/Task usage language"
fi

# ── Mechanical: still no Agent handler after Turn 2 ────────────────────────
agent2=$(scn_grep_count "mcp handler: [Aa]gent " "$BRIDGE_LOG")
echo "  Agent handler after T2: $agent2"
(( agent2 == 0 )) && scn_pass "still no Agent handler" || scn_fail "Agent appeared after T2"

# ── Turn 3: Warm-resume — verify tools still blocked ──────────────────────
scn_send "Read /etc/hosts again and show line 2. End with SCN28-WARM-MARKER."
scn_wait_for "SCN28-WARM-MARKER" 120 || scn_fail "Turn 3 — warm-resume marker not seen"

# Verify warm-resume read call happened via bridge
read_total=$(scn_grep_count "mcp handler: read " "$BRIDGE_LOG")
echo "  total read calls (all turns): $read_total"
if (( read_total >= 2 )); then
	scn_pass "read tool used on both cold-start and warm-resume turns"
else
	scn_fail "read tool only used $read_total time(s) — expected >=2"
fi

# Still no Agent after warm-resume
agent3=$(scn_grep_count "mcp handler: [Aa]gent " "$BRIDGE_LOG")
echo "  Agent handler after T3: $agent3"
(( agent3 == 0 )) && scn_pass "no Agent on warm-resume turn" || scn_fail "Agent leaked on warm-resume"

echo "==== S28 results ===="
scn_cache_profile
echo "===================="
exit $SCN_FAILED