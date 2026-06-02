#!/usr/bin/env bash
# Scenario S8 — User abort during tool execution.
# Tool runs (sleep 120 + echo); user aborts before tool finishes; verify
# model doesn't fabricate the result.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s8"

trap 'scn_pi_stop' EXIT

scn_pi_start

ps_before=$(pgrep -f "sleep 120" 2>/dev/null | wc -l | tr -d ' \n' || echo 0)
ps_before=${ps_before:-0}

# Send long-running tool prompt — do NOT wait for completion
	"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" -- "Run this exact bash command: 'sleep 120 && echo HELLO-S8'"
	"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" Enter
sleep 8

# Abort while bash is mid-flight
	"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" Escape
sleep 3

# Coherence probe
scn_send "Did the sleep command actually finish and print anything? Be specific about what you observed."

echo "==== S8 results ===="

if grep -qE "onAbort" "$BRIDGE_LOG"; then
	scn_pass "bridge onAbort fired"
else
	scn_fail "no onAbort"
fi

# No fabricated tool subprocess left over.
# Abort teardown is asynchronous: pi propagates the interrupt, the driver
# tears down (on claude-p, the PTY is killed) and the tool subprocess is
# reaped. That can take a few seconds, so poll for up to ~12s for the
# orphan count to drop back to baseline rather than asserting after a fixed
# 2s (which races the reap and yields spurious "orphan" failures).
ps_after=$ps_before
for _ in 1 2 3 4 5 6; do
	ps_after=$(pgrep -f "sleep 120" 2>/dev/null | wc -l | tr -d ' \n' || true)
	ps_after=${ps_after:-0}
	(( ps_after <= ps_before )) && break
	sleep 2
done
echo "  sleep 120 procs: before=$ps_before after=$ps_after"
if (( ps_after <= ps_before )); then
	scn_pass "no orphan sleep subprocesses"
else
	scn_fail "$((ps_after - ps_before)) orphan sleep subprocess(es)"
	pkill -9 -f "sleep 120" 2>/dev/null || true
fi

# No legacy abort surgery
if grep -qE "(UUID rotation|pendingTruncate|truncating)" "$BRIDGE_LOG"; then
	scn_fail "legacy abort surgery"
else
	scn_pass "no UUID rotation / no JSONL surgery"
fi

# COHERENCE: model must NOT claim the sleep finished or HELLO-S8 was printed.
# Negative regex is precise — must claim positive completion of HELLO-S8 to match.
scn_assert_response \
	"Did the sleep command actually finish" \
	"(no|did not|didn't|never (executed|printed|finished|completed|reached)|interrupted|aborted|stopped|cancel|wasn't able to (finish|complete|run))" \
	"(yes.*finished|yes.*completed successfully|HELLO-S8 was printed|the command printed HELLO-S8|output was HELLO-S8|i saw HELLO-S8|the marker.*HELLO-S8)" \
	"coherence: model knows sleep was aborted, didn't fabricate HELLO-S8"

echo "Cache profile:"
scn_cache_profile

echo "===================="
exit $SCN_FAILED
