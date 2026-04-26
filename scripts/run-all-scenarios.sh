#!/usr/bin/env bash
# Run all available scenario scripts and produce a summary.
# Each individual scenario is in scripts/run-scenario-s<N>.sh.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESULTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/.test-output/scenarios"
mkdir -p "$RESULTS_DIR"

SUMMARY="$RESULTS_DIR/SUMMARY.md"
echo "# Scenario run — $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$SUMMARY"
echo "" >> "$SUMMARY"

PASS=0
FAIL=0

PER_SCRIPT_TIMEOUT="${SCENARIO_TIMEOUT:-300}"  # 5 min per scenario default

for s in "$SCRIPT_DIR"/run-scenario-s*.sh; do
	[[ -x "$s" ]] || continue
	name="$(basename "$s" .sh | sed 's/^run-scenario-//')"
	logfile="$RESULTS_DIR/${name}.run.log"
	printf "%-30s " "$name"
	# Use gtimeout if available (macOS coreutils), else timeout, else fallback.
	if command -v gtimeout >/dev/null 2>&1; then
		TIMEOUT_BIN=gtimeout
	elif command -v timeout >/dev/null 2>&1; then
		TIMEOUT_BIN=timeout
	else
		TIMEOUT_BIN=""
	fi
	if [[ -n "$TIMEOUT_BIN" ]]; then
		if "$TIMEOUT_BIN" --kill-after=10 "$PER_SCRIPT_TIMEOUT" "$s" > "$logfile" 2>&1; then
			echo "PASS"
			echo "## $name — PASS" >> "$SUMMARY"
			((PASS++))
		else
			rc=$?
			if (( rc == 124 )); then
				echo "TIMEOUT (>${PER_SCRIPT_TIMEOUT}s)"
				echo "## $name — TIMEOUT" >> "$SUMMARY"
			else
				echo "FAIL"
				echo "## $name — FAIL" >> "$SUMMARY"
			fi
			echo '```' >> "$SUMMARY"
			tail -40 "$logfile" >> "$SUMMARY"
			echo '```' >> "$SUMMARY"
			((FAIL++))
			# Cleanup any hanging tmux session for this script
			tmux kill-server 2>/dev/null || true
		fi
	else
		# No timeout available — run unbounded (may hang)
		if "$s" > "$logfile" 2>&1; then
			echo "PASS"; echo "## $name — PASS" >> "$SUMMARY"; ((PASS++))
		else
			echo "FAIL"; echo "## $name — FAIL" >> "$SUMMARY"
			echo '```' >> "$SUMMARY"; tail -40 "$logfile" >> "$SUMMARY"; echo '```' >> "$SUMMARY"
			((FAIL++))
		fi
	fi
	echo "" >> "$SUMMARY"
done

echo ""
echo "Passed: $PASS  Failed: $FAIL"
echo "Results: $SUMMARY"
[[ "$FAIL" -eq 0 ]]
