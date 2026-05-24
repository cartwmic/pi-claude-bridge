# ADR-0009: Abort lifecycle — PTY torn down, router-state preserved for late tool-result reconciliation

**Status:** Accepted
**Date:** 2026-05-24
**Source change:** `openspec/changes/archive/2026-05-24-replace-sdk-with-pty-tui/`

## Context

When pi aborts a turn mid-flight, the bridge must:
1. Stop the inference run cleanly (kill the PTY without orphan processes)
2. Preserve conversation coherence: if pi's executor finishes a tool round 200ms AFTER the user aborts, the resulting `tool_result` IS canonical history pi expects on the next turn.

The current bridge (pre-v1.0.0 SDK path) at `index.ts:1008-1016` + `1260-1336` already preserved aborted frames' router state for this reason. The PTY-driven design must preserve the same semantics.

Additionally: `claude`'s documented hook contract does NOT guarantee `Stop` fires when the model run is interrupted by the user.

## Decision Drivers

- Conversation coherence (late tool results must reconcile into next turn's context)
- No orphan PTY processes after abort
- Decouple abort completion from `Stop` firing (which may never come on user-aborted turns)
- Constitution VII: failures surface (abort-related errors logged explicitly)

## Considered Options

### Option A: PTY torn down via SIGINT+Esc-Esc, router state preserved
- PTY side: SIGINT + Esc-Esc keystroke (whichever wins), 3s grace, SIGKILL escalation. Transcript tailer flips to `aborted` mode, drains buffered lines, emits final `done(reason: "aborted")`, closes.
- Router side: per-frame `pendingResolvers` + `pendingResults` stays alive until ONE of: (a) pi delivers a `toolResult` via next `streamSimple()` (router stashes it; included in next-turn cold-start replay), (b) pi sends a new user message (drained synthetically, frame popped), (c) `clearSession` event drains.

**Pros:** preserves pre-v1.0.0 coherence semantics. PTY/shim cleanly terminated; router-side bookkeeping survives until pi resolves ambiguity. No race on `Stop` (which may never come).
**Cons:** router state must be managed across the abort boundary (tested by D15 + the `int-pty-abort-late-tool-result.mjs` integration test).

### Option B: Drop late-tool-result handling
PTY + router all torn down on abort.

**Pros:** simpler.
**Cons:** regression vs current behavior (Round-2 B.P1#3 surfaced this). Pi's tool result from the in-flight executor would be lost, leading to next-turn confusion.

### Option C: Wait for `Stop` always; treat absence as an error
**Pros:** uniform code path.
**Cons:** user aborts are a normal path. Treating them as errors floods logs. Rejected.

### Option D: PTY exit detection only (no SIGINT)
**Pros:** simplest teardown.
**Cons:** fails if the TUI hangs waiting for input. Rejected.

## Decision Outcome

**Chosen option:** A — PTY teardown via SIGINT+Esc-Esc; router state preserved for late-tool-result reconciliation.

**Rationale:** decouples abort completion from `Stop` firing AND preserves the bridge's existing late-tool-result coherence semantics. PTY/shim ARE torn down (the inference run is over); router-side bookkeeping survives until pi resolves the ambiguity. Tested end-to-end by `int-pty-abort-late-tool-result.mjs` and scenario s27-subagent-abort.

## Consequences

**Positive:**
- No orphan PTY processes (3s SIGKILL escalation)
- Late tool results reconcile into next-turn context
- Decoupled from upstream `Stop` reliability
- Scenario s27-subagent-abort verifies parent + subagent PTY both cleaned up

**Negative:**
- Router state lifecycle is more complex than "torn down on abort"
- Bridge must distinguish "post-abort PTY exit" (expected) from "spontaneous PTY exit" (error)
- `Stop` payload received post-abort is logged at info level and otherwise ignored

**Neutral:**
- 3s grace window is empirically sufficient for `claude` to respond to SIGINT
- New spec AC `claude-tui-driver.abort-preserves-late-tool-result-coherence`

## Links

- Source design discussion: `openspec/changes/archive/2026-05-24-replace-sdk-with-pty-tui/design.md` (Decision D15)
- Related ADRs: ADR-0004 (transcript tailer flips to `aborted` mode), ADR-0001 (PTY driver)
- Verification: `tests/int-pty-abort-late-tool-result.mjs`, `scripts/run-scenario-s27-subagent-abort.sh`
