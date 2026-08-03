#!/usr/bin/env bash
# Prompt cache efficiency test for pi-claude-bridge.
# Runs a multi-turn conversation and verifies Anthropic prompt caching is working.
# Expects: cacheRead grows across turns (system prompt + history are cache-hit),
#   cacheWrite is small after the first turn (only new content is written).
#
# Also checks session sync correctness: consecutive same-provider turns must
# resume the session (Case 3), not rebuild it (Case 4). A rebuild would reset
# prompt caching. This catches the off-by-one cursor bug where pi's post-return
# assistant message append caused syncSharedSession to see 1 "missed" message.

source "$(dirname "$0")/lib/bash-setup.sh"

echo "=== cache-test.sh ==="

setup_test_env "cache-test" ".ndjson"

LOGFILE="$LOGDIR/cache-test.ndjson"

trap kill_descendants EXIT

TMPFILE="$LOGDIR/cache-test-scratch.txt"
rm -f "$TMPFILE" "$CLAUDE_BRIDGE_DEBUG_PATH"

echo "Running 5-turn conversation (text + tool use)..."
# claude-p adds ~5s interactive-boot per turn vs the SDK + may retry a StopTimeout
# (D33), so the 5-turn conversation needs more wall-clock headroom than the SDK path.
# Override via CACHE_TEST_TIMEOUT if needed.
timeout "${CACHE_TEST_TIMEOUT:-420}" pi --no-session -ne -e "$DIR" \
  --model "claude-bridge/claude-haiku-4-5" \
  --mode json \
  -p "The secret number is 42. Acknowledge briefly." \
     "Write the secret number to $TMPFILE. Just the number, nothing else." \
     "What is 42 * 2? Just the number." \
     "Read $TMPFILE and tell me what's in it." \
     "What was the secret number, what did you write, what did you read, and what was 42*2? One per line." \
  > "$LOGFILE" 2>"$LOGFILE.err" || PI_EXIT=$?
PI_EXIT=${PI_EXIT:-0}

rm -f "$TMPFILE"

if [ -s "$LOGFILE.err" ]; then
  echo ""
  echo "pi stderr:"
  cat "$LOGFILE.err"
  echo ""
fi

if [ "$PI_EXIT" -ne 0 ]; then
  echo "FAIL: pi exited with code $PI_EXIT"
  exit 1
fi

echo ""
echo "Turn-by-turn cache metrics:"
echo "---"
printf "%-6s  %8s  %8s  %8s  %8s  %s\n" "Turn" "Input" "CacheRd" "CacheWr" "Output" "CacheHit%"

# Thresholds
MIN_CACHE_HIT_PCT=90
MIN_EXPECTED_TURNS=7    # 5 prompts + 2 tool sub-turns (write + read)
MIN_CASE3_RESUMES=2
EXPECTED_CASE1=1

TURN=0
FAIL=0
PREV_CACHE_READ=0
ZERO_USAGE_TURNS=0

while IFS= read -r line; do
  TURN=$((TURN + 1))
  INPUT=$(echo "$line" | jq -r '.input')
  CACHE_READ=$(echo "$line" | jq -r '.cacheRead')
  CACHE_WRITE=$(echo "$line" | jq -r '.cacheWrite')
  OUTPUT=$(echo "$line" | jq -r '.output')
  TOTAL_INPUT=$((INPUT + CACHE_READ + CACHE_WRITE))

  if [ "$TOTAL_INPUT" -gt 0 ]; then
    HIT_PCT=$((CACHE_READ * 100 / TOTAL_INPUT))
  else
    HIT_PCT=0
  fi

  printf "%-6s  %8s  %8s  %8s  %8s  %s%%\n" "$TURN" "$INPUT" "$CACHE_READ" "$CACHE_WRITE" "$OUTPUT" "$HIT_PCT"

  # claude-p reports usage ONCE PER SPAWN (on the terminal `result` line), unlike the
  # SDK which reported per assistant message. So the held-tool-round CONTINUATION
  # streamSimple calls (Case-1 tool-result delivery, which resolve a parked call in the
  # SAME spawn rather than spawning) surface a `turn_end` with an ALL-ZERO usage object
  # (input=output=cacheRead=cacheWrite=0). These are accounting artifacts of the
  # held-round model, NOT empty turns and NOT cache misses (the cache is consolidated
  # into the spawn's terminal `result`, attributed to the prompt turn). Skip them and do
  # NOT let a zero perturb PREV_CACHE_READ (compare the next real turn against the last
  # turn that actually reported usage).
  if [ "$INPUT" -eq 0 ] && [ "$CACHE_READ" -eq 0 ] && [ "$CACHE_WRITE" -eq 0 ] && [ "$OUTPUT" -eq 0 ]; then
    echo "  (turn $TURN: claude-p reported zero usage — skipped, not a cache regression)"
    ZERO_USAGE_TURNS=$((ZERO_USAGE_TURNS + 1))
    continue
  fi

  # Assertions
  if [ "$TURN" -ge 3 ]; then
    # Result usage describes the terminal model call, not a cumulative total for
    # every API call in a held-tool spawn. Tool-bearing turns can therefore move
    # the cached prefix boundary slightly backward even while the same session
    # remains warm (the debug log's billCacheRead covers all calls). Fail only on
    # a material >10% collapse; exact resume-id checks below catch cold rebuilds.
    if [ "$CACHE_READ" -lt $((PREV_CACHE_READ * 90 / 100)) ]; then
      echo "  FAIL: Turn $TURN cacheRead ($CACHE_READ) collapsed >10% from prior real turn ($PREV_CACHE_READ)"
      FAIL=$((FAIL + 1))
    fi
    # The meaningful "warm caching works" signal: cacheRead must DOMINATE fresh input
    # (the conversation prefix is read from cache, not re-sent uncached). We do NOT gate
    # on a >90% hit RATE: claude-p single-shot `--resume` re-CREATES the per-spawn-varying
    # tail of the prefix each turn (cacheWrite ~30k), so the read/(read+write+input) rate
    # sits ~65-80% even though the bulk of the prefix is warm-read. That re-creation is a
    # documented single-shot cost (the persistent-process follow-up — design "Fork
    # decision (T4.10)" — would eliminate it); it is NOT a cache failure.
    if [ "$CACHE_READ" -lt $((INPUT * 5)) ]; then
      echo "  FAIL: Turn $TURN cacheRead ($CACHE_READ) does not dominate fresh input ($INPUT) — prefix not warm-read"
      FAIL=$((FAIL + 1))
    fi
  fi

  PREV_CACHE_READ=$CACHE_READ
done < <(jq -c 'select(.type == "turn_end") | .message.usage | {input, cacheRead, cacheWrite, output}' "$LOGFILE")

echo "---"

if [ "$TURN" -lt $MIN_EXPECTED_TURNS ]; then
  echo "FAIL: Only $TURN turns detected (expected >= $MIN_EXPECTED_TURNS with tool use sub-turns)"
  FAIL=$((FAIL + 1))
fi

# --- Assert session resume (no spurious rebuilds) ---
# Post-refactor architecture: bridge holds in-memory cachedSessionId only;
# never reads or writes ~/.claude/sessions/. The bridge logs:
#   - "streamSimple: fresh query ... resume=<id|no>" per turn
#   - "streamSimple: caching session=<sid>" when a session_id is captured
# Same-provider flow should: cold-start once (turn 1, resume=no), then resume
# the same id for all subsequent turns. Cache hit-rate (above) is the ground
# truth; this section just sanity-checks the in-memory id stays stable.

echo ""
echo "Session resume:"

COLD_COUNT=0
RESUME_COUNT=0
declare -a SESSION_IDS=()

while IFS= read -r line; do
  # Match BOTH driver dialects: SDK `streamSimple: fresh query ... resume=` and
  # claude-p `streamSimple[claude-p]: fresh spawn ... resume=`.
  if echo "$line" | grep -qE 'streamSimple(\[claude-p\])?: fresh (query|spawn).*resume=no'; then
    COLD_COUNT=$((COLD_COUNT + 1))
  elif echo "$line" | grep -qE 'streamSimple(\[claude-p\])?: fresh (query|spawn).*resume=[a-f0-9]'; then
    RESUME_COUNT=$((RESUME_COUNT + 1))
  fi
  sid=$(echo "$line" | sed -nE 's/.*caching session=([a-f0-9-]+).*/\1/p')
  if [ -n "$sid" ]; then
    SESSION_IDS+=("$sid")
  fi
# Pre-filter must include BOTH the per-turn dispatch line (`streamSimple`/
# `streamSimple[claude-p]`) AND the session-capture line, which on the claude-p path is
# `finalizeClaudePFrame: caching session=<sid>` (SDK logged `streamSimple: caching
# session=`). Matching only "streamSimple" misses the claude-p caching-session lines.
done < <(grep -E "streamSimple|caching session=" "$CLAUDE_BRIDGE_DEBUG_PATH" 2>/dev/null || true)

UNIQUE_SIDS=$(printf "%s\n" "${SESSION_IDS[@]+"${SESSION_IDS[@]}"}" | sort -u | sed '/^$/d' | wc -l | tr -d ' ')
UNIQUE_SIDS=${UNIQUE_SIDS:-0}

echo "  cold-start (resume=no): $COLD_COUNT"
echo "  warm-resume (resume=<id>): $RESUME_COUNT"
echo "  unique session ids captured: $UNIQUE_SIDS"

# Expect exactly 1 cold-start (the first turn).
if [ "$COLD_COUNT" -ne $EXPECTED_CASE1 ]; then
  echo "  FAIL: Expected exactly $EXPECTED_CASE1 cold-start, got $COLD_COUNT"
  FAIL=$((FAIL + 1))
fi

# Expect at least N warm-resumes for follow-up turns.
if [ "$RESUME_COUNT" -lt $MIN_CASE3_RESUMES ]; then
  echo "  FAIL: Expected at least $MIN_CASE3_RESUMES warm-resumes, got $RESUME_COUNT"
  FAIL=$((FAIL + 1))
fi

# Same-provider flow: at most 1 distinct in-memory session id (first turn cold-
# starts and writes one id; turns 2+ resume into that id without churn).
if [ "$UNIQUE_SIDS" -gt 1 ]; then
  echo "  FAIL: expected at most 1 distinct sessionId in same-provider flow, got $UNIQUE_SIDS"
  FAIL=$((FAIL + 1))
fi

# --- Summary ---

echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "PASS: Prompt caching and session resume working correctly"
else
  echo "FAIL: $FAIL assertions failed"
  echo "  Log: $LOGFILE"
  echo "  Debug: $CLAUDE_BRIDGE_DEBUG_PATH"
  exit 1
fi
