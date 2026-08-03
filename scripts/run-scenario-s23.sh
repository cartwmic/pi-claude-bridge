#!/usr/bin/env bash
# Scenario S23 — /reload preserves working provider registration.
#
# Regression: pi's reload() calls resetApiProviders() between session_shutdown
# and the re-run of extensions. The bridge had a globalThis Symbol guard that
# survived reload, so registerProvider() was skipped on the second module init
# — leaving pi with no provider for claude-bridge models. Subsequent user
# input was "submitted" but never reached inference (silent hang).
#
# This scenario:
#   1. Confirm a normal turn works (T1).
#   2. Issue /reload.
#   3. Submit another turn (T2).
#   4. Assert the model actually responds AND a fresh streamSimple query fired
#      after reload.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s23"

trap 'scn_pi_stop' EXIT

scn_pi_start

# T1: prime the session and confirm provider works pre-reload.
scn_send "Reply with exactly the single token PRE-RELOAD-7K2 and nothing else."
scn_wait_for "PRE-RELOAD-7K2" 60 || scn_fail "T1: pre-reload turn never produced marker"

# Snapshot bridge-log query count before reload.
pre_queries=$(scn_grep_count "streamSimple(\[(claude-p|claude-print)\])?: fresh (query|spawn)" "$BRIDGE_LOG")
echo "  fresh queries before reload: $pre_queries"

# Issue /reload as a slash command.
"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" -- "/reload"
"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" Enter

# Reload involves session_shutdown → resetApiProviders → resourceLoader.reload
# → session_start. Wait for the bridge's re-registration log line. If it never
# arrives, the bug is back.
deadline=$((SECONDS + 30))
while (( SECONDS < deadline )); do
	if grep -qE "provider: registered" "$BRIDGE_LOG"; then
		# We need at least 2 occurrences (initial + post-reload).
		reg_count=$(scn_grep_count "provider: registered" "$BRIDGE_LOG")
		if (( reg_count >= 2 )); then break; fi
	fi
	sleep 0.5
done

reg_count=$(scn_grep_count "provider: registered" "$BRIDGE_LOG")
skipped_count=$(scn_grep_count "skipping re-registration" "$BRIDGE_LOG")
echo "  provider: registered count = $reg_count"
echo "  provider: skipping re-registration count = $skipped_count"

if (( reg_count >= 2 )); then
	scn_pass "provider re-registered after /reload"
else
	scn_fail "provider NOT re-registered after /reload (count=$reg_count) — guard persisted"
fi

# Provider registration precedes session_start:reload. Sending during that gap
# sees an empty active-tool set and can be misclassified as a capture call.
scn_wait_for_log '"reason":"reload".*"msg":"session_start:reload' 30 || scn_fail "post-reload session_start never arrived"
sleep 1

# T2: now submit a turn after reload. If the bug is present, this hangs and
# scn_send times out (no `caching session=` ever appears).
scn_send "RELOAD-PROBE: In one short sentence, what city is the capital of France?"

post_queries=$(scn_grep_count "streamSimple(\[(claude-p|claude-print)\])?: fresh (query|spawn)" "$BRIDGE_LOG")
echo "  fresh queries after reload: $post_queries"

if (( post_queries > pre_queries )); then
	scn_pass "post-reload turn invoked streamSimple (provider wired)"
else
	scn_fail "post-reload turn did NOT invoke streamSimple (silent hang)"
fi

echo "==== S23 results ===="

# Coherence probe: model must actually answer T2 with the post-reload marker.
# Use the prompt's distinctive question text as the marker (NOT the expected
# response token) — scn_probe_response finds the LAST match and captures after,
# so prompt and response markers must differ.
scn_assert_response \
	"RELOAD-PROBE" \
	"Paris" \
	"(i (don't|cannot|can't|won't)|unable to|error)" \
	"coherence: post-reload turn produced model response"

echo "Cache profile:"
scn_cache_profile

echo "===================="
exit $SCN_FAILED
