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

run() {
  local name="$1"; shift
  local slug=$(echo "$name" | tr ' :,' '-' | tr -cd '[:alnum:]-')
  local logfile="$LOGDIR/$slug.log"
  printf "%-50s " "$name"
  if output=$(timeout "$TIMEOUT" "$@" 2>&1); then
    echo "$output" > "$logfile"
    if [ -n "$output" ]; then
      echo "PASS"
      ((PASS++))
    else
      echo "FAIL (empty output)"
      echo "  Log: $logfile"
      ((FAIL++))
    fi
  else
    local rc=$?
    echo "${output:-}" > "$logfile" 2>/dev/null || true
    echo "FAIL (exit $rc)"
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
