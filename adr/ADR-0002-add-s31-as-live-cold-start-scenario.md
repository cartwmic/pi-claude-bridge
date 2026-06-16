# ADR-0002: Add S31 as a live cold-start scenario

**Status:** Accepted
**Date:** 2026-06-16
**Source change:** `openspec/changes/claude-p-paste-fix-guard/`
**Supersedes:** None
**Superseded by:** None

## Context

The paste-collapse failure occurred on first-turn cold start before any driver session cache existed. Existing scenario prompts topped out below the observed 801-byte failure threshold, so they did not prove end-to-end large-prompt delivery through the full tmux → pi → bridge → claude-p → Ink → model path.

The change adds S31, a live scenario that starts fresh with `pi --no-session`, sends a first prompt larger than 800 bytes, and verifies both mechanical bridge signals and model-level delivery.

## Decision Drivers

- Cover the exact path that failed: first-turn cold start with no cached session.
- Prove the full live driver chain, not only local string matching.
- Keep regression evidence loud when `PromptNotAccepted` reappears.
- Balance live-scenario cost against the need for end-to-end evidence.
- Reuse the existing scenario harness and metadata conventions.

## Considered Options

### Option A: Live S31 cold-start scenario

Create `scripts/run-scenario-s31-large-cold-start-prompt.sh` using `scenario-lib.sh`, `pi --no-session`, an opus model default, a prompt over 1500 bytes, bridge-log assertions, and response coherence checks.

**Pros:**
- Exercises the full live path that failed.
- Verifies both no `PromptNotAccepted` and completed claude-p turn lifecycle.
- Captures model-level delivery evidence with a sentinel response.
- Fits the existing scenario suite shape.

**Cons:**
- Live scenario can fail from transient boot/network issues.
- Opus default increases runtime/cost unless `SCENARIO_MODEL` overrides it.

### Option B: Unit-test-only fixture

Add a unit test for prompt or marker handling without running a live pi/claude-p scenario.

**Pros:**
- Faster and less flaky.
- Cheaper to run in normal test loops.

**Cons:**
- Cannot prove tmux → pi → bridge → claude-p → Ink → model delivery.
- Does not cover first-turn session-cache absence.
- Could pass while the live driver path still rejects paste-collapse prompts.

### Option C: Warm-resume large-prompt scenario

Exercise a large prompt after a session cache already exists.

**Pros:**
- Covers large prompt delivery in an ongoing session.
- May be easier to make stable after initial boot.

**Cons:**
- Misses the cold-start path that failed.
- Does not prove first prompt delivery before any cached driver session exists.

## Decision Outcome

**Chosen option:** Option A: Live S31 cold-start scenario

**Rationale:** The missing acceptance evidence is live end-to-end delivery on the first prompt. S31 anchors the regression at the path and size threshold that failed, while keeping the assertion mechanics consistent with existing scenario infrastructure.

## Consequences

**Positive:**
- Regression suite now covers large first-prompt delivery through the live claude-p driver path.
- Failures surface mechanically through bridge logs and coherently through the assistant response.
- Scenario metadata documents the regression class.

**Negative:**
- S31 adds live-scenario runtime and possible transient failure modes.
- The default opus model can increase scenario cost unless overridden.

**Neutral:**
- S31 is verification coverage only; it does not change bridge production behavior.

## Links

- Source design discussion: `openspec/changes/claude-p-paste-fix-guard/design.md` (Decision D2)
- Related ADRs: ADR-0001
- External references: None

---

<!--
IMMUTABILITY RULE: once this ADR is Accepted, do not edit the body. To
change a decision, create a new ADR and mark this one Superseded with
Superseded-by link → new ADR.

MADR 4.0 short form — see https://adr.github.io/madr/
-->
