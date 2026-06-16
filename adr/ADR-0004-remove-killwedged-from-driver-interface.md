# ADR-0004: Remove killWedged from the driver interface

**Status:** Accepted
**Date:** 2026-06-16
**Source change:** `openspec/changes/no-liveness-timeouts-add-visibility/`
**Supersedes:** None
**Superseded by:** None

## Context

`ClaudePHandle.killWedged()` existed to let the bridge watchdog kill a suspected wedged spawn and classify that termination as an error. After removing the idle watchdog, no approved caller remains. Leaving the method would preserve a speculative kill path that bypasses the new caller-driven recovery contract.

This is part of a breaking change: the bridge no longer exposes watchdog-driven termination as a driver behavior. Constitution VII is served by reducing implicit kill paths and keeping abnormal termination visible through real exits or caller abort.

4-point score: multiple viable approaches yes; lasting consequences yes; disagreement potential no; future constraints yes = **3/4**.

## Decision Drivers

- Keep the driver interface aligned with real callers.
- Remove the watchdog-only error-vs-aborted asymmetry.
- Avoid preserving speculative API surface after the only approved use is gone.
- Make `abort()` the sole caller-driven process termination method.

## Considered Options

### Option A: Delete `killWedged()`

Remove `ClaudePHandle.killWedged` from the interface, implementation, resilience wrapper forwarding, and failed-handle stub.

**Pros:**
- Eliminates unreachable API after watchdog removal.
- Clarifies that callers may abort but not declare a wedge.
- Reduces process lifecycle states to real exit or caller abort.

**Cons:**
- Any future auto-recovery policy would need a new explicit interface decision.

### Option B: Keep `killWedged()` for possible external callers

Retain the method even though no current non-watchdog caller exists.

**Pros:**
- Minimizes interface churn.
- Provides a ready hook if a future supervisor wants error-classified termination.

**Cons:**
- Preserves dead code and a speculative termination path.
- Conflicts with the no-liveness-timeouts direction.
- Makes it easier for future code to reintroduce wedge guessing without ADR review.

## Decision Outcome

**Chosen option:** Option A: Delete `killWedged()`

**Rationale:** With the watchdog gone, `killWedged()` has no approved caller. Keeping it would imply the driver still supports bridge-declared wedge termination, which this change explicitly removes.

## Consequences

**Positive:**
- Driver handle surface is smaller and clearer.
- Caller-driven abort remains the single intentional kill path.
- Natural premature exits still classify as errors and can retry through resilience.

**Negative:**
- Downstream code cannot request an error-classified wedge kill through this interface.

**Neutral:**
- Process-group abort teardown remains unchanged.
- No persisted state or spec capability changes outside `claude-p-driver`.

## Links

- Source design discussion: `openspec/changes/no-liveness-timeouts-add-visibility/design.md` (Decision D2)
- Related ADRs: ADR-0003, ADR-0005
- External references: None

---

<!--
IMMUTABILITY RULE: once this ADR is Accepted, do not edit the body. To
change a decision, create a new ADR and mark this one Superseded with
Superseded-by link → new ADR.

MADR 4.0 short form — see https://adr.github.io/madr/
-->
