# ADR-0015: Prompt injection — typed input post-`SessionStart`

**Status:** Accepted
**Date:** 2026-05-24
**Source change:** `openspec/changes/archive/2026-05-24-replace-sdk-with-pty-tui/`
**Supersedes:** D13 (original positional-CLI-argument approach; never reached production)

## Context

The pre-2026-05-22 design (D13) passed the pi user prompt as `claude`'s trailing positional CLI argument: `claude --system-prompt-file <path> ... 'pi user prompt text'`. Scenario validation against a real Max-plan OAuth account empirically discovered this fails with `API Error: 400 "out of extra usage"` — the error is misleading; it does NOT mean the user's credit is exhausted, it means Anthropic's OAuth interactive-mode policy classifier rejected the request shape.

Bisect localized the trigger to total system-prompt size ≥~2KB. Pi's default sysprompt is ~41KB, so every bridge spawn would hit this. The same args invoked via interactive PTY WITHOUT a positional prompt (then typed in post-`SessionStart`) succeed. Reference implementation `smithersai/claude-p` uses the same typed-injection approach.

## Decision Drivers

- Pi's sysprompt is ~41KB — well over the classifier trigger threshold
- OAuth Max-plan economic model must be preserved (rejecting API-key-only is user-hostile)
- Interactive-TUI architecture must be retained (ADR-0001 ruled out `claude -p`)
- Constitution VII: failure modes (timeout, quiescence ceiling, PTY exit) must surface as errors

## Considered Options

### Option A: Type prompt into PTY input post-`SessionStart`
After `SessionStart` hook fires AND PTY output is silent for `inkQuiescenceMs` (default 80ms, ceiling 2000ms), driver writes prompt bytes, waits `inkEnterDebounceMs` (default 120ms; defeats Ink bracketed-paste burst-merging), writes `\r` to submit. Implementation by analogy to `smithersai/claude-p`.

**Pros:** sidesteps OAuth tier cap (different code path inside `claude`). Reference implementation validates the pattern. Adds ~200ms latency per turn (acceptable: below existing PTY-boot budget).
**Cons:** typed-injection has subtle timing requirements (quiescence wait + debounce); D26 timing values empirically tuned against `claude 2.1.114`.

### Option B: Force `ANTHROPIC_API_KEY` instead of OAuth
**Pros:** sidesteps tier cap.
**Cons:** burdens every user with a separate API-key billing relationship; loses Max-plan included usage. Rejected as user-hostile.

### Option C: Pivot to `claude -p --output-format stream-json` headless mode
**Pros:** sidesteps tier cap (different code path).
**Cons:** defeats ADR-0001's design premise (move OFF `claude -p` to interactive TUI). Rejected as scope-incompatible.

### Option D: `--bare` flag
**Pros:** disables interactive-mode classifier.
**Cons:** also disables hooks (breaks ADR-0007) AND disables OAuth (`ANTHROPIC_API_KEY`-only). Trade off too much.

### Option E: Env vars `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` / `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`
**Pros:** would reduce auto-loaded context if size were the issue.
**Cons:** empirically did NOT fix the tier-cap rejection. The classifier is content-density-based, not size-based.

## Decision Outcome

**Chosen option:** A — typed-injection post-`SessionStart` with quiescence-wait + debounce.

**Rationale:** the only known workaround that preserves both the interactive-TUI architecture (ADR-0001 family) AND the OAuth Max-plan economic model. Reference implementation (`smithersai/claude-p`) ships this pattern in production. Adds ~200ms latency, well under the existing PTY-boot budget.

## Consequences

**Positive:**
- OAuth Max-plan billing preserved
- Reference implementation validated the pattern
- Failure modes spec'd (SessionStart timeout, quiescence ceiling, PTY exit)
- Capture path uses identical sequence (no special-case)

**Negative:**
- Typed-injection has subtle timing requirements (quiescence wait + debounce); values tuned against `claude 2.1.114` and may need adjustment on UI redesigns
- Image content stripped pre-typing (same v1 limitation as D13)
- ~200ms latency added per turn

**Neutral:**
- Default timing: `inkQuiescenceMs=80`, `inkMaxWaitMs=2000`, `inkEnterDebounceMs=120`, `sessionStartWaitMs=15000`. All env-overridable.
- Interaction with ADR-0014: trust dialog fires BEFORE `SessionStart`; scanner answers first, then `SessionStart` fires, then quiescence-then-type runs. Sequential by construction.

## Links

- Source design discussion: `openspec/changes/archive/2026-05-24-replace-sdk-with-pty-tui/design.md` (Decision D26)
- Related ADRs: ADR-0001 (PTY-driver), ADR-0014 (trust scanner runs first), ADR-0016 (system prompt bundled into the typed message — extends this decision)
- External: `smithersai/claude-p` reference implementation
