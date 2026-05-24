# ADR-0001: Replace the Agent SDK with a PTY-driven `claude` TUI invocation

**Status:** Accepted
**Date:** 2026-05-24
**Source change:** `openspec/changes/archive/2026-05-24-replace-sdk-with-pty-tui/`

## Context

The bridge ran every inference call through `@anthropic-ai/claude-agent-sdk`. The SDK is a programmatic equivalent of `claude -p` and had historically been the most ergonomic surface. The owner no longer trusted the SDK as a durable surface — auth-path coupling, feature drift relative to the user-facing TUI, and the `smithersai/claude-p` observation that "client-side restrictions on how a product is used are fundamentally unenforceable" justified removing the SDK from the dependency graph.

**Constitution citations:**
- III. No filesystem coupling to driver mutable state
- IV. Native Claude tools are disallowed
- V. System prompt fidelity per path
- VI. Concurrent paths share no state
- VII. Failures surface

## Decision Drivers

- Stability across upstream releases
- Visibility into OAuth tier-3 caps (the SDK hides them)
- Existing pi extension contract preserved (provider-style streaming)
- Single source of truth for tool execution (pi, not SDK)

## Considered Options

### Option A: Keep the Agent SDK as-is
Lowest effort.

**Pros:** zero migration cost.
**Cons:** owner explicitly distrusts SDK as durable surface; future restrictions/drift are unbounded liability.

### Option B: Use `claude -p` (headless) as a subprocess
Preserves real streaming via `--output-format stream-json`.

**Pros:** retains streaming fidelity.
**Cons:** `claude -p` IS the SDK's mode internally; same trust concerns apply. Defeats the refactor.

### Option C: Drive `claude` interactive TUI via node-pty
Spawn the same binary a human user runs; observe via transcript JSONL + hooks.

**Pros:** tracks the surface Anthropic is most committed to keeping unrestricted for personal subscriptions. OAuth tier caps surface natively. No SDK runtime dependency.
**Cons:** ~600ms cold-start latency vs ~50ms SDK init. Tool round-trip needs full re-architecture.

### Option D: Talk to the Anthropic API directly
Maximum control.

**Pros:** zero binding to Claude Code.
**Cons:** re-implements model selection, prompt caching, auth, subscription routing.

## Decision Outcome

**Chosen option:** C — PTY-driven interactive TUI.

**Rationale:** the user-facing TUI is the surface Anthropic is most committed to keeping stable for personal subscriptions. Driving the same binary a human user runs minimizes coupling to product strategy changes. Cold-start latency is offset by warm-resume cache (see ADR-0011).

## Consequences

**Positive:**
- No more SDK version-pin breakage
- OAuth tier caps surface natively
- Bundle: index.ts shrank 1746 → 493 lines (-3131 LOC across change)
- Driver tracks the actual product surface

**Negative:**
- ~600ms PTY spawn cold-start latency
- Capture path needed full re-architecture (ADR-0005)
- Trust dialog handling is now in-band (ADR-0014)
- macOS + Linux only; Windows out of scope

**Neutral:**
- Per-block streaming granularity instead of per-token (acceptable per explore-mode discussion)

## Links

- Source design discussion: `openspec/changes/archive/2026-05-24-replace-sdk-with-pty-tui/design.md` (Decision D1)
- Related ADRs: ADR-0002 (PTY library), ADR-0003 (MCP transport), ADR-0004 (streaming), ADR-0005 (capture mode)
- External: `smithersai/claude-p` (reference implementation)
