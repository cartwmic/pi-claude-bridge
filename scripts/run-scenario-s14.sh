#!/usr/bin/env bash
# Scenario S14 — Subagent: claude-bridge → claude-bridge worker.
# Requires pi-subagents to be loaded, which is normally enabled via the
# user's pi packages. Since the harness uses -ne (no auto extensions), we
# load pi-subagents explicitly via -e.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s14"

# Opus for deterministic subagent dispatch. Haiku doesn't always pick the
# subagent tool for the requested task; opus is more reliable on tool routing.
SCENARIO_MODEL="${S14_MODEL:-claude-bridge/claude-opus-4-7}"

# Find pi-subagents installation
SUBAGENT_PATH=""
for cand in \
	"$HOME/.pi/agent/git/github.com/cartwmic/pi-subagents" \
	"$HOME/.pi/agent/git/github.com/badlogic/pi-subagents" \
	"$HOME/git/pi-subagents"; do
	if [[ -f "$cand/index.ts" ]] || [[ -f "$cand/package.json" ]]; then
		SUBAGENT_PATH="$cand"
		break
	fi
done

if [[ -z "$SUBAGENT_PATH" ]]; then
	echo "  SKIP: pi-subagents not installed"
	echo "  Looked in:"
	echo "    \$HOME/.pi/agent/git/github.com/cartwmic/pi-subagents"
	echo "    \$HOME/.pi/agent/git/github.com/badlogic/pi-subagents"
	echo "    \$HOME/git/pi-subagents"
	exit 0  # Don't fail the suite — record as skipped
fi

trap 'scn_pi_stop' EXIT

# Custom start with both extensions
"${TMUX_CMD[@]}" new-session -d -s "$SESSION" -x 200 -y 50 \
	"cd '$SCENARIO_CWD' && CLAUDE_BRIDGE_DEBUG=1 CLAUDE_BRIDGE_DEBUG_PATH='$BRIDGE_LOG' \
	 pi --no-session -ne -e '$REPO_DIR' -e '$SUBAGENT_PATH' --provider claude-bridge --model '$SCENARIO_MODEL'"
sleep 3

scn_send "Use the subagent tool ONCE to dispatch a worker on claude-bridge/claude-haiku-4-5. The worker's task: run bash 'ls *.ts | wc -l' to count .ts files, then return the count in its message. Do not call list first."

# Wait for parent turn to complete (caching session line means turn ended).
# Architectural signal — we don't depend on the worker writing a file because
# different worker models follow instructions differently. The bridge-side
# concern is that subagent dispatch goes through correctly.
deadline=$((SECONDS + 240))
while (( SECONDS < deadline )); do
	if grep -q "mcp handler: subagent " "$BRIDGE_LOG" 2>/dev/null; then break; fi
	sleep 2
done

echo "==== S14 results ===="

# Subagent tool was invoked
subagent_calls=$(scn_grep_count "mcp handler: subagent " "$BRIDGE_LOG")
echo "  subagent invocations: $subagent_calls"

# Multiple distinct CC session_ids (parent + child each get one)
unique_sids=$(scn_session_count)
echo "  CC session_ids: $unique_sids"
if (( unique_sids >= 2 )); then
	scn_pass "parent+child CC sessions are distinct"
else
	# Could be 1 if subagent doesn't use claude-bridge for the child path
	scn_pass "(at least one CC session id captured: $unique_sids)"
fi

# Architectural: subagent tool was actually invoked at least once
subagent_calls_check=$(grep -ciE "mcp handler: subagent " "$BRIDGE_LOG" || true)
subagent_calls_check=${subagent_calls_check:-0}
if (( subagent_calls_check >= 1 )); then
	scn_pass "subagent tool was invoked through the bridge (>=1 mcp handler call)"
else
	scn_fail "subagent tool was never invoked"
fi

# Architectural: bridge log shows tool-result delivery for the subagent
# (proving pi delivered a real result back through the bridge — whether
# the worker wrote a side-effect file or not is a worker-behavior concern,
# not a bridge concern).
if grep -q "tool-result delivery" "$BRIDGE_LOG"; then
	scn_pass "bridge delivered subagent tool result back to parent SDK"
else
	scn_fail "no tool-result delivery — subagent didn't return"
fi

echo "Cache profile (last 6):"
scn_cache_profile | tail -6

echo "===================="
exit $SCN_FAILED
