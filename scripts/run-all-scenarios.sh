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

for s in "$SCRIPT_DIR"/run-scenario-s*.sh; do
	[[ -x "$s" ]] || continue
	name="$(basename "$s" .sh | sed 's/^run-scenario-//')"
	logfile="$RESULTS_DIR/${name}.run.log"
	printf "%-30s " "$name"
	if "$s" > "$logfile" 2>&1; then
		echo "PASS"
		echo "## $name — PASS" >> "$SUMMARY"
		((PASS++))
	else
		echo "FAIL"
		echo "## $name — FAIL" >> "$SUMMARY"
		echo '```' >> "$SUMMARY"
		tail -40 "$logfile" >> "$SUMMARY"
		echo '```' >> "$SUMMARY"
		((FAIL++))
	fi
	echo "" >> "$SUMMARY"
done

echo ""
echo "Passed: $PASS  Failed: $FAIL"
echo "Results: $SUMMARY"
[[ "$FAIL" -eq 0 ]]
