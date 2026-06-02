#!/usr/bin/env bash
# Smoke tests for pi-claude-bridge provider.
# Requires: pi CLI, the `claude` + `claude-p` binaries (claude-p drives the turn).

source "$(dirname "$0")/lib/bash-setup.sh"

echo "=== smoke-test.sh ==="

setup_test_env "smoke-test"

# claude-p adds ~5s interactive-boot per turn vs the old SDK path and may retry a
# transient StopTimeout (D33), so a single provider turn needs more headroom than the
# SDK's 60s. Override via SMOKE_TEST_TIMEOUT.
TIMEOUT="${SMOKE_TEST_TIMEOUT:-150}"
PASS=0
FAIL=0

trap kill_descendants EXIT

# claude-p 0.1.0 intermittently hangs/StopTimeouts on an individual turn (documented
# runtime reliability limitation; the persistent-process follow-up is the long-term fix).
# A single provider turn occasionally exit-124s here. Retry up to SMOKE_ATTEMPTS times —
# the established mitigation (the scenario harness + the other int tests retry similarly).
SMOKE_ATTEMPTS="${SMOKE_ATTEMPTS:-3}"
run() {
  local name="$1"; shift
  local slug=$(echo "$name" | tr ' :,' '-' | tr -cd '[:alnum:]-')
  local logfile="$LOGDIR/$slug.log"
  printf "%-50s " "$name"
  local attempt output rc ok=0
  for attempt in $(seq 1 "$SMOKE_ATTEMPTS"); do
    if output=$(timeout "$TIMEOUT" "$@" 2>&1) && [ -n "$output" ]; then
      ok=1; break
    fi
    rc=$?
    kill_descendants
    [ "$attempt" -lt "$SMOKE_ATTEMPTS" ] && sleep 2
  done
  if [ "$ok" -eq 1 ]; then
    echo "$output" > "$logfile"
    [ "$attempt" -gt 1 ] && echo -n "(attempt $attempt) "
    echo "PASS"
    ((PASS++))
  else
    echo "${output:-}" > "$logfile" 2>/dev/null || true
    echo "FAIL (exit ${rc:-?}, ${SMOKE_ATTEMPTS} attempts)"
    echo "  Log: $logfile"
    ((FAIL++))
  fi
  kill_descendants
}

# --- Tests ---

run "provider: print mode responds" \
  pi --no-session -ne -e "$DIR" \
  --model "claude-bridge/claude-sonnet-4-6" \
  -p "Reply with just the word 'yes'"

run "provider: --provider flag works" \
  pi --no-session -ne -e "$DIR" \
  --provider claude-bridge \
  -p "Reply with just the word 'yes'"

run "provider: model list includes provider" \
  bash -c "pi --no-session -ne -e '$DIR' --list-models 2>&1 | grep claude-bridge"

# --- Summary ---

echo ""
echo "Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
