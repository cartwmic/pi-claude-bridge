#!/usr/bin/env bash
# run-opus-realistic.sh — run a curated set of REALISTIC scenarios with the model
# the user actually uses (opus-4-7), SEQUENTIALLY (claude-p concurrency-1 rule).
# For each: capture pass/fail + whether a tool-protocol leak fired in the bridge log
# + how many real tool round-trips routed. This finds where opus tool calling breaks.
set -uo pipefail
cd "$(dirname "$0")/.."
MODEL="claude-bridge/claude-opus-4-7"
OUT=".test-output/scenarios"
SCENS=("$@")
[ ${#SCENS[@]} -eq 0 ] && SCENS=(s0 s2 s6 s8 s9)

printf "%-6s %-8s %-7s %-7s %s\n" "scen" "verdict" "leaks" "routed" "note"
printf "%-6s %-8s %-7s %-7s %s\n" "----" "-------" "-----" "------" "----"
for s in "${SCENS[@]}"; do
  script="scripts/run-scenario-$s.sh"
  [ -f "$script" ] || { printf "%-6s %-8s\n" "$s" "MISSING"; continue; }
  SCENARIO_MODEL="$MODEL" timeout 420 "$script" >"$OUT/$s.run.out" 2>&1
  rc=$?
  log="$OUT/$s.bridge.log"
  leaks=0; routed=0
  if [ -f "$log" ]; then
    leaks=$(grep -c "toolProtocolLeak" "$log" 2>/dev/null || echo 0)
    routed=$(grep -c "onRouterPark: routed tools/call" "$log" 2>/dev/null || echo 0)
  fi
  verdict="PASS"; [ "$rc" -ne 0 ] && verdict="FAIL($rc)"
  note=""
  grep -qE "^  FAIL:" "$OUT/$s.run.out" 2>/dev/null && note=$(grep -m1 -E "^  FAIL:" "$OUT/$s.run.out" | sed 's/^  FAIL: //' | cut -c1-60)
  printf "%-6s %-8s %-7s %-7s %s\n" "$s" "$verdict" "$leaks" "$routed" "$note"
done
echo "(per-scenario stdout: $OUT/<s>.run.out ; bridge logs: $OUT/<s>.bridge.log)"
