# ADR-0003: Remove the idle watchdog with no replacement timer

**Status:** Accepted
**Date:** 2026-06-16
**Source change:** `openspec/changes/no-liveness-timeouts-add-visibility/`
**Supersedes:** None
**Superseded by:** None

## Context

The bridge previously ran an idle watchdog around each `claude-p` spawn. If stdout was silent for the configured idle window and no tool round was held, the watchdog killed the process group through `killWedged()` and classified the turn as retry-eligible. This was a bridge-side liveness guess rather than a real driver outcome.

The owner principle for `no-liveness-timeouts-add-visibility` is no liveness or wedge timeouts. Recovery is caller-driven abort through pi's existing abort path, while real subprocess exits still flow through the resilience layer. Constitution VII favors surfaced, explicit failure over silent degradation; Constitution III remains unchanged because no new user-global Claude paths are involved.

4-point score: multiple viable approaches yes; lasting consequences yes; disagreement potential yes; future constraints yes = **4/4**.

## Decision Drivers

- Remove silent guess-and-kill behavior from the bridge.
- Preserve retry on real pre-tool subprocess exits.
- Keep caller-driven abort as the only non-exit recovery mechanism.
- Avoid a default-disabled watchdog footgun that future changes could re-enable.
- Make hangs observable through diagnostics rather than hidden timer policy.

## Considered Options

### Option A: Delete the idle watchdog

Remove `makeWatchdog`, `WATCHDOG_IDLE_MS`, watchdog frame state, `.poke()`/`.stop()` calls, and `onWedge` wiring.

**Pros:**
- Implements the no-liveness-timeouts principle directly.
- Removes silent heuristic termination.
- Forces recovery policy to remain explicit and caller-driven.
- Shrinks moving parts around turn lifecycle.

**Cons:**
- A true indefinite hang with no subprocess exit and no caller abort can block until an operator or caller intervenes.
- Boot hangs that never exit are no longer auto-killed by the bridge.

### Option B: Keep the watchdog but default-disable it

Leave the code in place with an idle window of zero or unset by default.

**Pros:**
- Preserves an easy rollback knob.
- Keeps the old recovery path available for operators who want it.

**Cons:**
- Leaves dead liveness code in the turn lifecycle.
- Keeps a re-enable footgun that contradicts the owner principle.
- Makes future behavior harder to reason about.

### Option C: Replace with a larger idle window

Raise the idle threshold to make false positives less likely.

**Pros:**
- Retains automatic recovery for some silent hangs.
- Reduces accidental kills compared with a shorter window.

**Cons:**
- Still guesses liveness from elapsed silence.
- Still risks killing legitimate long-running or parked work.
- Does not satisfy the no-liveness-timeouts principle.

## Decision Outcome

**Chosen option:** Option A: Delete the idle watchdog

**Rationale:** Real boot failures already surface as subprocess exits and remain retry-eligible. True hangs should be handled by caller-driven abort plus diagnostics, not a bridge timer guessing that silence means wedged.

## Consequences

**Positive:**
- No bridge-side idle timer can kill a healthy `claude-p` spawn.
- Retry behavior is tied to real error-classified exits.
- Turn lifecycle loses watchdog-specific state and wiring.

**Negative:**
- Infinite no-output/no-exit hangs require external/caller intervention.
- Operators lose the old `CLAUDE_BRIDGE_WATCHDOG_IDLE_MS` control.

**Neutral:**
- Existing abort semantics and process-group teardown remain the recovery path.
- No new `~/.claude/` access is introduced.

## Links

- Source design discussion: `openspec/changes/no-liveness-timeouts-add-visibility/design.md` (Decision D1)
- Related ADRs: ADR-0004, ADR-0005, ADR-0006, ADR-0007
- External references: None

---

<!--
IMMUTABILITY RULE: once this ADR is Accepted, do not edit the body. To
change a decision, create a new ADR and mark this one Superseded with
Superseded-by link → new ADR.

MADR 4.0 short form — see https://adr.github.io/madr/
-->
