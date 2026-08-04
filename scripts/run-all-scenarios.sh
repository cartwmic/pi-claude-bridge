#!/usr/bin/env bash
# Run the explicit bridge scenario inventory for one or both inference drivers.
#
#   CLAUDE_BRIDGE_DRIVER=claude-p ./scripts/run-all-scenarios.sh
#   SCENARIO_DRIVERS="claude-p claude-print" ./scripts/run-all-scenarios.sh
#
# SCENARIO_PARALLEL controls concurrency (default 1). SCENARIO_FILTER is an
# optional regex matched against both the short name and "driver.name".
# Exit 77 from a scenario means an environment-based skip; skips are reported
# separately, never counted as passes, and fail the required suite unless
# SCENARIO_ALLOW_SKIPS=1 is explicitly set for exploratory local runs.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESULTS_DIR="${SCENARIO_RESULTS_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)/.test-output/scenarios}"
mkdir -p "$RESULTS_DIR"

SUMMARY="$RESULTS_DIR/SUMMARY.md"
PER_SCRIPT_TIMEOUT="${SCENARIO_TIMEOUT:-300}"
MAX_CONCURRENCY="${SCENARIO_PARALLEL:-1}"
OVERRIDES_FILE="$SCRIPT_DIR/scenario-overrides.conf"
DRIVER_WORDS="${SCENARIO_DRIVERS:-${CLAUDE_BRIDGE_DRIVER:-claude-print}}"
DRIVER_WORDS="${DRIVER_WORDS//,/ }"

# Binding inventory for parity work. S10b/S16a/S16b are named sub-scenarios;
# S31 is the large cold-start gate, S32 carries the sole peek exception, and
# S33 is intentionally scheduled only for claude-print (thinking visibility).
SCENARIO_INVENTORY=(
	run-scenario-s0.sh
	run-scenario-s1.sh
	run-scenario-s2.sh
	run-scenario-s3.sh
	run-scenario-s4.sh
	run-scenario-s5.sh
	run-scenario-s6.sh
	run-scenario-s7.sh
	run-scenario-s8.sh
	run-scenario-s9.sh
	run-scenario-s10.sh
	run-scenario-s10b.sh
	run-scenario-s11.sh
	run-scenario-s12.sh
	run-scenario-s13.sh
	run-scenario-s14.sh
	run-scenario-s15.sh
	run-scenario-s16a.sh
	run-scenario-s16b.sh
	run-scenario-s17.sh
	run-scenario-s18.sh
	run-scenario-s19.sh
	run-scenario-s20.sh
	run-scenario-s21-investigate.sh
	run-scenario-s22-investigate.sh
	run-scenario-s23.sh
	run-scenario-s24.sh
	run-scenario-s25-capture-during-turn.sh
	run-scenario-s26.sh
	run-scenario-s27.sh
	run-scenario-s31-large-cold-start-prompt.sh
	run-scenario-s32-claude-peek.sh
	run-scenario-s33-thinking-effort.sh
)

# Test-only fixture injection verifies pass/fail/skip propagation without live
# model calls. Production use cannot replace the binding inventory accidentally.
if [[ "${SCENARIO_RUNNER_TEST_MODE:-0}" == "1" ]]; then
	[[ -n "${SCENARIO_TEST_INVENTORY:-}" ]] || { echo "ERROR: test mode requires SCENARIO_TEST_INVENTORY" >&2; exit 2; }
	IFS=':' read -r -a SCENARIO_INVENTORY <<< "$SCENARIO_TEST_INVENTORY"
fi

inventory_path() {
	case "$1" in
		/*) printf '%s\n' "$1" ;;
		*) printf '%s/%s\n' "$SCRIPT_DIR" "$1" ;;
	esac
}

DRIVERS=()
for driver in $DRIVER_WORDS; do
	case "$driver" in
		claude-p|claude-print) DRIVERS+=("$driver") ;;
		*) echo "ERROR: unsupported scenario driver '$driver'" >&2; exit 2 ;;
	esac
done
[[ ${#DRIVERS[@]} -gt 0 ]] || { echo "ERROR: no scenario drivers selected" >&2; exit 2; }

for file in "${SCENARIO_INVENTORY[@]}"; do
	path="$(inventory_path "$file")"
	[[ -f "$path" ]] || { echo "ERROR: inventory entry missing: $path" >&2; exit 2; }
	[[ -x "$path" ]] || { echo "ERROR: inventory entry is not executable: $path" >&2; exit 2; }
done

cat > "$SUMMARY" <<EOF
# Scenario run — $(date -u +%Y-%m-%dT%H:%M:%SZ)

Drivers: ${DRIVERS[*]}
Inventory entries per driver: ${#SCENARIO_INVENTORY[@]}

EOF

lookup_override() {
	local want="$1"
	[[ -f "$OVERRIDES_FILE" ]] || { echo "-|-"; return; }
	while IFS='|' read -r name to_field model_field; do
		[[ -z "$name" || "$name" =~ ^[[:space:]]*# ]] && continue
		if [[ "$name" == "$want" ]]; then
			echo "${to_field:--}|${model_field:--}"
			return
		fi
	done < "$OVERRIDES_FILE"
	echo "-|-"
}

if command -v gtimeout >/dev/null 2>&1; then
	TIMEOUT_BIN=gtimeout
elif command -v timeout >/dev/null 2>&1; then
	TIMEOUT_BIN=timeout
else
	echo "ERROR: scenario runner requires gtimeout or timeout; refusing an unbounded required run" >&2
	exit 2
fi

run_one() {
	local driver="$1"
	local script="$2"
	local name="$3"
	local qualified="${driver}.${name}"
	local logfile="$RESULTS_DIR/${qualified}.run.log"
	local socket="pi-scn-${driver}-${name}-$$"
	local override scn_timeout scn_model effective_timeout rc

	override="$(lookup_override "$name")"
	scn_timeout="${override%%|*}"
	scn_model="${override##*|}"
	effective_timeout="$PER_SCRIPT_TIMEOUT"
	[[ "$scn_timeout" != "-" ]] && effective_timeout="$scn_timeout"

	set +e
	if [[ "$scn_model" != "-" ]]; then
		SCN_TMUX_SOCKET="$socket" CLAUDE_BRIDGE_DRIVER="$driver" SCENARIO_DRIVER="$driver" \
			env "SCENARIO_MODEL=$scn_model" "$TIMEOUT_BIN" --kill-after=10 "$effective_timeout" "$script" > "$logfile" 2>&1
	else
		SCN_TMUX_SOCKET="$socket" CLAUDE_BRIDGE_DRIVER="$driver" SCENARIO_DRIVER="$driver" \
			"$TIMEOUT_BIN" --kill-after=10 "$effective_timeout" "$script" > "$logfile" 2>&1
	fi
	rc=$?
	set -e

	tmux -L "$socket" kill-server 2>/dev/null || true
	case "$rc" in
		0) echo "PASS|$qualified" ;;
		77) echo "SKIP|$qualified" ;;
		124) echo "TIMEOUT|$qualified" ;;
		*) echo "FAIL|$qualified|$rc" ;;
	esac
}

JOB_DRIVERS=()
JOB_SCRIPTS=()
JOB_NAMES=()
for driver in "${DRIVERS[@]}"; do
	for file in "${SCENARIO_INVENTORY[@]}"; do
		script="$(inventory_path "$file")"
		name="$(basename "$script" .sh | sed 's/^run-scenario-//')"
		qualified="${driver}.${name}"
		# Do not manufacture a required-suite SKIP for known inapplicability in
		# the unfiltered matrix. An explicit filter targeting S33 still executes
		# the script so its claude-p exit 77 remains observable and qualified.
		if [[ "$name" == "s33-thinking-effort" && "$driver" != "claude-print" && -z "${SCENARIO_FILTER:-}" ]]; then
			continue
		fi
		if [[ -n "${SCENARIO_FILTER:-}" ]] && ! printf '%s\n%s\n' "$name" "$qualified" | grep -qE "$SCENARIO_FILTER"; then
			continue
		fi
		JOB_DRIVERS+=("$driver")
		JOB_SCRIPTS+=("$script")
		JOB_NAMES+=("$name")
	done
done
[[ ${#JOB_NAMES[@]} -gt 0 ]] || { echo "ERROR: scenario filter selected no inventory entries" >&2; exit 2; }

PASS=0
FAIL=0
TIMEOUT=0
SKIP=0

record_result() {
	local result="$1"
	local status="${result%%|*}"
	local rest="${result#*|}"
	local qualified="${rest%%|*}"
	case "$status" in
		PASS) PASS=$((PASS + 1)) ;;
		SKIP) SKIP=$((SKIP + 1)) ;;
		TIMEOUT) TIMEOUT=$((TIMEOUT + 1)) ;;
		*) FAIL=$((FAIL + 1)) ;;
	esac
	printf "%-46s %s\n" "$qualified" "$status"
	echo "## $qualified — $status" >> "$SUMMARY"
	if [[ "$status" != "PASS" ]]; then
		echo '```' >> "$SUMMARY"
		tail -40 "$RESULTS_DIR/${qualified}.run.log" 2>/dev/null >> "$SUMMARY" || true
		echo '```' >> "$SUMMARY"
	fi
	echo "" >> "$SUMMARY"
}

if (( MAX_CONCURRENCY <= 1 )); then
	for ((i=0; i<${#JOB_NAMES[@]}; i++)); do
		record_result "$(run_one "${JOB_DRIVERS[$i]}" "${JOB_SCRIPTS[$i]}" "${JOB_NAMES[$i]}")"
	done
else
	echo "Running with SCENARIO_PARALLEL=$MAX_CONCURRENCY"
	rm -f "$RESULTS_DIR"/.scenario-*.done "$RESULTS_DIR"/.scenario-*.result 2>/dev/null || true
	RUNNING_PIDS=()
	RUNNING_KEYS=()

	reap_completed() {
		local new_pids=() new_keys=() i pid key result
		for ((i=0; i<${#RUNNING_PIDS[@]}; i++)); do
			pid="${RUNNING_PIDS[$i]}"
			key="${RUNNING_KEYS[$i]}"
			if [[ -f "$RESULTS_DIR/.scenario-${key}.done" ]]; then
				wait "$pid" 2>/dev/null || true
				result="$(cat "$RESULTS_DIR/.scenario-${key}.result" 2>/dev/null || echo "FAIL|${key}|missing")"
				rm -f "$RESULTS_DIR/.scenario-${key}.result" "$RESULTS_DIR/.scenario-${key}.done"
				echo "$result" >> "$RESULTS_DIR/.scenario-results"
				printf "  done: %-40s %s\n" "$key" "${result%%|*}"
			else
				new_pids+=("$pid")
				new_keys+=("$key")
			fi
		done
		if [[ ${#new_pids[@]} -gt 0 ]]; then
			RUNNING_PIDS=("${new_pids[@]}")
			RUNNING_KEYS=("${new_keys[@]}")
		else
			RUNNING_PIDS=()
			RUNNING_KEYS=()
		fi
	}

	: > "$RESULTS_DIR/.scenario-results"
	for ((i=0; i<${#JOB_NAMES[@]}; i++)); do
		driver="${JOB_DRIVERS[$i]}"
		script="${JOB_SCRIPTS[$i]}"
		name="${JOB_NAMES[$i]}"
		key="${driver}.${name}"
		while (( ${#RUNNING_PIDS[@]} >= MAX_CONCURRENCY )); do sleep 1; reap_completed; done
		(
			r="$(run_one "$driver" "$script" "$name")"
			echo "$r" > "$RESULTS_DIR/.scenario-${key}.result"
			: > "$RESULTS_DIR/.scenario-${key}.done"
		) &
		RUNNING_PIDS+=("$!")
		RUNNING_KEYS+=("$key")
		printf "  start: %-40s pid=%s\n" "$key" "$!"
	done
	while (( ${#RUNNING_PIDS[@]} > 0 )); do sleep 1; reap_completed; done

	for ((i=0; i<${#JOB_NAMES[@]}; i++)); do
		key="${JOB_DRIVERS[$i]}.${JOB_NAMES[$i]}"
		result="$(grep -E "^[A-Z]+\|${key}(\||$)" "$RESULTS_DIR/.scenario-results" | head -1 || echo "FAIL|${key}|missing")"
		record_result "$result"
	done
	rm -f "$RESULTS_DIR/.scenario-results"
fi

echo ""
echo "Passed: $PASS  Skipped: $SKIP  Failed: $FAIL  Timeout: $TIMEOUT"
echo "Results: $SUMMARY"
if (( SKIP > 0 )) && [[ "${SCENARIO_ALLOW_SKIPS:-0}" != "1" ]]; then
	echo "Required scenario skip(s) make suite nonzero; use SCENARIO_ALLOW_SKIPS=1 only for exploratory local runs." >&2
	exit 1
fi
[[ $((FAIL + TIMEOUT)) -eq 0 ]]
