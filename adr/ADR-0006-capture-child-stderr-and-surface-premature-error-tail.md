# ADR-0006: Capture child stderr and surface premature-error tail

**Status:** Accepted
**Date:** 2026-06-16
**Source change:** `openspec/changes/no-liveness-timeouts-add-visibility/`
**Supersedes:** None
**Superseded by:** None

## Context

With liveness timers removed, abnormal driver behavior must be observable enough for reactive recovery and root-cause analysis. `claude-p` and upstream Anthropic errors surface important information on stderr, but the bridge previously logged only a truncated first chunk and did not persist full per-spawn stderr or include useful stderr context in the pi error event.

This decision adds visibility without changing stdout parsing. Constitution VII requires failures to surface; domain event flow requires stdout to remain clean NDJSON.

4-point score: multiple viable approaches yes; lasting consequences yes; disagreement potential yes; future constraints no = **3/4**.

## Decision Drivers

- Make premature driver exits self-describing in pi without requiring log spelunking.
- Preserve `claude-p` stdout as the NDJSON event channel.
- Persist full per-spawn stderr for RCA.
- Keep diagnostics best-effort so logging failures never fail a turn.
- Bound user-visible stderr context to avoid noisy unbounded errors.

## Considered Options

### Option A: Per-spawn stderr file plus bounded error tail

Append child stderr to a per-spawn bridge-owned debug file, keep a bounded in-memory line ring, and include the last lines in premature-exit errors.

**Pros:**
- Gives durable diagnostics and immediate user-visible cause.
- Keeps stdout untouched.
- Bounded tail prevents unbounded error payloads.
- File write failure can degrade to a structured log without failing the turn.

**Cons:**
- Adds per-spawn diagnostic files that may accumulate.
- Requires maintaining ring-buffer and file-write plumbing.

### Option B: Persist stderr only

Write stderr to a per-spawn file but do not include a tail in the error event.

**Pros:**
- Keeps stream error messages short.
- Still preserves full stderr for postmortem.

**Cons:**
- Common failures like `PromptNotAccepted` require opening a separate file.
- Less aligned with the goal that failures surface directly.

### Option C: Tee stderr into the bridge logger per line

Write child stderr lines to the normal bridge log rather than a dedicated file and error tail.

**Pros:**
- Uses existing logging infrastructure.
- Avoids separate stderr file naming and lifecycle.

**Cons:**
- Interleaves noisy upstream output with structured bridge logs.
- Does not make the active pi error event self-describing.
- Can make per-spawn reconstruction harder.

## Decision Outcome

**Chosen option:** Option A: Per-spawn stderr file plus bounded error tail

**Rationale:** The bridge needs both durable RCA and immediate failure surfacing. A dedicated file preserves complete stderr, while the bounded tail gives pi enough context to understand the most common premature exits.

## Consequences

**Positive:**
- Premature-exit errors can include upstream causes such as `PromptNotAccepted` or Anthropic stream errors.
- Full stderr remains available under the bridge debug directory.
- stdout remains reserved for NDJSON events.

**Negative:**
- Diagnostic files may grow over time without rotation.
- Error messages may include selected upstream stderr content, bounded but potentially verbose.

**Neutral:**
- Stderr capture is best-effort and does not alter retry/abort classification.
- No files are written under `~/.claude/`.

## Links

- Source design discussion: `openspec/changes/no-liveness-timeouts-add-visibility/design.md` (Decision D4)
- Related ADRs: ADR-0003, ADR-0005, ADR-0007
- External references: None

---

<!--
IMMUTABILITY RULE: once this ADR is Accepted, do not edit the body. To
change a decision, create a new ADR and mark this one Superseded with
Superseded-by link → new ADR.

MADR 4.0 short form — see https://adr.github.io/madr/
-->
