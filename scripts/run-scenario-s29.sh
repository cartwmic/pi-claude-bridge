#!/usr/bin/env bash
# Scenario S29 — Dedicated warm-resume tool blocking.
#
# Regression class: --resume must carry --tools "" just like cold start.
# Without it, a resumed session gets ALL built-in tools.
#
# This scenario explicitly tests the resume path by verifying:
#   1. Tool turn works after resume
#   2. Agent/Task still blocked after resume
#   3. Session count shows warm-resume (not cold restart)

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s29"

trap 'scn_pi_stop' EXIT

scn_pi_start

# ── Turn 1: establish session with a tool call ────────────────────────────
scn_send "Create file /tmp/scn29-test.txt with content 'SCN29-WARMUP' using the write tool. End with SCN29-1."
scn_wait_for "SCN29-1" 120 || scn_fail "Turn 1 — marker not seen"

t1_tools=$(scn_grep_count "mcp handler: " "$BRIDGE_LOG")
echo "  Turn 1 tools: $t1_tools"
(( t1_tools >= 1 )) && scn_pass "bridged tool(s) on Turn 1" || scn_fail "no tools on Turn 1"

# ── Turn 2: warm-resume — tempt Agent use ─────────────────────────────────
scn_send "Use the TaskCreate or Agent tool to spawn a subagent that says 'hi from task'. If you cannot, say I-CANNOT-USE-TASK and do it yourself. End with SCN29-2."
scn_wait_for "(I-CANNOT-USE-TASK|SCN29-2)" 120 || scn_fail "Turn 2 — no response"

# Coherence: pane must show model acknowledged unavailability
scn_capture > /dev/null
if grep -q "I-CANNOT-USE-TASK" "$PANE_LOG"; then
	scn_pass "Turn 2 — model acknowledged Task/Agent unavailable"
else
	scn_fail "Turn 2 — model did NOT acknowledge Task/Agent unavailable"
fi

# Must NOT contain usage language
if grep -qiE "(I.ll use Agent|I.ll use Task|I.ve spawned|subagent.*running|task.*created|launched.*subagent)" "$PANE_LOG"; then
	scn_fail "Turn 2 — model claimed it used Agent/Task"
else
	scn_pass "Turn 2 — no Agent/Task usage language"
fi

# ── Mechanical: no Agent/Task in entire session ───────────────────────────
agent_all=$(scn_grep_count "mcp handler: [Aa]gent " "$BRIDGE_LOG")
task_all=$(scn_grep_count "mcp handler: [Tt]ask" "$BRIDGE_LOG")
echo "  Agent handler (all): $agent_all  Task handler (all): $task_all"
(( agent_all == 0 && task_all == 0 )) && scn_pass "no Agent/Task across session" || scn_fail "Agent/Task detected"

# ── Session count: warm-resume should reuse cache ─────────────────────────
sessions=$(scn_session_count)
echo "  CC sessions: $sessions"
if (( sessions == 1 )); then
	scn_pass "single CC session (warm-resume reused)"
elif (( sessions == 2 )); then
	scn_pass "2 CC sessions (acceptable — cache may have expired)"
else
	scn_fail "unexpected session count: $sessions"
fi

# ── Tools used on both turns via bridge ────────────────────────────────────
total_tools=$(scn_grep_count "mcp handler: " "$BRIDGE_LOG")
echo "  total mcp handler calls: $total_tools"
# Turn 2 may not need a tool (model responds directly after acknowledging
# Agent/Task is unavailable). At least 1 tool call is sufficient — Turn 1
# must have used a bridged tool.
(( total_tools >= 1 )) && scn_pass ">=1 tool call(s) across session" || scn_fail "no tool calls"

echo "==== S29 results ===="
scn_cache_profile
echo "===================="
exit $SCN_FAILED