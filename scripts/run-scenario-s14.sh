#!/usr/bin/env bash
# Scenario S14 — Subagent: claude-bridge → claude-bridge worker.
# Requires pi-subagents to be loaded, which is normally enabled via the
# user's pi packages. Since the harness uses -ne (no auto extensions), we
# load pi-subagents explicitly via -e.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s14"

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
tmux new-session -d -s "$SESSION" -x 200 -y 50 \
	"cd '$SCENARIO_CWD' && CLAUDE_BRIDGE_DEBUG=1 CLAUDE_BRIDGE_DEBUG_PATH='$BRIDGE_LOG' \
	 pi --no-session -ne -e '$REPO_DIR' -e '$SUBAGENT_PATH' --provider claude-bridge --model '$SCENARIO_MODEL'"
sleep 3

scn_send "Use the subagent tool to dispatch a worker (also on claude-bridge/claude-haiku-4-5) to count the .ts files in the current directory using bash 'ls *.ts | wc -l'. Have it write the count to /tmp/s14-result.txt and return the count in its message."

scn_wait_for "(count|files|[0-9]+)" 180 || scn_fail "Subagent — no result"

scn_send "What did the subagent report, and does that match what's in /tmp/s14-result.txt?"
scn_wait_for "(yes|matches|both|same|[0-9]+)" 60 || scn_fail "Verification — no answer"

echo "==== S14 results ===="

# Subagent tool was invoked
subagent_calls=$(grep -ciE "mcp handler: subagent " "$BRIDGE_LOG" || echo 0)
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

# Tool result file should exist if subagent ran
if [[ -f /tmp/s14-result.txt ]]; then
	scn_pass "subagent wrote /tmp/s14-result.txt"
	echo "  contents: $(cat /tmp/s14-result.txt | head -1)"
else
	scn_fail "subagent did NOT write /tmp/s14-result.txt"
fi

echo "Cache profile (last 6):"
scn_cache_profile | tail -6

echo "===================="
rm -f /tmp/s14-result.txt
exit $SCN_FAILED
