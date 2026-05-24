# ADR-0004: Per-block streaming via transcript JSONL tail

**Status:** Accepted
**Date:** 2026-05-24
**Source change:** `openspec/changes/archive/2026-05-24-replace-sdk-with-pty-tui/`

## Context

ADR-0001 commits to driving the interactive TUI. The bridge needs to emit content to pi's stream layer as `claude` produces it. The interactive TUI does NOT support `--output-format stream-json` (that flag is `--print`-only). The only public signal of model output is the transcript JSONL file `claude` writes to `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`.

## Decision Drivers

- Pi consumers expect per-block (or finer) streaming events
- Pi must execute each `tool_use` block live during a turn (cannot wait for end-of-turn)
- Transcript JSONL is a documented hook payload contract (schema changes are real-API-level events, not UI tweaks)
- The TUI renderer (Ink) is internal and may redesign at any time

## Considered Options

### Option A: Transcript JSONL tail, per-block emission
Open the file (path computed deterministically per ADR-0011), tail during the turn, parse complete JSONL lines, emit structured events (text-delta, tool-use, thinking-delta, usage) at per-block granularity.

**Pros:** documented contract; per-block granularity sufficient for pi UX; tool-use blocks emitted as they appear so pi can execute live.
**Cons:** per-token streaming lost vs SDK (acceptable trade per explore-mode discussion).

### Option B: TUI output scrape (ANSI parsing)
Parse the `proc.onData` stream from node-pty, strip ANSI, reconstruct text.

**Pros:** per-token feel; closest to what the user sees.
**Cons:** couples to Ink internals; any TUI redesign breaks the bridge silently. Constitution VII violation risk: failures would be invisible (the bridge would emit subtly-wrong content rather than fail).

### Option C: Wait for `Stop`, dump the whole transcript
The `smithersai/claude-p` approach for headless one-shot calls.

**Pros:** simple; one parse pass.
**Cons:** pi has to execute each `tool_use` live; waiting for `Stop` makes tool rounds impossible. Hard rejection for our use case.

## Decision Outcome

**Chosen option:** A — transcript JSONL tail, per-block emission.

**Rationale:** transcript JSONL is documented; schema changes are real-API events not UI tweaks. Per-block granularity is sufficient for pi UX (the user sees text appear in sentence-ish chunks, not per-token). Tool-use blocks appear in the transcript as they're emitted, enabling live tool round execution. The tailer parses on `\n` boundaries only, buffering partial bytes until the next read (preserves `transcript-stream.partial-lines-are-buffered-until-newline`).

## Consequences

**Positive:**
- Documented contract; survives TUI redesigns
- Per-block granularity sufficient for pi UX
- Live tool execution preserved
- Drift detection: unknown top-level `type` emits warn-level log, continues (forward-compat)

**Negative:**
- Per-token streaming lost vs SDK
- Tailer must handle partial lines, file truncation, line-buffering quirks
- Post-`Stop` settle window needed to catch the final lines (D17)

**Neutral:**
- `--include-hook-events` and `--include-partial-messages` are `--print`-only — not usable for interactive mode

## Links

- Source design discussion: `openspec/changes/archive/2026-05-24-replace-sdk-with-pty-tui/design.md` (Decision D4)
- Related ADRs: ADR-0001 (PTY-driver), ADR-0011 (deterministic transcript path), ADR-0009 (abort lifecycle handles tailer transition)
