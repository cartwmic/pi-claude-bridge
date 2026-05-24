# ADR-0002: node-pty as PTY library

**Status:** Accepted
**Date:** 2026-05-24
**Source change:** `openspec/changes/archive/2026-05-24-replace-sdk-with-pty-tui/`

## Context

ADR-0001 chose to drive `claude` inside a pseudoterminal. That requires a Node.js PTY binding. Pi runs on Node 20+; the binding must be cross-platform (macOS + Linux), have prebuilt binaries for common Node ABI versions, and be maintained.

## Decision Drivers

- Cross-platform: macOS + Linux (Windows out of scope per ADR-0001)
- Prebuilt binaries (avoid native build at install time)
- Active maintenance signal
- Familiar API (industry-standard PTY semantics)

## Considered Options

### Option A: `node-pty` (microsoft)
v1.x maintained by Microsoft. Used by VS Code, Hyper, Theia.

**Pros:** industry standard; healthy maintenance signal (active issues, regular releases); prebuilt binaries for common Node ABIs.
**Cons:** native binding can fail to install on niche Node ABI versions.

### Option B: `@lydell/node-pty` (fork)
Lighter install.

**Pros:** smaller footprint.
**Cons:** less battle-tested; smaller user base.

### Option C: Bun runtime + built-in PTY API
**Pros:** zero dependency.
**Cons:** pi runs on Node; runtime swap is out of scope.

### Option D: Custom FFI to a Rust PTY crate
**Pros:** maximum flexibility.
**Cons:** maximum maintenance; no justification.

### Option E: Roll-our-own forkpty bindings
**Pros:** zero dep.
**Cons:** bad idea — reinventing well-tested ground.

## Decision Outcome

**Chosen option:** A — `node-pty`.

**Rationale:** the industry default for serious Node-based TUI drivers (VS Code's terminal is built on it). Maintenance signal is healthy enough for a v1.0.0 commit. Option B remains a fallback if Microsoft's build cadence falters.

## Consequences

**Positive:**
- Battle-tested behavior across thousands of VS Code installations
- Prebuilt binaries for Node 20 + 22 on macOS/Linux
- Stable API: spawn → onData → write → kill

**Negative:**
- Native module install can fail on uncommon Node ABI versions
- Adds a native binary to the bundle (modest install size increase)

**Neutral:**
- If node-pty maintenance falters, `@lydell/node-pty` is a drop-in fallback

## Links

- Source design discussion: `openspec/changes/archive/2026-05-24-replace-sdk-with-pty-tui/design.md` (Decision D2)
- Related ADRs: ADR-0001 (PTY-driver decision)
- External: https://github.com/microsoft/node-pty
