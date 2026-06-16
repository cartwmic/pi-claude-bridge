# ADR-0007: Forward claude debug-file to a bridge-owned path

**Status:** Accepted
**Date:** 2026-06-16
**Source change:** `openspec/changes/no-liveness-timeouts-add-visibility/`
**Supersedes:** None
**Superseded by:** None

## Context

The native `claude` CLI supports `--debug-file <path>`, and `claude-p` forwards unrecognized flags verbatim to `claude`. Without an explicit path, Claude debug logging defaults under `~/.claude/`, which the bridge must not read or write. The change needs richer diagnostics after removing liveness timers, but must keep Constitution III intact.

The selected path is bridge-owned, per-spawn, and enabled by default with `CLAUDE_BRIDGE_CLAUDE_DEBUG_FILE=0` as an escape hatch. The design notes residual risk that enabling debug mode could affect the interactive PTY; integration coverage and the escape hatch mitigate that risk.

4-point score: multiple viable approaches yes; lasting consequences yes; disagreement potential yes; future constraints yes = **4/4**.

## Decision Drivers

- Capture native Claude debug logs alongside bridge diagnostics.
- Keep all bridge-directed diagnostics out of `~/.claude/`.
- Avoid requiring a new `claude-p` fork when passthrough already exists.
- Preserve an immediate disable path if debug mode affects PTY behavior.
- Make future hangs easier to diagnose without reintroducing timers.

## Considered Options

### Option A: Forward `--debug-file <bridge-owned-path>`

Resolve a per-spawn path under the bridge debug directory and append `--debug-file <path>` to `claude-p` args unless disabled by env.

**Pros:**
- Uses native Claude debug support.
- Keeps debug output under bridge-owned diagnostics instead of `~/.claude/`.
- Requires no `claude-p` fork because unknown flags pass through.
- Per-spawn paths aid correlation with stderr and bridge logs.

**Cons:**
- `--debug-file` implicitly enables debug mode.
- Debug mode could theoretically affect the interactive PTY behavior.
- Adds more diagnostic files to manage.

### Option B: Set `ANTHROPIC_LOG=debug`

Enable debug logging through environment instead of a debug-file flag.

**Pros:**
- Avoids adding an argv flag.
- Uses a known upstream logging mechanism.

**Cons:**
- Logs to stderr/console rather than a clean per-spawn file.
- Duplicates the stderr capture channel rather than creating a separate structured debug artifact.
- Harder to correlate and bound per spawn.

### Option C: Fork claude-p for first-class debug passthrough

Add a dedicated claude-p option for Claude debug forwarding.

**Pros:**
- Could make the behavior explicit in claude-p's own CLI.
- Could validate path handling closer to the subprocess boundary.

**Cons:**
- Unnecessary because unknown flags already pass through.
- Adds fork maintenance for no behavioral gain.
- Delays the visibility improvement.

## Decision Outcome

**Chosen option:** Option A: Forward `--debug-file <bridge-owned-path>`

**Rationale:** The bridge can obtain native Claude debug logs with no fork and no `~/.claude/` writes by passing an explicit bridge-owned path through `claude-p`. The env escape hatch contains the residual PTY/debug-mode risk.

## Consequences

**Positive:**
- Native Claude debug logs are captured per spawn.
- Constitution III remains satisfied by steering output away from `~/.claude/`.
- No claude-p fork change is required.

**Negative:**
- Debug mode is on by default and could expose upstream behavior changes.
- More diagnostic files may accumulate under the bridge debug directory.

**Neutral:**
- Operators can disable forwarding with `CLAUDE_BRIDGE_CLAUDE_DEBUG_FILE=0`.
- Stderr capture remains a separate diagnostic channel.

## Links

- Source design discussion: `openspec/changes/no-liveness-timeouts-add-visibility/design.md` (Decision D5)
- Related ADRs: ADR-0003, ADR-0006
- External references: `claude --help`; `claude-p` README unknown-flag forwarding

---

<!--
IMMUTABILITY RULE: once this ADR is Accepted, do not edit the body. To
change a decision, create a new ADR and mark this one Superseded with
Superseded-by link → new ADR.

MADR 4.0 short form — see https://adr.github.io/madr/
-->
