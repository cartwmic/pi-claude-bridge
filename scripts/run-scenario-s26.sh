#!/usr/bin/env bash
# Scenario S26 — Sustained warm prompt-cache across many turns (gate G4).
#
# User story: across a long conversation, every warm turn must READ the
# server-side prompt cache rather than re-CREATE it. The claude-p driver
# spawns a fresh `claude` process per pi turn; the risk is that per-spawn
# interactive injections (skill-listing/attachment, ai-title,
# file-history-snapshot, dynamic system-prompt sections) perturb the cached
# prefix and force a full-prefix cache CREATION every turn (cost + latency).
#
# This is the pi-TUI-level regression guard for that failure mode.
#
# Regression class caught: a driver swap that silently busts the prompt-cache
# prefix turn-over-turn. Mechanical-only "we didn't crash" misses it; the
# usage cache numbers are the only signal.
#
# Cross-driver: passes on both SDK and claude-p — both log `usage: ...
# cacheRead=N cacheWrite=M` and a per-turn fresh-query/spawn line.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "s26"

trap 'scn_pi_stop' EXIT

scn_pi_start

# Turn 1: cold start — cache CREATION expected, no read yet.
scn_send "My favorite number is 137. Acknowledge it briefly."
scn_wait_for "(137|favorite|noted|acknowledge)" 60 || scn_fail "Turn 1 failed"

# Turns 2..6: five short warm follow-ups within the cache TTL. Each plants a
# fact so the final coherence probe has something to recall.
scn_send "and my favorite color is octarine. Acknowledge."
scn_wait_for "(octarine|color|noted|acknowledge)" 60 || scn_fail "Turn 2 failed"

scn_send "and my pet is a fremen mouse. Acknowledge."
scn_wait_for "(fremen|mouse|pet|noted|acknowledge)" 60 || scn_fail "Turn 3 failed"

scn_send "Quick filler turn 4 — just say 'turn 4 ok'."
scn_wait_for "(turn 4|ok)" 60 || scn_fail "Turn 4 failed"

scn_send "Quick filler turn 5 — just say 'turn 5 ok'."
scn_wait_for "(turn 5|ok)" 60 || scn_fail "Turn 5 failed"

scn_send "Quick filler turn 6 — just say 'turn 6 ok'."
scn_wait_for "(turn 6|ok)" 60 || scn_fail "Turn 6 failed"

# Turn 7: coherence probe — recall the three planted facts.
scn_send "List the three facts I told you (number, color, pet)."
scn_wait_for "137" 60 || scn_fail "Turn 7 — facts not returned"

echo "==== S26 results ===="

# Architectural: 1 cold-start + >=5 warm-resumes on a single session id.
cold=$(scn_cold_count)
warm=$(scn_warm_resume_count)
echo "  cold-starts: $cold  warm-resumes: $warm"
if (( cold == 1 && warm >= 5 )); then
	scn_pass "1 cold + >=5 warm resumes (sustained-conversation contract)"
else
	scn_fail "expected 1 cold + >=5 warm, got $cold cold + $warm warm"
fi

unique_sids=$(scn_session_count)
if [[ "$unique_sids" == "1" ]]; then
	scn_pass "session: 1 cached session_id across all turns (no churn)"
else
	scn_fail "session: expected 1, got $unique_sids"
fi

echo "Cache profile (per usage line):"
scn_cache_profile

# THE GATE (G4): warm turns must show cacheRead>0. A turn with cacheRead=0 on a
# warm resume means claude-p busted the prefix and re-created the cache cold.
#
# Count usage lines whose cacheRead is a positive integer (>=1). With 1 cold +
# >=5 warm turns we expect at least 5 usage lines carrying cacheRead>0.
warm_reads=$(scn_grep_count "\"msg\":\"usage:.*cacheRead=[1-9][0-9]*" "$BRIDGE_LOG")
echo "  usage lines with cacheRead>0: $warm_reads"
if (( warm_reads >= 5 )); then
	scn_pass "G4: >=5 warm turns sustained cacheRead>0 (prompt-cache READ, not re-created cold)"
else
	scn_fail "G4: only $warm_reads turns had cacheRead>0 — claude-p busted the cache prefix (expected >=5)"
fi

# Guard against the inverse failure: a cold-start re-creation EVERY turn would
# show cacheWrite >> cacheRead on the warm turns. We at least require that the
# warm cache READs are non-trivial relative to a pure cold series. Done above
# via warm_reads>=5; the cache profile is printed for manual provenance.

# Coherence: all three planted facts must appear in the final response.
resp=$(scn_probe_response "List the three facts")
if echo "$resp" | grep -qiE "137" && echo "$resp" | grep -qiE "octarine" && echo "$resp" | grep -qiE "fremen|mouse"; then
	scn_pass "coherence: turn 7 recalled all three facts (137, octarine, fremen mouse)"
else
	scn_fail "coherence: turn 7 did NOT recall all three facts"
fi

echo "===================="
exit $SCN_FAILED
