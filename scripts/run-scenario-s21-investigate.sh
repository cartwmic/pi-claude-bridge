#!/usr/bin/env bash
# Scenario S21 (investigation) — Steer arrives while a long tool is running.
#
# Reproduces the user's session-019dcb97 pattern using a long bash sleep
# instead of a real subagent (same shape: parent SDK blocked on MCP handler;
# pi sends a new user message mid-flight; bridge supersede case 3 fires).
# This is INVESTIGATION mode — it dumps a structured timeline so we can
# see exactly what the bridge did and whether the parent's resolver was
# drained synthetic-style or got the real tool output.
#
# What we want to learn:
#   1. Does pi's signal fire onAbort on the parent frame when only a steer
#      was typed (no Escape)?
#   2. If so, how long after the steer does it fire?
#   3. Does pi eventually deliver the real bash result, and if so, does it
#      arrive before or after the synthetic "interrupted by user" drain?
#   4. Which Case (1/2/3) handles the late real result?
#   5. What does the model see in the next turn — synthetic interrupt text
#      or the real bash output?

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

scn_setup "s21"
trap 'scn_pi_stop' EXIT
scn_pi_start

START_TS=$(date +%s)
ts_rel() { local now=$(date +%s); echo "+$((now - START_TS))s"; }

echo "[$(ts_rel)] T1: dispatching long bash (sleep 12 + echo MARKER)"
tmux send-keys -t "$SESSION:0" -- "Run this exact bash command and tell me its output: 'sleep 12 && echo S21-DONE-MARKER-XK7'"
tmux send-keys -t "$SESSION:0" Enter

# Wait until pi has dispatched the tool and we're in the mid-execution window.
deadline=$((SECONDS + 30))
while (( SECONDS < deadline )); do
	if grep -q "mcp handler: bash .* awaiting pi" "$BRIDGE_LOG" 2>/dev/null; then break; fi
	sleep 0.5
done
echo "[$(ts_rel)] T1: bash handler awaiting pi (in mid-execution window)"

# Capture stack/state before steer
sleep 2
echo "[$(ts_rel)] T2: typing STEER (no Escape — just a new user message)"
tmux send-keys -t "$SESSION:0" -- "Briefly: when you reply, also use python next time."
tmux send-keys -t "$SESSION:0" Enter
STEER_TS=$(date +%s)
echo "[$(ts_rel)] T2: steer sent (will not press Escape)"

# Let things settle. Don't use scn_send because we want to observe the natural
# completion behavior, not bound it ourselves.
sleep 25

echo "[$(ts_rel)] T3: settling complete; sending coherence probe"
scn_send "Be specific and brief: did the bash 'sleep 12' actually print S21-DONE-MARKER-XK7, or was it interrupted before completing? Quote any output you saw verbatim."

echo ""
echo "==== S21 timeline analysis ===="
python3 <<EOF
import json, re

bridge = "$BRIDGE_LOG"
steer_ts = $STEER_TS

events = []
for line in open(bridge):
    try:
        d = json.loads(line)
    except Exception:
        continue
    msg = d.get("msg", "")
    keep = any(k in msg for k in [
        "fresh query", "superseding", "onAbort", "tool-result delivery",
        "early result", "awaiting pi", "caching session", "pushAbortedError",
        "orphaned tool result", "consumeQuery: error",
    ])
    if not keep: continue
    events.append((d.get("time",""), d.get("level"), d.get("ccSessionId","--------"), msg))

# Print all events with offset relative to steer
import datetime
def parse_ts(s):
    return datetime.datetime.fromisoformat(s.replace("Z","+00:00")).timestamp()

print(f"steer was sent at offset 0  (bridge log time after steer keypress)")
print(f"{'rel-to-steer':>14}  {'lvl':>3}  {'cc':>8}  msg")
print("-" * 100)
for t, lvl, cc, msg in events:
    try:
        rel = parse_ts(t) - steer_ts
        rel_s = f"{rel:+8.3f}s"
    except Exception:
        rel_s = "       ?"
    print(f"{rel_s:>14}  L{lvl}  {cc[:8]:>8}  {msg[:120]}")

# Did the bash REALLY finish? Look for the marker anywhere in the bridge log.
print()
import subprocess
r = subprocess.run(["grep", "-c", "S21-DONE-MARKER-XK7", bridge], capture_output=True, text=True)
hits = int((r.stdout or "0").strip())
print(f"Bash sentinel S21-DONE-MARKER-XK7 occurrences in bridge log: {hits}")
print(f"  (If >0, pi delivered the real bash output to the bridge.")
print(f"   If 0, pi never delivered the result — either bash was killed or the result was orphaned silently.)")

# Did parent's resolver get drained with synthetic text?
r2 = subprocess.run(["grep", "-c", "interrupted by user", bridge], capture_output=True, text=True)
synth = int((r2.stdout or "0").strip())
print(f"Synthetic 'interrupted by user' drains: {synth}")

# Was there a supersede + onAbort pair?
r3 = subprocess.run(["grep", "-cE", "(superseding active frame|onAbort:)", bridge], capture_output=True, text=True)
abort_events = int((r3.stdout or "0").strip())
print(f"Supersede/onAbort events total: {abort_events}")
EOF

echo ""
echo "==== Coherence: what did the model say? ===="
resp=$(scn_probe_response "did the bash 'sleep 12' actually print")
echo "$resp" | head -c 800
echo ""
echo ""
echo "==== End S21 ===="
exit 0
