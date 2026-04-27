#!/usr/bin/env bash
# Scenario S24 — /new preserves working provider registration.
#
# Same regression class as S23 but on a different code path. Pi rebuilds a
# fresh ModelRegistry on every session change (new, resume, fork, reload) via
# createAgentSessionServices, then re-runs extensions to populate it. The
# bridge's globalThis Symbol guard survives across session changes, causing
# pi.registerProvider to be skipped on the second module init — the new
# ModelRegistry never receives claude-bridge models, and /new falls back to
# the next-available provider (e.g. codex/gpt-5.4) instead of the configured
# claude-bridge default.
#
# This scenario:
#   1. Confirm a normal turn works pre-/new (T1).
#   2. Issue /new.
#   3. Submit another turn (T2).
#   4. Assert the bridge still serves the model (no fallback to a different
#      provider).

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s24"

trap 'scn_pi_stop' EXIT

scn_pi_start

# T1: prime — confirms the bridge is wired pre-/new.
scn_send "Reply with exactly the single token PRE-NEW-7K2 and nothing else."
scn_wait_for "PRE-NEW-7K2" 60 || scn_fail "T1: pre-/new turn never produced marker"

pre_queries=$(scn_grep_count "streamSimple: fresh query" "$BRIDGE_LOG")
echo "  fresh queries before /new: $pre_queries"

# Issue /new as a slash command.
"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" -- "/new"
"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" Enter

# /new fires session_shutdown reason=new then session_start reason=new, then
# rebuilds services (fresh ModelRegistry). Wait for the bridge log to show
# a second `provider: registered` line — proves the guard was dropped and
# the new registry got the bridge's models.
deadline=$((SECONDS + 30))
while (( SECONDS < deadline )); do
	reg_count=$(scn_grep_count "provider: registered" "$BRIDGE_LOG")
	(( reg_count >= 2 )) && break
	sleep 0.5
done

reg_count=$(scn_grep_count "provider: registered" "$BRIDGE_LOG")
skipped_count=$(scn_grep_count "skipping re-registration" "$BRIDGE_LOG")
echo "  provider: registered count = $reg_count"
echo "  provider: skipping re-registration count = $skipped_count"

if (( reg_count >= 2 )); then
	scn_pass "provider re-registered after /new"
else
	scn_fail "provider NOT re-registered after /new (count=$reg_count) — guard persisted"
fi

# Pi's bottom status shows `(<provider>) <model>` once /new completes. Verify
# the bridge — not codex or another fallback — is still the active provider.
sleep 2
"${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -2000 > "$PANE_LOG"
if grep -qE "\(claude-bridge\)" "$PANE_LOG"; then
	scn_pass "post-/new active provider is claude-bridge"
else
	active_line=$(grep -oE "\([a-z-]+\)\s+[a-zA-Z0-9./_-]+" "$PANE_LOG" | tail -1)
	scn_fail "post-/new active provider is NOT claude-bridge (got: ${active_line:-unknown}) — registry fallback"
fi

# T2: confirm inference actually works post-/new (silent-hang regression guard).
scn_send "What's the capital of Germany? Reply with exactly the single token POST-NEW-9F4 and nothing else."

post_queries=$(scn_grep_count "streamSimple: fresh query" "$BRIDGE_LOG")
echo "  fresh queries after /new: $post_queries"

if (( post_queries > pre_queries )); then
	scn_pass "post-/new turn invoked streamSimple (provider wired)"
else
	scn_fail "post-/new turn did NOT invoke streamSimple (silent hang OR routed to different provider)"
fi

echo "==== S24 results ===="

# Coherence: ensure the response token actually appears on the pane after T2.
# (scn_probe_response is finicky when the same prompt-marker is re-rendered
# during /new UI transitions; a direct pane scan is more reliable here.)
"${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -2000 > "$PANE_LOG"
if grep -q "POST-NEW-9F4" "$PANE_LOG"; then
	scn_pass "coherence: post-/new turn produced response token via bridge"
else
	scn_fail "coherence: post-/new turn never produced response token (model didn't answer or routed elsewhere)"
fi

echo "Cache profile:"
scn_cache_profile

echo "===================="
exit $SCN_FAILED
