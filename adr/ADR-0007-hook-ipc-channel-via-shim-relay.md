# ADR-0007: Hook IPC channel — hook subprocesses relay payloads to the long-lived bridge

**Status:** Accepted
**Date:** 2026-05-24
**Source change:** `openspec/changes/archive/2026-05-24-replace-sdk-with-pty-tui/`

## Context

`claude` interactive hooks are subprocesses — the `--settings` JSON declares `{ "type": "command", "command": "<shell command>" }` entries. `--include-hook-events` is `--print`-only, so interactive mode has no in-process hook channel. The bridge needs to receive `SessionStart` and `Stop` payloads from the spawned `claude` and act on them inside the long-lived bridge process.

## Decision Drivers

- Hook payloads must reach the bridge's in-process state machinery
- Multiple hook events per turn (SessionStart, Stop) need uniform plumbing
- Per-PTY isolation (one PTY's hooks must not deliver to another PTY's bridge state)
- Cleanup on PTY exit (no stale hook handlers)

## Considered Options

### Option A: Multi-mode shim binary; hooks fork into shim --mode hook
One executable `pi-claude-bridge-shim` whose `argv[1]` selects role:
- `--mode mcp --socket <path>` — stdio MCP server for `--mcp-config`
- `--mode hook --event <name> --socket <path>` — hook payload relay

Hook subprocess reads its stdin (claude writes payload there), connects to the bridge via per-PTY unix socket, forwards payload + event name, awaits a structured response, writes response to stdout (the format `claude` expects), exits.

**Pros:** one bin entry; single install footprint; shared IPC plumbing with MCP mode.
**Cons:** subprocess spawn cost per hook event (~50-100ms on macOS).

### Option B: Separate executables for shim vs hook relay
Two bin entries.

**Pros:** clearer role separation.
**Cons:** two install footprints; identical IPC plumbing; doubles release coordination.

### Option C: Skip hook payloads entirely; rely on transcript-only signals
**Pros:** no IPC at all.
**Cons:** loses the `SessionStart` signal — critical for D26 typed-injection (the bridge needs to know when to type the prompt). Rejected.

## Decision Outcome

**Chosen option:** A — multi-mode shim binary with `--mode hook` for relay.

**Rationale:** one binary, one install footprint, shared IPC infrastructure. The subprocess fork cost is acceptable: only fires for SessionStart + Stop (D9 dropped PreToolUse precisely to avoid per-tool-call fork cost). Per-PTY socket path via `randomBytes` ensures isolation.

## Consequences

**Positive:**
- Single bin entry; shared install footprint
- Per-PTY socket isolation (constitution VI)
- Cleanup on PTY exit (socket removed)
- Hook payload relayed verbatim to bridge state machinery

**Negative:**
- ~50-100ms subprocess fork cost per hook event (mitigated by minimizing hook count to 2)
- Adds wire-protocol surface (see related: D20 IPC protocol)
- Hook command must be shell-quoted carefully (single-quote wrap with embedded-quote escape)

**Neutral:**
- Per-PTY socket: `$TMPDIR/pi-claude-bridge-<random>.sock`
- Cleanup on PTY exit

## Links

- Source design discussion: `openspec/changes/archive/2026-05-24-replace-sdk-with-pty-tui/design.md` (Decision D12)
- Related ADRs: ADR-0003 (MCP transport), ADR-0012 (shim path resolution)
