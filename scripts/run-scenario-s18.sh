#!/usr/bin/env bash
# Scenario S18 — Basic-tools smoke test.
# Exercises each pi-exposed tool (bash, read, write, edit) once in a fresh
# session. Each tool must be discovered and used correctly on first try
# (no retries, no fallbacks, no errors from the bridge handler).

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s18"

trap 'scn_pi_stop' EXIT

# Use a sandbox cwd so write/edit don't touch the repo.
SANDBOX="$OUT_DIR/s18-sandbox"
rm -rf "$SANDBOX"
mkdir -p "$SANDBOX"
echo "hello-original" > "$SANDBOX/seed.txt"
SCENARIO_CWD="$SANDBOX" scn_pi_start

# --- bash ---
scn_send "Run bash 'echo BASH-MARKER-7Q3'. Then tell me exactly what it printed."
scn_wait_for "BASH-MARKER-7Q3" 60 || scn_fail "bash: marker not echoed back"

# --- read ---
scn_send "Use the read tool on seed.txt and tell me its contents verbatim."
scn_wait_for "hello-original" 60 || scn_fail "read: file contents not surfaced"

# --- write ---
scn_send "Use the write tool to create new.txt with the exact contents 'WRITE-MARKER-K9F'. Confirm when done."
scn_wait_for "(created|wrote|done|written)" 60 || scn_fail "write: no completion ack"

# --- edit ---
scn_send "Use the edit tool on seed.txt to replace 'hello-original' with 'EDIT-MARKER-Z2P'. Confirm when done."
scn_wait_for "(replaced|edited|done|updated)" 60 || scn_fail "edit: no completion ack"

echo "==== S18 results ===="

# Verify each tool's handler fired exactly once on first attempt.
for tool in bash read write edit; do
	count=$(scn_grep_count "mcp handler: ${tool} " "$BRIDGE_LOG")
	echo "  ${tool} invocations: $count"
	if (( count >= 1 )); then
		scn_pass "${tool} discovered and invoked"
	else
		scn_fail "${tool} never invoked (model didn't discover the tool)"
	fi
done

# Verify the file artifacts on disk — proves the tools actually executed,
# not just that the model claimed to call them.
if [[ -f "$SANDBOX/new.txt" ]] && grep -q "WRITE-MARKER-K9F" "$SANDBOX/new.txt"; then
	scn_pass "write tool produced file with expected contents"
else
	scn_fail "write tool did not produce expected file"
fi

if grep -q "EDIT-MARKER-Z2P" "$SANDBOX/seed.txt" 2>/dev/null; then
	scn_pass "edit tool applied expected change"
else
	scn_fail "edit tool did not apply expected change"
fi

# No tool-result errors from the bridge handler path
if grep -qE "mcp handler:.*isError=true|tool error|handler threw" "$BRIDGE_LOG"; then
	scn_fail "tool handler reported error(s)"
else
	scn_pass "no tool handler errors"
fi

# Single warm session across all four turns
unique_sids=$(scn_session_count)
echo "  distinct CC session_ids: $unique_sids"
if [[ "$unique_sids" == "1" ]]; then
	scn_pass "session: 1 cached session_id (warm path across all tools)"
else
	scn_fail "session: expected 1, got $unique_sids"
fi

echo "Cache profile:"
scn_cache_profile

echo "===================="
rm -rf "$SANDBOX"
exit $SCN_FAILED
