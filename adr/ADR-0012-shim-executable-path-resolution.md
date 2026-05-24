# ADR-0012: Shim executable path resolution

**Status:** Accepted
**Date:** 2026-05-24
**Source change:** `openspec/changes/archive/2026-05-24-replace-sdk-with-pty-tui/`

## Context

ADR-0003 introduces a `pi-claude-bridge-shim` subprocess invoked by `claude` via `--mcp-config`. ADR-0007 reuses the same shim for hook relays via `--mode hook`. Both invocations need to know where the shim binary lives on disk. The spawned `claude` process inherits its `PATH` from pi's extension launcher, which is not guaranteed to include the npm bin directory of `pi-claude-bridge`. Relying on `$PATH` would fail intermittently.

## Decision Drivers

- Shim must be invocable regardless of installation layout (global npm, local node_modules, npx)
- Spawned `claude`'s child env may have a minimal `PATH`
- Hook commands are shell strings (not argv arrays) — shell-quoting must handle paths with spaces
- Tarball-verification gate (T4.4a) must prove the resolved path is correct

## Considered Options

### Option A: Resolve absolute path at spawn time via `require.resolve`
At PTY-spawn time, bridge runs `require.resolve('pi-claude-bridge/dist/mcp/shim.js')` (or `import.meta.resolve` in pure-ESM contexts). Passes absolute path to both:
1. `--mcp-config` JSON (`args` is array — no shell quoting needed)
2. `--settings` hook commands (shell-quoted single-string form: every path wrapped in single quotes, embedded single quotes escaped)

**Pros:** absolute path is correct regardless of layout; no `$PATH` dependency; Node module resolution is well-understood.
**Cons:** path must be embedded in two surfaces (mcp-config + settings); shell-quoting helper needed for the settings surface.

### Option B: Rely on `pi-claude-bridge-shim` being on `$PATH`
**Pros:** zero resolution logic.
**Cons:** pi's spawned-subprocess `PATH` is not guaranteed to include the npm bin directory; would fail on any non-global install; rejected.

### Option C: Hardcoded absolute path at build time
**Pros:** zero resolution at runtime.
**Cons:** breaks on any install other than the build environment.

### Option D: Symlink the shim into a known location at install time
**Pros:** known location.
**Cons:** install-time hooks are fragile (npm install --ignore-scripts skips them); rejected.

## Decision Outcome

**Chosen option:** A — `require.resolve` at spawn time, absolute path embedded in mcp-config + shell-quoted in settings hooks.

**Rationale:** `require.resolve` returns an absolute path regardless of installation layout. Pi's extension-launched subprocess `PATH` is not guaranteed; explicit absolute path eliminates the variable. Shell-quoting for settings hooks: wrap every path in single quotes, escape embedded single quotes via `'\''` (POSIX standard). Unit test (Round-5 A.P2) spawns a hook command with a path containing a literal space and asserts payload relay succeeds.

## Consequences

**Positive:**
- Works on global npm, local node_modules, npx, monorepo workspaces
- T4.4a tarball-verification test confirms end-to-end
- Single-quote wrap handles spaces in paths
- Symbol-level resolution is well-tested across Node ecosystem

**Negative:**
- Two embedding surfaces (mcp-config array + settings string)
- Shell-quoting helper must be correct (covered by `unit-mcp-shim` test for quoting edge cases)
- `import.meta.resolve` vs `require.resolve` divergence in pure-ESM contexts (handled in code)

**Neutral:**
- Path is per-spawn; no caching needed (resolution is sub-millisecond)

## Links

- Source design discussion: `openspec/changes/archive/2026-05-24-replace-sdk-with-pty-tui/design.md` (Decision D19)
- Related ADRs: ADR-0003 (MCP transport), ADR-0007 (hook IPC), ADR-0008 (build to dist/)
- Verification: `tests/int-tarball-verification.mjs`, `tests/unit-mcp-shim.mjs`
