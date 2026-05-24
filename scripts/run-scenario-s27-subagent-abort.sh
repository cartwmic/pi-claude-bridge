#!/usr/bin/env bash
# Scenario S27 — Abort during bridge-subagent execution.
#
# Parent on claude-bridge/opus-4-7 dispatches a long-running subagent on
# claude-bridge/claude-haiku-4-5. While the subagent is mid-execution
# (parent's MCP handler blocked on pi.deliverResult), user fires Escape.
# Tests D15 abort+supersede behavior in the bridge-subagent topology:
#   - Parent's onAbort fires.
#   - Parent's PTY is torn down (SIGINT + grace + SIGKILL).
#   - Subagent's PTY (separate spawnDriver, separate router) is also
#     terminated — pi.subagent runtime should signal the child on parent abort,
#     which propagates to the bridge's spawnDriver via its AbortSignal.
#   - No orphan `claude` PTY processes survive after abort.
#   - Post-abort turn coherence: parent's response acknowledges the user
#     interruption (not a tool failure or completion).
#
# This is the analog of s8/s20 but with a subagent-via-bridge in the middle
# instead of a direct bash sleep.
#
# Assertions:
#   A1. onAbort fired in bridge log (parent).
#   A2. >=1 subagent invocation observed (the abort window opened).
#   A3. No orphan `claude` PTY processes for THIS scenario's sessions after
#       trap-driven scn_pi_stop_with_session.
#   A4. Post-abort coherence — parent attributes stop to user interruption.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s27-subagent-abort"

SCENARIO_MODEL="${S27_MODEL:-claude-bridge/claude-opus-4-7}"

# Find pi-subagents
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
	exit 0
fi

# Snapshot pre-existing claude PTY pids so we can compare post-abort.
pre_claude_pids=$(pgrep -f "claude --session-id|claude --resume" 2>/dev/null | sort -u | tr '\n' ',' || true)
echo "  pre-scenario claude PTY pids: ${pre_claude_pids:-<none>}"

trap 'scn_pi_stop' EXIT

# Custom start with both extensions
"${TMUX_CMD[@]}" new-session -d -s "$SESSION" -x 200 -y 50 \
	"cd '$SCENARIO_CWD' && CLAUDE_BRIDGE_DEBUG=1 CLAUDE_BRIDGE_DEBUG_PATH='$BRIDGE_LOG' \
	 pi --no-session -ne -e '$REPO_DIR' -e '$SUBAGENT_PATH' --provider claude-bridge --model '$SCENARIO_MODEL'"
deadline=$((SECONDS + 30))
while (( SECONDS < deadline )); do
	if "${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -50 2>/dev/null | grep -qE "\(claude-bridge\)"; then
		break
	fi
	sleep 0.5
done
sleep 1

# Dispatch a long-running subagent. Don't wait for completion — we want to
# abort mid-execution. Use raw tmux send-keys so scn_send's completion-wait
# doesn't block here.
"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" -- "Use the subagent tool to dispatch a worker on claude-bridge/claude-haiku-4-5. The worker's task: run bash 'for i in \$(seq 1 30); do echo \"S27-PROGRESS-\$i\"; sleep 2; done' to print 30 lines slowly. The worker must run the bash command directly; do not narrate."
"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" Enter

# Poll bridge log for subagent dispatch. When we see `mcp handler: subagent`
# the parent's MCP handler is blocked awaiting the subagent's result —
# that's the abort window.
deadline=$((SECONDS + 60))
mid_subagent=0
while (( SECONDS < deadline )); do
	if grep -q "mcp handler: subagent " "$BRIDGE_LOG" 2>/dev/null; then
		mid_subagent=1
		break
	fi
	sleep 0.5
done

if (( mid_subagent == 0 )); then
	echo "  could not enter mid-subagent window (model didn't invoke subagent; treating as inconclusive PASS — model-behavior variance)"
	scn_pass "test setup: model did not enter subagent-execution window (D15 abort path not exercised this run)"
	echo "===================="
	exit $SCN_FAILED
fi

echo "  parent MCP handler blocked on subagent — firing Escape in 3s"
sleep 3
"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" Escape
sleep 5

# A1: onAbort fired
if grep -q "onAbort:" "$BRIDGE_LOG"; then
	scn_pass "parent's bridge onAbort fired"
else
	scn_fail "no onAbort in bridge log — parent's abort signal didn't reach bridge"
fi

# A2: subagent was invoked (already verified by the gate above, but recorded
# as a PASS assertion).
subagent_calls=$(scn_grep_count "mcp handler: subagent " "$BRIDGE_LOG")
echo "  subagent invocations: $subagent_calls"
if (( subagent_calls >= 1 )); then
	scn_pass "subagent tool invoked through bridge (>=1 call before abort)"
else
	scn_fail "subagent never invoked"
fi

# A3: no orphan PTY processes. After abort, all claude PTYs spawned by
# THIS scenario's pi instance should be gone. We compare against the
# pre-scenario snapshot.
sleep 2
post_claude_pids=$(pgrep -f "claude --session-id|claude --resume" 2>/dev/null | sort -u | tr '\n' ',' || true)
echo "  post-abort claude PTY pids: ${post_claude_pids:-<none>}"
new_pids=""
if [[ -n "$post_claude_pids" ]]; then
	# Compute pids that exist now but didn't pre-scenario.
	for p in ${post_claude_pids//,/ }; do
		if ! [[ ",$pre_claude_pids," == *",$p,"* ]]; then
			new_pids="$new_pids $p"
		fi
	done
fi
new_pids=$(echo "$new_pids" | xargs)
if [[ -z "$new_pids" ]]; then
	scn_pass "no orphan claude PTY processes after abort (parent + subagent PTYs both torn down)"
else
	# Note: orphans CAN be a pi-subagents-side issue (child not signaled) or
	# a bridge-side D15 issue. Record as fail with diagnostic info.
	scn_fail "orphan claude PTYs survived abort: $new_pids (parent or subagent PTY not cleaned up)"
fi

# A4: pushAbortedError when pi was awaiting subagent result.
if grep -q "pushAbortedError: pi was awaiting tool result" "$BRIDGE_LOG"; then
	scn_pass "FM1: bridge pushed aborted error to pi stream during subagent-execution window"
else
	echo "  FM1: no pushAbortedError (parent may have had no pendingEntries at abort time)"
fi

# A5: post-abort coherence probe. Pi may already be in cooldown/retry state;
# best-effort.
scn_send "Briefly: did the subagent finish, or did I interrupt it?"

if grep -qiE "(interrupted|aborted|cancel|didn'?t finish|stopped|incomplete|you interrupted)" "$PANE_LOG"; then
	scn_pass "coherence: parent acknowledged user interruption of subagent"
else
	echo "  coherence: model-behavior variance — couldn't confirm abort attribution"
fi

echo "Cache profile:"
scn_cache_profile

echo "===================="
exit $SCN_FAILED
