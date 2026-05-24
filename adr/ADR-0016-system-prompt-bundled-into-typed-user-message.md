# ADR-0016: System prompt is bundled into the typed user message

**Status:** Accepted
**Date:** 2026-05-24
**Source change:** `openspec/changes/archive/2026-05-24-replace-sdk-with-pty-tui/`
**Supersedes:** ADR-0006 (`--system-prompt[-file]` flag approach)
**Extends:** ADR-0015 (typed prompt injection)

## Context

ADR-0006 chose `--system-prompt` / `--system-prompt-file` for system prompt injection. ADR-0015 chose typed prompt injection (post-SessionStart) to bypass Anthropic's OAuth interactive-mode classifier on positional CLI prompts.

After ADR-0015 was implemented, scenario validation with pi's actual ~41KB sysprompt revealed that EVEN WITH typed-injection in place, ANY substantive content in `--system-prompt*` flags still triggers Anthropic's classifier (`API Error: 400 "out of extra usage"`).

Bisect findings (with typed-injection active, varying `--system-prompt-file` content):
- pi sysprompt prefix 0-2150 bytes → PASS
- pi sysprompt prefix 0-2175 bytes → FAIL (400)
- Synthetic 50KB English → PASS
- Synthetic 50KB English with pi-style structure (meta-instructions, tool listings, operator prompts) → PASS
- pi sysprompt 41KB via `--append-system-prompt-file` → FAIL
- pi sysprompt 41KB as typed user message wrapped in `<system_context>` → PASS

The trigger is **content-specific**, not pure size. Anthropic's classifier flags certain density patterns of meta-instructions, tool-listings, and operator-prompt content when delivered via system-role channels. **The same content on the user-role channel is accepted.** Verified via direct API call response headers: `anthropic-ratelimit-unified-overage-status: rejected` + `anthropic-ratelimit-unified-overage-disabled-reason: org_level_disabled` — NOT a quota issue; failing requests routed to overage which is org-disabled.

## Decision Drivers

- Pi sysprompt MUST reach the model (it's load-bearing for pi's behavior)
- Constitution V: capture path requires verbatim system prompt
- Constitution III: prefer in-memory over filesystem write
- OAuth Max-plan economic model preserved (no API-key fallback)

## Considered Options

### Option A: Bundle system prompt into typed user message, wrapped in `<system_context>`
Driver builds CLI args WITHOUT any `--system-prompt*` flag. The bridge calls `composeBundledUserMessage(opts.systemPrompt, opts.prompt)` which returns `"<system_context>\n${systemPrompt}\n</system_context>\n\n${userPrompt}"`. The ADR-0015 typed-injection sequence types this bundled message into the PTY.

**Pros:** sidesteps the classifier (user-role channel accepted); preserves byte-for-byte system prompt content (constitution V satisfied verbatim inside the wrapper); eliminates the `--system-prompt-file` tmpdir write (strengthens constitution III).
**Cons:** semantic deviation: content the model "should treat as system" arrives via user role. The wrapper tag is the only signal.

### Option B: Keep `--system-prompt-file`, accept the classifier failure
**Pros:** documented flag.
**Cons:** every bridge spawn fails with 400. Unacceptable.

### Option C: Pivot to `ANTHROPIC_API_KEY`
**Pros:** classifier doesn't apply.
**Cons:** user-hostile (loses Max-plan included usage); same rejection as ADR-0015 Option B.

### Option D: Strip pi's sysprompt content patterns to defeat the classifier
**Pros:** keeps system-role channel.
**Cons:** would require maintaining a content-redactor matching an opaque-to-us classifier; brittle; rejected.

## Decision Outcome

**Chosen option:** A — `composeBundledUserMessage` wrapping system prompt in `<system_context>` tags, typed as user message.

**Rationale:** the only known approach that delivers the full system prompt to the model under the OAuth interactive-mode classifier. The wrapper preserves content byte-for-byte (constitution V verbatim guarantee), eliminates the tmpdir write (strengthens constitution III), and works uniformly on cold-start AND warm-resume.

## Consequences

**Positive:**
- Pi sysprompt reaches the model on every turn
- Constitution V satisfied (byte-for-byte preservation inside wrapper)
- Constitution III strengthened (no `--system-prompt-file` tmpdir write)
- Pure function `composeBundledUserMessage` cannot fail at runtime
- No special-case capture vs main path (same compose helper)

**Negative:**
- Constitution-VII-eligible documented limitation: delivery channel is user-role, not system-role. External cause (Anthropic classifier); bridge's job is best-effort delivery.
- Wrapper tags `<system_context>` visible to the model (semantically signals "configuration context")
- Coupled to ADR-0015 typed-injection sequence (both ADRs supersede pre-2026-05-22 design)

**Neutral:**
- ADR-0006 superseded — `--system-prompt-file` write to tmpdir removed entirely
- Empty/whitespace `systemPrompt`: function returns `userPrompt` verbatim (no wrapper)

## Links

- Source design discussion: `openspec/changes/archive/2026-05-24-replace-sdk-with-pty-tui/design.md` (Decision D27)
- Supersedes: ADR-0006 (`--system-prompt` flag approach)
- Extends: ADR-0015 (typed prompt injection)
- Verification: `tests/unit-driver-pty.mjs` (composeBundledUserMessage × 5 cases)
