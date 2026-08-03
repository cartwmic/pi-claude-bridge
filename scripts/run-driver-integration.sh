#!/usr/bin/env bash
# Authenticated two-driver integration contract. Requires working Claude auth.
# Set DRIVER_INTEGRATION_DRIVERS to one driver for focused diagnosis.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

DRIVER_WORDS="${DRIVER_INTEGRATION_DRIVERS:-claude-p claude-print}"
DRIVER_WORDS="${DRIVER_WORDS//,/ }"
DRIVERS=()
for driver in $DRIVER_WORDS; do
	case "$driver" in
		claude-p|claude-print) DRIVERS+=("$driver") ;;
		*) echo "ERROR: unsupported integration driver '$driver'" >&2; exit 2 ;;
	esac
done
[[ ${#DRIVERS[@]} -gt 0 ]] || { echo "ERROR: no integration drivers selected" >&2; exit 2; }

npm run build

for driver in "${DRIVERS[@]}"; do
	echo "==== authenticated RPC contract: $driver ===="
	CLAUDE_BRIDGE_DRIVER="$driver" node --import tsx --test --test-concurrency=1 \
		tests/int-claude-p-main-turn.mjs \
		tests/int-claude-p-tool-round.mjs \
		tests/int-claude-p-abort.mjs
	CLAUDE_BRIDGE_DRIVER="$driver" RUN_REAL_CLAUDE_DRIVER=1 \
		node --import tsx --test --test-concurrency=1 \
			tests/int-claude-p-capture-success.mjs \
			tests/int-claude-p-capture-error.mjs

	echo "==== authenticated idle/death contract: $driver ===="
	CLAUDE_BRIDGE_DRIVER="$driver" SCENARIO_DRIVER="$driver" \
		"$REPO_DIR/scripts/run-scenario-s28-timeout-held-round.sh"
	CLAUDE_BRIDGE_DRIVER="$driver" SCENARIO_DRIVER="$driver" \
		"$REPO_DIR/scripts/run-scenario-s29-timeout-driver-death.sh"
done

# Existing live scenarios provide load-bearing lifecycle and isolation coverage:
# RPC abort also proves dangling-call warm recovery. Scenarios cover S0/S10b
# warm text/cache, S10 durable restart resume, S2 sequential tools, S8 held-tool
# abort recovery, S11 parallel tools, S14 concurrent
# same-provider subagents, S15 cross-provider nested overlap, S19 D32 tool-id
# correlation, S20 abort/resume fidelity, S25 capture during a
# main turn, S26 sustained cache/process cleanup, S27 native-tool isolation,
# and S31 readiness-gated large direct input.
SCENARIO_DRIVERS="${DRIVERS[*]}" \
SCENARIO_FILTER='^(s0|s2|s8|s10|s10b|s11|s14|s15|s19|s20|s25-capture-during-turn|s26|s27|s31-large-cold-start-prompt)$' \
	"$REPO_DIR/scripts/run-all-scenarios.sh"
