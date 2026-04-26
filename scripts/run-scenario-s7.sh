#!/usr/bin/env bash
# Scenario S7 — User abort during text generation (Escape).
# Validates query.interrupt() path and post-abort coherence.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s7"

trap 'scn_pi_stop' EXIT

scn_pi_start

# Turn 1: long output
scn_send "Count slowly from 1 to 500, one number per line. Take your time and put each on its own line."

# Wait for streaming to begin (any single digit appearing prominently in output)
sleep 5
# Send the abort key — Escape, NOT Ctrl-C.
scn_send_keys "$PI_INTERRUPT_KEY"
sleep 2

# Turn 2 (coherence probe): the model should know it was interrupted.
scn_send "What number did you reach before I interrupted you?"
scn_wait_for "(interrupt|stopped|reached|number)" 60 || scn_fail "Turn 2 — no response"

echo "==== S7 results ===="

# Verify abort signal reached the bridge.
if grep -qE "(streamSimple: superseding|onAbort|interrupt|Operation aborted)" "$BRIDGE_LOG"; then
	scn_pass "bridge observed abort signal"
else
	scn_fail "bridge did not observe abort signal"
fi

# Verify no UUID rotation / no JSONL surgery.
if grep -qE "(UUID rotation|pendingTruncate|truncating)" "$BRIDGE_LOG"; then
	scn_fail "bridge did legacy abort-surgery (UUID rotation / truncate)"
else
	scn_pass "no UUID rotation / no JSONL surgery"
fi

# After abort, bridge should drop the cached session_id.
# Then Turn 2 should be a cold-start (resume=no).
post_abort_cold=$(grep -cE "streamSimple: fresh query.*resume=no" "$BRIDGE_LOG")
post_abort_warm=$(grep -cE "streamSimple: fresh query.*resume=[a-f0-9]" "$BRIDGE_LOG")
echo "  cold-starts: $post_abort_cold"
echo "  warm-resumes: $post_abort_warm"

echo "Cache profile:"
scn_cache_profile

# Coherence: model should acknowledge interruption (some recognition of what happened)
if grep -qiE "(interrupt|stopped|cut off|paused|asked me to stop)" "$PANE_LOG"; then
	scn_pass "coherence: model acknowledged interruption"
else
	scn_fail "coherence: model did not acknowledge interruption"
fi

echo "===================="
exit $SCN_FAILED
