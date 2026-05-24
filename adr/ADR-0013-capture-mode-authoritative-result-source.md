# ADR-0013: Capture-mode authoritative result source

**Status:** Accepted
**Date:** 2026-05-24
**Source change:** `openspec/changes/archive/2026-05-24-replace-sdk-with-pty-tui/`

## Context

ADR-0010 has the capture-mode shim stash validated tool arguments via IPC after schema validation, then respond with a deterministic "End your turn now" payload. The transcript JSONL ALSO records the tool-use block (the model emitted it; ADR-0004 tails it). On `Stop`, the bridge has two sources for the captured arguments: (a) the IPC stash, (b) the transcript JSONL tool-use entry. They may disagree under failure modes (truncated transcript write, IPC delivery race, malformed JSONL parsing).

## Decision Drivers

- Schema validation must be load-bearing (constitution IV-grade enforcement)
- Disagreement between IPC and transcript needs an explicit winner — otherwise the bridge silently picks one
- `usage` / `cost` metadata lives in the transcript's terminal entry; not in the IPC stash
- Constitution VII: failures surface

## Considered Options

### Option A: IPC stash authoritative; transcript for cross-check + usage extraction only
- Authoritative source: IPC-stashed validated arguments (from shim, after schema pass).
- Transcript role: (a) cross-check that a corresponding tool-use block was written (warn on mismatch), (b) extract `usage` / `cost` from terminal entry for the synthesized AssistantMessage.
- Disagreement: bridge trusts IPC stash (it was validated against the schema before stashing); warn-logs the divergence.

Edge cases:
- First valid call wins (IPC stash retained); second call gets MCP `-32603` (no second stash).
- Invalid → valid: validation failure (shim returns `-32602`, no stash) followed by a valid call IS allowed; the valid call becomes authoritative.
- Zero valid calls at `Stop`: fires `output-capture.surface-absent-capture-tool-call-as-error`.

**Pros:** schema-validated source is canonical; matches the constitution-IV guarantee. Transcript provides usage data without being trusted for content.
**Cons:** disagreement requires two-source comparison logic; warn-log noise on truly-malformed transcripts.

### Option B: Transcript authoritative; IPC stash for validation only
**Pros:** transcript is the documented record.
**Cons:** transcript content is post-validation in the model's view; if the shim rejected the args, the transcript may still contain the (invalid) call. Cross-check inverted. Rejected.

### Option C: Require IPC + transcript agreement; error on divergence
**Pros:** strictest correctness.
**Cons:** transient I/O hiccups (transcript truncated mid-write, etc.) become user-visible errors. Rejected as too brittle.

### Option D: First-to-arrive wins (no preference)
**Pros:** simplest.
**Cons:** non-deterministic; intermittent failures hard to diagnose. Rejected.

## Decision Outcome

**Chosen option:** A — IPC stash authoritative; transcript for cross-check + usage extraction.

**Rationale:** the IPC stash represents args that PASSED schema validation at the MCP protocol boundary (ADR-0010). The transcript is the raw model output, which may or may not pass validation. Trust the validated path. Use transcript for the metadata pi consumers expect (usage, cost) where it's the only source.

## Consequences

**Positive:**
- Schema-validation is load-bearing (capture-tool calls that don't validate never reach pi)
- Usage / cost extracted from transcript without trusting it for content
- Deterministic edge cases (first valid wins, invalid→valid allowed, zero is an error)

**Negative:**
- Bridge must compare IPC stash vs transcript on success path (warn on divergence)
- If IPC delivery races behind `Stop` (rare; would require shim crash mid-stash), the bridge falls back to transcript with a warn-log

**Neutral:**
- Synthesized `AssistantMessage` uses IPC-stashed args for `toolCall.arguments` + transcript-extracted `usage` for the message metadata
- Spec ID: `output-capture.surface-absent-capture-tool-call-as-error` covers the zero-call case

## Links

- Source design discussion: `openspec/changes/archive/2026-05-24-replace-sdk-with-pty-tui/design.md` (Decision D21)
- Related ADRs: ADR-0005 (capture mode), ADR-0010 (MCP completion semantics), ADR-0004 (transcript tailing)
