#!/usr/bin/env bash
# Scenario S13 — Rapid abort-and-retype (typo-fix pattern).
# Two consecutive Escape+retype cycles, then a coherence probe asking the
# model to enumerate all three things asked.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s13"

trap 'scn_pi_stop' EXIT

scn_pi_start

# 1st prompt — over-broad
tmux send-keys -t "$SESSION:0" -- "List every file in /etc and read its contents."
tmux send-keys -t "$SESSION:0" Enter
sleep 4

# Abort + retype
tmux send-keys -t "$SESSION:0" "Escape"
sleep 1
tmux send-keys -t "$SESSION:0" -- "Actually, just tell me how many files are in src/ of this repo."
tmux send-keys -t "$SESSION:0" Enter
sleep 4

# Abort + final
tmux send-keys -t "$SESSION:0" "Escape"
sleep 1
scn_send "Sorry — I meant: how many .ts files are in this directory, and what's the largest one by line count? Use bash."

scn_wait_for "(\.ts|line|largest|file|index|wc)" 120 || scn_fail "Final turn — no answer"

# Coherence probe
scn_send "What three different things did I ask you in this conversation?"
scn_wait_for "(/etc|src|\.ts|three|first|second|third|originally)" 60 || scn_fail "Coherence — no enumeration"

echo "==== S13 results ===="

# Architectural: with a fast model (haiku), a turn may complete before our
# Escape lands — that's fine; the architecture supports both early-abort
# and late-abort cases. Just require: no errors, no deferred-replay, all
# three user prompts reached the bridge.
prompts_observed=$(grep -cE "streamSimple: fresh query" "$BRIDGE_LOG" 2>/dev/null | head -1 | tr -d ' \n')
prompts_observed=${prompts_observed:-0}
echo "  fresh-query prompts observed: $prompts_observed"
if (( prompts_observed >= 3 )); then
	scn_pass ">=3 distinct user prompts reached the bridge"
else
	scn_fail "expected >=3 prompts, got $prompts_observed"
fi

# No legacy deferred-replay
if grep -qE "(deferredUserMessages|continuation query)" "$BRIDGE_LOG"; then
	scn_fail "legacy deferred-replay observed"
else
	scn_pass "no deferred-replay"
fi

# No JSONL surgery
if grep -qE "(UUID rotation|pendingTruncate|truncating)" "$BRIDGE_LOG"; then
	scn_fail "legacy abort-surgery observed"
else
	scn_pass "no UUID rotation / no JSONL surgery"
fi

# Coherence: enumeration mentions all three topics
mentions_etc=$(grep -ciE "/etc|etc.directory" "$PANE_LOG" || echo 0)
mentions_src=$(grep -ciE "src/|src.directory|src.folder" "$PANE_LOG" || echo 0)
mentions_ts=$(grep -ciE "\.ts|typescript|ts.file" "$PANE_LOG" || echo 0)
echo "  mentions: /etc=$mentions_etc src=$mentions_src .ts=$mentions_ts"
if (( mentions_etc >= 1 && mentions_src >= 1 && mentions_ts >= 1 )); then
	scn_pass "coherence: all three abandoned/completed topics referenced"
else
	scn_fail "coherence: not all three topics referenced"
fi

echo "Cache profile:"
scn_cache_profile

echo "===================="
exit $SCN_FAILED
