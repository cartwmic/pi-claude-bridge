#!/usr/bin/env bash
# Scenario S22 (investigation) — Steer arrives during a non-claude-bridge subagent.
#
# Mirrors the user's session-019dcb97 setup as closely as possible:
#   - Parent runs on claude-bridge model.
#   - Parent dispatches a subagent that uses a NON-claude-bridge provider
#     (openai-codex/gpt-5.4-mini), so the subagent's model calls never go
#     through our bridge.
#   - Mid-subagent, user types a steer (no Escape — just a new user message).
#   - We capture the full bridge timeline and inspect:
#       * Did case 3 supersede fire? On which frame (top vs deeper)?
#       * Did parent's onAbort fire (and how long after the steer)?
#       * Was parent's pendingResolver drained synthetic-style?
#       * Did pi eventually deliver the real subagent tool_result, and if
#         so, was it Case 1 (resolved cleanly) or Case 2 (orphaned)?
#       * What did the model see in the next turn?

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

scn_setup "s22"

# Locate the subagent extension (same lookup as S15).
SUBAGENT_PATH=""
for cand in \
	"$HOME/.pi/agent/git/github.com/cartwmic/pi-subagents" \
	"$HOME/.pi/agent/git/github.com/badlogic/pi-subagents" \
	"$HOME/git/pi-subagents"; do
	if [[ -f "$cand/index.ts" ]] || [[ -f "$cand/package.json" ]]; then
		SUBAGENT_PATH="$cand"; break
	fi
done
if [[ -z "$SUBAGENT_PATH" ]]; then
	echo "  SKIP: pi-subagents not installed"
	exit 0
fi

trap 'scn_pi_stop' EXIT

# Start pi with both this bridge and pi-subagents loaded.
# Use opus to mirror the user's session profile (haiku tends to ramble
# without calling the subagent tool, breaking the repro).
S22_MODEL="${S22_MODEL:-claude-bridge/claude-opus-4-7}"
"${TMUX_CMD[@]}" new-session -d -s "$SESSION" -x 200 -y 50 \
	"cd '$SCENARIO_CWD' && CLAUDE_BRIDGE_DEBUG=1 CLAUDE_BRIDGE_DEBUG_PATH='$BRIDGE_LOG' \
	 pi --no-session -ne -e '$REPO_DIR' -e '$SUBAGENT_PATH' --provider claude-bridge --model '$S22_MODEL'"

# Poll until pi has finished its startup banner — the input area is ready
# only after the bottom prompt line appears.
deadline=$((SECONDS + 30))
while (( SECONDS < deadline )); do
	if "${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -50 2>/dev/null | grep -qE "claude-bridge.*claude-opus|claude-bridge.*claude-haiku"; then
		break
	fi
	sleep 0.5
done
sleep 2  # extra breath

START_TS=$(date +%s)
ts_rel() { local now=$(date +%s); echo "+$((now - START_TS))s"; }

# A subagent task that takes long enough for us to steer mid-flight.
# Asking gpt-5.4-mini to write a long detailed multi-section file is slow
# enough (typically 30-60s) and gives the bash log a clear sentinel via
# the file it writes.
echo "[$(ts_rel)] T1: dispatching long-running subagent (gpt-5.4-mini)"
# Verify pi prompt is interactive: type a single space, capture, then erase.
	"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" " "
sleep 0.5
ready_check=$("${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -5 | tr -d ' \n')
if [[ -z "$ready_check" ]]; then
	echo "[$(ts_rel)] WARN: pi prompt not echoing — input area may not be focused"
fi
	"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" BSpace

PROMPT='Call the subagent tool with agent=worker model=openai-codex/gpt-5.4-mini task: write a 2000-word essay on file system history in 10 numbered sections of 200+ words each, save to /tmp/s22-essay.txt, then return only S22-DONE-MARKER-XYZ. Call once, no list action.'
	"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" -l "$PROMPT"
sleep 1
	"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" Enter
sleep 4
echo "[$(ts_rel)] T1 pane snapshot after send:"
"${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -30 | tail -15

# Wait specifically for a SUBAGENT tool route. The old probe also matched any
# generic `onRouterPark: routed tools/call` (for example `bash`), then a
# subagent-specific grep pipeline failed under `set -euo pipefail` and exited the
# scenario before the target condition was reached.
subagent_route_re='("name":"(mcp__custom-tools__)?subagent".*(router: parked tools/call|onRouterPark: routed tools/call))|((router: parked tools/call|onRouterPark: routed tools/call).*"name":"(mcp__custom-tools__)?subagent")|mcp handler: subagent .* awaiting pi'
deadline=$((SECONDS + 180))
saw_awaiting=0
awaiting_id=""
while (( SECONDS < deadline )); do
	subagent_line=$(grep -E "$subagent_route_re" "$BRIDGE_LOG" 2>/dev/null | tail -1 || true)
	if [[ -n "$subagent_line" ]]; then
		saw_awaiting=1
		awaiting_id=$(printf '%s\n' "$subagent_line" | grep -oE "(toolu|pi)-[A-Za-z0-9_-]+" | tail -1 || true)
		[[ -n "$awaiting_id" ]] || awaiting_id="subagent-route"
		echo "[$(ts_rel)] subagent [$awaiting_id] is pending/routed"
		break
	fi
	# Periodic pane snapshot for live visibility.
	if (( SECONDS % 15 == 0 )); then
		echo "[$(ts_rel)] still waiting; pane tail:"
	"${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -10 2>/dev/null | tail -8 | sed 's/^/    /'
	fi
	sleep 2
done
echo "[$(ts_rel)] tool handler events so far:"
grep -E "mcp handler:|router: parked tools/call|onRouterPark: routed tools/call" "$BRIDGE_LOG" 2>/dev/null | tail -10 || echo "  (no handlers)"
if (( saw_awaiting == 0 )); then
	echo "[$(ts_rel)] WARN: parent never dispatched a long-running subagent tool. Pane:"
	scn_capture | tail -30
	exit 0
fi
echo "[$(ts_rel)] T1: parent has dispatched subagent; bridge handler awaiting pi (subagent now running independently in pi → codex CLI)"

# Wait a bit more so the subagent is well into its work but not done.
sleep 8

echo "[$(ts_rel)] T2: pressing Escape to enter steer-mode, then typing the steer message"
# Pi default queues new messages during active turn; Escape transitions to
# steer-mode and lets the subsequent Enter act as a real steer (matches S5
# pattern and the user's reported flow once we account for pi's defaults).
	"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" Escape
sleep 1
	"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" -- "While you're at it: when the subagent finishes, also count the words in the file."
	"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" Enter
STEER_TS=$(date +%s)
echo "[$(ts_rel)] T2: steer sent (with Escape preceding)"

# Let the subagent complete naturally. Codex 2000-word write usually finishes within ~60s.
# Don't issue any other prompts; observe what the bridge does on its own.
echo "[$(ts_rel)] T3: settling for 90s (let subagent finish + bridge process the steer)"
sleep 90

echo "[$(ts_rel)] T4: assertions are bridge-log-based (model-side coherence probes are non-deterministic in this scenario because pi may dispatch another subagent for the steer turn, which takes minutes)"

echo ""
echo "==== S22 timeline analysis ===="
python3 <<EOF
import json, datetime
bridge = "$BRIDGE_LOG"
steer_ts = $STEER_TS

events = []
for line in open(bridge):
    try: d = json.loads(line)
    except Exception: continue
    msg = d.get("msg", "")
    keep = any(k in msg for k in [
        "fresh query", "superseding", "onAbort", "tool-result delivery",
        "early result", "awaiting pi", "caching session", "pushAbortedError",
        "orphaned tool result", "consumeQuery: error", "interrupted by user",
        "history divergence",
    ])
    if not keep: continue
    events.append((d.get("time",""), d.get("level"), d.get("ccSessionId","--------"), msg))

def parse_ts(s):
    try: return datetime.datetime.fromisoformat(s.replace("Z","+00:00")).timestamp()
    except Exception: return None

print(f"Steer offset = 0  ; events shown relative to steer keypress")
print(f"{'rel':>10}  {'lvl':>3}  {'cc':>8}  msg")
print("-" * 100)
for t, lvl, cc, msg in events:
    rel = parse_ts(t)
    rel_s = f"{(rel - steer_ts):+8.3f}s" if rel else "      ?"
    print(f"{rel_s:>10}  L{lvl}  {cc[:8]:>8}  {msg[:130]}")
print()

# Did the subagent actually write the file?
import os
print(f"/tmp/s22-essay.txt exists: {os.path.exists('/tmp/s22-essay.txt')}", end="")
if os.path.exists('/tmp/s22-essay.txt'):
    sz = os.path.getsize('/tmp/s22-essay.txt')
    print(f"  size={sz} bytes")
else:
    print()

# Did the marker reach the bridge log (i.e. was it in any tool_result delivered to the parent)?
import subprocess
hits = subprocess.run(["grep", "-c", "S22-DONE-MARKER-XYZ", bridge], capture_output=True, text=True)
n = int((hits.stdout or "0").strip())
print(f"S22-DONE-MARKER-XYZ in bridge log: {n}")

# Was parent's resolver drained with synthetic text?
synth = subprocess.run(["grep", "-c", "interrupted by user", bridge], capture_output=True, text=True)
ns = int((synth.stdout or "0").strip())
print(f"Synthetic 'interrupted by user' drains: {ns}")

# How many distinct CC session_ids did the bridge handle?
sids = subprocess.run(["bash", "-c", f"grep -oE 'caching session=[a-f0-9]+' {bridge} | sort -u | wc -l | tr -d ' '"], capture_output=True, text=True)
print(f"Distinct bridge CC session_ids: {sids.stdout.strip()}")
EOF

echo ""
echo "==== End S22 ===="

# Assertions (Option H regression guard):
#
# Before Option H: when Escape fires onAbort while a subagent is running,
# the bridge synthetically resolves the parent's pending subagent-tool
# resolver with "[Tool execution interrupted by user...]". Pi then
# delivers the real subagent result milliseconds later — but it's
# orphan-pathed and discarded. The model on the next turn reads the
# synthetic text and concludes the subagent failed.
#
# After Option H: onAbort should NOT pre-drain pendingResolvers. When
# pi delivers the real tool_result (Case 1 or via orphan-path lookup
# across all frames), the resolver gets the real content. The synthetic
# drain only fires later, when pi sends a fresh user turn (Case 3),
# unblocking the SDK with honest "user superseded" attribution AFTER
# we've given pi's already-in-flight delivery a chance to land.
#
# Concrete signals in the bridge log:
SCN_FAILED=0
# grep -c returns 1 when no matches — under set -euo pipefail this aborts
# the script, so we trap it with `|| echo 0`. No pipe-to-head; grep -c
# already outputs a single number.
synth_drains=$(grep -c "resolved.*pending tool handler.*interrupted by user" "$BRIDGE_LOG" 2>/dev/null || true)
synth_drains=${synth_drains:-0}
orphan_aborts=$(grep -c "pushAbortedError: orphan tool result post-abort" "$BRIDGE_LOG" 2>/dev/null || true)
orphan_aborts=${orphan_aborts:-0}
echo "  synthetic resolver drains: $synth_drains"
echo "  orphan-tool-result aborted-pushes: $orphan_aborts"

# After Option H, when the abort window AND a real tool_result are racing,
# the orphan path should look up the buried frame's resolver and resolve
# with real content rather than push aborted. So orphan_aborts == 0 for
# this scenario shape (where pi DID deliver a real result post-abort).
if (( orphan_aborts == 0 )); then
	scn_pass "no orphan-result-post-abort discard (real tool_result reached the resolver)"
else
	scn_fail "orphan tool_result was discarded — real subagent output never reached the model"
fi

# Architectural: onAbort must log the deferred-drain marker — confirming
# we took the Option H path and didn't pre-drain pendingResolvers.
if grep -qE "deferred drain" "$BRIDGE_LOG"; then
	scn_pass "onAbort took deferred-drain path (Option H)"
else
	scn_fail "onAbort did NOT defer drain — pendingResolvers were drained synchronously"
fi

# Architectural: a tool-result delivery line must appear AFTER the onAbort
# event with `1 resolvers waiting` (or similar non-zero) — proving the
# resolver was still alive when pi delivered the real subagent result.
post_abort_delivery=$(awk '
	/onAbort/ { seen_abort=1 }
	seen_abort && /tool-result delivery.*[1-9][0-9]* resolvers waiting/ { print; exit }
' "$BRIDGE_LOG")
if [[ -n "$post_abort_delivery" ]]; then
	scn_pass "post-abort tool-result delivery matched a still-pending resolver (real subagent output reached the SDK)"
else
	scn_fail "no post-abort tool-result delivery with waiting resolver — real subagent output was lost"
fi

# Cleanup essay file (keep around briefly in case we want to inspect)
sleep 1
rm -f /tmp/s22-essay.txt
exit $SCN_FAILED
