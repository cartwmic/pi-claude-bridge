#!/usr/bin/env bash
# Scenario S19 — Tool-id queue integrity (regression for off-by-one bug).
#
# Bug it guards against: when the SDK emits a tool_use block for a built-in
# tool (ToolSearch, Skill, etc.), our bridge used to push that id onto the
# shared FIFO toolUseIdQueue. The SDK doesn't route built-ins through our
# MCP handlers, so the id never gets shifted off — leaving stale ids that
# poison subsequent calls to OUR handlers. Result: every tool result is
# delivered to the WRONG tool_use_id, lag-by-one across the whole session.
#
# This scenario:
#   - Runs pi WITH a session file (no --no-session) so we can cross-check
#     pi's recorded toolCallId↔toolName pairs against the bridge's
#     `mcp handler: <name> [<id>]` log lines.
#   - Issues a sequence of bash calls with unique sentinel outputs and a
#     read of a known file. Asks the model to repeat each output verbatim.
#   - Asserts: every bridge `mcp handler:` invocation has a (name, id) pair
#     that matches pi's record for that id. A mismatch = the queue gave
#     the handler a stale id from a different tool.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s19"

# Opus for deterministic tool-calling on the directive prompts.
SCENARIO_MODEL="${S19_MODEL:-claude-bridge/claude-opus-4-7}"

trap 'scn_pi_stop_with_session' EXIT

# Sandbox cwd so pi's session file is isolated and easy to find.
SANDBOX="$OUT_DIR/s19-sandbox"
rm -rf "$SANDBOX"
mkdir -p "$SANDBOX"
# Pi canonicalizes cwd before deriving its session directory. Match that path
# when repository was entered through a symlink (for example ~/git → /Volumes).
SANDBOX="$(cd "$SANDBOX" && pwd -P)"
echo "S19-SEED-CONTENT-XK7" > "$SANDBOX/known.txt"

SESSION_DIR_NAME="--$(echo "$SANDBOX" | sed 's|^/||; s|/|-|g')--"
PI_SESSION_DIR="$HOME/.pi/agent/sessions/$SESSION_DIR_NAME"
rm -rf "$PI_SESSION_DIR" 2>/dev/null || true

# Custom pi start: drop --no-session so a JSONL is persisted under
# $PI_SESSION_DIR. Mirrors scn_pi_start otherwise.
scn_pi_start_with_session() {
	"${TMUX_CMD[@]}" new-session -d -s "$SESSION" -x 200 -y 50 \
		"cd '$SANDBOX' && CLAUDE_BRIDGE_DEBUG=1 CLAUDE_BRIDGE_DEBUG_PATH='$BRIDGE_LOG' \
		 PATH='$PATH' pi -ne -e '$REPO_DIR' --provider claude-bridge --model '$SCENARIO_MODEL'"
	scn_wait_ready
}

scn_pi_stop_with_session() {
	scn_pi_stop
	rm -rf "$SANDBOX" 2>/dev/null || true
}

scn_pi_start_with_session

# Three sequential bash calls with distinct sentinel outputs + a read of a
# known file. Each turn forces a single tool call so the model's response
# refers to that tool's specific output verbatim.
scn_send "Run bash 'echo S19-A-MARKER-Q1' and tell me the exact output verbatim, nothing else."
scn_wait_for "S19-A-MARKER-Q1" 60 || scn_fail "bash#A: marker not echoed back"

scn_send "Run bash 'echo S19-B-MARKER-Q2' and tell me the exact output verbatim, nothing else."
scn_wait_for "S19-B-MARKER-Q2" 60 || scn_fail "bash#B: marker not echoed back"

scn_send "Use the read tool on known.txt and tell me its exact contents verbatim."
scn_wait_for "S19-SEED-CONTENT-XK7" 60 || scn_fail "read: file contents not surfaced"

scn_send "Run bash 'echo S19-C-MARKER-Q3' and tell me the exact output verbatim, nothing else."
scn_wait_for "S19-C-MARKER-Q3" 60 || scn_fail "bash#C: marker not echoed back"

echo "==== S19 results ===="

# Pi may defer session persistence until shutdown. Stop the owned session before
# inspecting its JSONL, then use a bounded poll for the final filesystem flush.
scn_pi_stop
# Session is already stopped and pane captured. Avoid a second stop in EXIT,
# which would truncate the retained pane log when tmux session no longer exists.
trap 'rm -rf "$SANDBOX" 2>/dev/null || true' EXIT
latest_session=""
for _ in {1..20}; do
	latest_session=$(ls -t "$PI_SESSION_DIR"/*.jsonl 2>/dev/null | head -1 || true)
	[[ -n "$latest_session" ]] && break
	sleep 0.25
done
if [[ -z "$latest_session" ]]; then
	scn_fail "could not locate pi session JSONL under $PI_SESSION_DIR"
	echo "===================="
	exit $SCN_FAILED
fi
echo "  pi session: $latest_session"

# Cross-check: every bridge `mcp handler: <name> [<id>]` line must agree
# with pi's record (id → toolName). If the queue gave a handler a stale
# id from a different tool, name(handler) ≠ name(pi[id]) → mismatch.
mismatches=$(python3 - "$latest_session" "$BRIDGE_LOG" <<'PY'
import json, re, sys

session_path, bridge_log = sys.argv[1:]
# 1) build id → toolName map from pi's JSONL
pi_id_to_name = {}
for line in open(session_path):
    d = json.loads(line)
    if d.get("type") != "message": continue
    m = d.get("message", {})
    if m.get("role") == "assistant":
        for b in m.get("content", []):
            if b.get("type") == "toolCall":
                pi_id_to_name[b["id"]] = b.get("name")

# 2) scan bridge log for tool-routing lines on EITHER driver.
#    SDK path:     `mcp handler: <name> [<toolu_...id>]` — id is the SDK
#                  toolUseId, which pi also records as the toolCall id.
#    claude-p path: `onRouterPark: routed tools/call ...` carrying JSON
#                  fields {"piId":"pi-...","name":"<tool>"}. The piId is
#                  the router-minted id that pi echoes back as toolResult.id,
#                  so pi's JSONL records it as the toolCall id too.
#    Either way the invariant is the same: handler/router (id → name) must
#    agree with pi's (id → name). A disagreement = stale-id queue poisoning.
mismatches = []
matched_any = 0
pat = re.compile(r"mcp handler: (\S+) \[(toolu_[A-Za-z0-9]+)\]")
for line in open(bridge_log):
    try:
        rec = json.loads(line)
    except Exception:
        continue
    msg = rec.get("msg", "")
    handler_name = handler_id = None
    # SDK dialect.
    mo = pat.search(msg)
    if mo:
        handler_name, handler_id = mo.group(1), mo.group(2)
    # claude-p dialect: structured fields on the onRouterPark line.
    elif "onRouterPark: routed tools/call" in msg:
        handler_name = rec.get("name")
        handler_id = rec.get("piId")
    if not handler_id:
        continue
    matched_any += 1
    pi_name = pi_id_to_name.get(handler_id)
    if pi_name is None:
        mismatches.append(("ORPHAN", handler_name, handler_id, "<not in pi JSONL>"))
    elif pi_name != handler_name:
        mismatches.append(("MISMATCH", handler_name, handler_id, pi_name))

for m in mismatches:
    print("  " + " | ".join(str(x) for x in m))
print(f"  routed tool calls cross-checked: {matched_any}")
print(f"COUNT={len(mismatches)}")
PY
)
echo "$mismatches"
mismatch_count=$(echo "$mismatches" | grep -oE "COUNT=[0-9]+" | head -1 | cut -d= -f2)
mismatch_count=${mismatch_count:-0}
if (( mismatch_count == 0 )); then
	scn_pass "tool-id queue integrity: every handler invocation matches pi's id↔name record"
else
	scn_fail "tool-id queue integrity: $mismatch_count handler invocation(s) had stale/mismatched ids"
fi

# No "NO toolUseId in queue" errors.
if grep -q "NO toolUseId in queue" "$BRIDGE_LOG"; then
	scn_fail "saw 'NO toolUseId in queue' (BUG) in bridge log"
else
	scn_pass "no 'NO toolUseId in queue' errors"
fi

# Built-in tool_use observations (defense check): if Claude tried to emit
# ToolSearch/Skill, the warning would fire. After DISALLOWED_BUILTIN_TOOLS
# update + queue-skip, neither path should pollute the queue regardless.
builtins_seen=$(grep -c "built-in tool_use observed" "$BRIDGE_LOG" 2>/dev/null || true)
builtins_seen=${builtins_seen:-0}
echo "  built-in tool_use observations skipped from queue: $builtins_seen"
if (( builtins_seen == 0 )); then
	scn_pass "no built-in tool_use leaked through to processStreamEvent"
else
	scn_pass "built-in tool_use observed and correctly skipped from queue ($builtins_seen times)"
fi

echo "Cache profile:"
scn_cache_profile

echo "===================="
exit $SCN_FAILED
