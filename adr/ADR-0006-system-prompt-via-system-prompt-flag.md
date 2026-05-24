# ADR-0006: System prompt injection via `--system-prompt` / `--system-prompt-file`

**Status:** Superseded
**Date:** 2026-05-24
**Source change:** `openspec/changes/archive/2026-05-24-replace-sdk-with-pty-tui/`
**Superseded by:** ADR-0016 (system prompt bundled into typed user message)

## Context

ADR-0001 commits to driving `claude` via interactive TUI. Pi's system prompt content must reach the model verbatim on the capture path (constitution V) and additively on the main-provider path. `claude --help` documents `--system-prompt` ("System prompt to use for the session" — replaces default) and `--append-system-prompt` (appends to default). At the time of this decision, these flags were the obvious mechanism.

## Decision Drivers

- Constitution V: capture path forwards `ctx.systemPrompt` verbatim
- Constitution V: main-provider path retains additive composition (pi-UI append blocks)
- Documented `claude` CLI surface
- argv ceiling on macOS (~256KB) and Linux (~2MB)

## Considered Options

### Option A: `--system-prompt` (verbatim replace)
Use `--system-prompt <text>` for small prompts; `--system-prompt-file <path>` for large prompts (cold-start replays).

**Pros:** documented flag with documented semantics; Phase 0 verified the file-form variant works in interactive mode.
**Cons:** writes a tmpfile for large prompts. Phase 0 found a 50KB heuristic threshold.

### Option B: `--append-system-prompt`
Documented as appending to CC's default.

**Pros:** retains CC's default scaffolding.
**Cons:** unacceptable for capture path — constitution V demands verbatim, not "default + appended".

### Option C: Inline `--settings '{"systemPrompt": "..."}'`
**Pros:** no separate flag.
**Cons:** undocumented; behavior unverified; interaction with `--setting-sources ""` unspecified.

### Option D: Inject system content as a first user message
**Pros:** no flag dependence.
**Cons:** lossy semantically (system content seen as user content). Was the fallback in pre-Round-1 design; eliminated as primary.

## Decision Outcome

**Chosen option:** A — `--system-prompt` / `--system-prompt-file` per ~50KB heuristic.

**Rationale:** documented flag, documented behavior, verified in Phase 0 spike T0.1 + T0.8 + T0.11. The file-form variant unblocks cold-start replays larger than the argv ceiling.

## Consequences

**Positive (at decision time):**
- Documented contract
- Constitution V satisfied verbatim on capture path
- argv ceiling avoided via file-form for large prompts

**Negative (discovered post-decision):**
- Anthropic's interactive-mode classifier rejects ANY substantive `--system-prompt*` content (`API Error: 400 "out of extra usage"`) regardless of size or model
- Bisect found content-density triggers (not pure size)
- Bridge had to be rewritten to NOT pass `--system-prompt*` flags at all (see ADR-0016)

**Neutral:**
- `--exclude-dynamic-system-prompt-sections` is "ignored with `--system-prompt`" per `claude --help`

## Status: SUPERSEDED

Empirically discovered 2026-05-22 (after D26 typed-injection landed): even with typed-prompt injection in place, ANY content in `--system-prompt*` flags triggers Anthropic's interactive-mode classifier. The bundled-message approach (ADR-0016) preserves Constitution V verbatim while bypassing the classifier by delivering content via user-role channel.

## Links

- Source design discussion: `openspec/changes/archive/2026-05-24-replace-sdk-with-pty-tui/design.md` (Decision D7-final, superseded by D27)
- Superseded by: ADR-0016 (system prompt bundled into typed user message)
- Related: ADR-0015 (typed prompt injection — the path that exposed the classifier issue)
