#!/usr/bin/env bash
# Scenario S13 — Rapid abort-and-retype (typo-fix pattern).
# Three prompts, two abort+retype cycles, then enumeration probe.
# Each abort must fire mid-stream (do NOT wait for completion).

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s13"

trap 'scn_pi_stop' EXIT

scn_pi_start

# Prompt 1 — over-broad, will get aborted
	"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" -- "Read every file in /etc and tell me about each one in detail."
	"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" Enter
sleep 5

# Abort + retype prompt 2
	"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" Escape
sleep 2
	"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" -- "Actually, just tell me how many files are in src/ of this repo."
	"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" Enter
sleep 5

# Abort + retype final prompt
	"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" Escape
sleep 2
scn_send "Sorry — I meant: how many .ts files are in this directory? Use bash 'ls *.ts | wc -l'."

# Coherence probe
scn_send "List the three different things I asked you in this conversation, in order."

echo "==== S13 results ===="

# Architectural: at least 2 onAbort events
abort_count=$(scn_grep_count "onAbort:" "$BRIDGE_LOG")
echo "  onAbort events: $abort_count"
if (( abort_count >= 2 )); then
	scn_pass ">=2 onAbort events (both rapid aborts fired)"
else
	scn_fail "expected >=2 onAbort events, got $abort_count (timing too slow — model finished before abort)"
fi

# Architectural: no legacy deferred-replay
if grep -qE "(deferredUserMessages|continuation query)" "$BRIDGE_LOG"; then
	scn_fail "legacy deferred-replay observed"
else
	scn_pass "no deferred-replay"
fi

# COHERENCE: enumeration must mention all three topics from the model's response
# (not from the pane background which contains my prompt text).
resp=$(scn_probe_response "List the three different things I asked you")
echo "  --- model's enumeration response (first 1000 chars) ---"
echo "$resp" | head -c 1000
echo "  --- end ---"

# Negative check: model says "only one" or similar
if echo "$resp" | grep -qiE "(only.*one|just one request|don't.*see|no prior|can't see|don't have any (prior|previous))"; then
	scn_fail "coherence: model claims it can't see prior requests"
else
	# Positive check: response references all three topics
	mentions_etc=$(echo "$resp" | grep -ciE "/etc|etc.directory|etc.folder|etc files")
	mentions_src=$(echo "$resp" | grep -ciE "src/|src.directory|src.folder|files in src|in src")
	mentions_ts=$(echo "$resp" | grep -ciE "\.ts|typescript|ts files|ts file")
	echo "  topic mentions in model's response: /etc=$mentions_etc src=$mentions_src .ts=$mentions_ts"
	if (( mentions_etc >= 1 && mentions_src >= 1 && mentions_ts >= 1 )); then
		scn_pass "coherence: enumeration covers all three topics"
	else
		scn_fail "coherence: enumeration missing one or more topics (need /etc, src, .ts)"
	fi
fi

echo "Cache profile:"
scn_cache_profile

echo "===================="
exit $SCN_FAILED
