# ADR-0003: MCP transport = stdio with a shim subprocess

**Status:** Accepted
**Date:** 2026-05-24
**Source change:** `openspec/changes/archive/2026-05-24-replace-sdk-with-pty-tui/`

## Context

ADR-0001 removes the SDK; pi tools must still be bridged to `claude`. `claude --mcp-config` configures MCP servers via inline JSON. The bridge needs a transport for pi tool calls that matches MCP semantics, lives within process boundaries of the spawned `claude` child, and survives across PTY lifecycle without leaking handles.

## Decision Drivers

- Pi tool execution remains in pi (not in `claude`)
- Tool round-trip parking — pi delivers the result on the next `streamSimple()` call; the MCP handler must block on a Promise until then
- Clean teardown when the PTY exits
- No localhost port allocation surface (security + firewall)

## Considered Options

### Option A: Stdio MCP shim subprocess + unix-socket relay
Per PTY, the bridge spawns a stdio MCP shim subprocess. The shim speaks MCP over stdin/stdout to `claude`, forwards `tools/call` to the bridge's in-process router over a per-PTY unix-domain socket. Router parks Promise; pi delivers result via next `streamSimple()`; router resolves; shim sends MCP response.

**Pros:** stdio is MCP's most-tested transport. Process boundary cleanup is automatic (shim's stdin closes when claude exits). No port allocation surface. No firewall prompts.
**Cons:** extra subprocess per PTY (modest); IPC wire protocol to maintain (see ADR-0007).

### Option B: HTTP/SSE MCP server in the bridge process
Fewer processes; the bridge listens on `localhost:<port>` directly.

**Pros:** single process boundary for the bridge.
**Cons:** localhost port allocation races on concurrent spawns. Less battle-tested transport. Ambient discoverability (anything on localhost can probe).

### Option C: In-process MCP via SDK helpers
**Pros:** zero IPC.
**Cons:** no SDK post-ADR-0001 — eliminated by design.

### Option D: Named pipe instead of unix socket
**Pros:** functionally equivalent on macOS/Linux.
**Cons:** unix socket is simpler with existing Node `net` module; no advantage to pipes.

## Decision Outcome

**Chosen option:** A — stdio MCP shim subprocess + unix-socket relay.

**Rationale:** stdio is MCP's most-tested transport. Subprocess boundary cleanup happens automatically when `claude` exits. No port allocation, no auth handshake, no firewall prompts. The slight complexity of the shim is worth the lifecycle safety.

## Consequences

**Positive:**
- Automatic process cleanup (stdin close on parent exit)
- No localhost port race conditions
- Wire protocol is the documented MCP stdio transport
- Per-PTY isolation natural

**Negative:**
- One subprocess per PTY (modest resource cost)
- IPC wire protocol between shim and router (see ADR-0007)
- Shim must be resolvable on disk (see ADR-0012)

**Neutral:**
- Per-PTY socket path generated via `randomBytes` in `$TMPDIR/pi-claude-bridge-<random>.sock`

## Links

- Source design discussion: `openspec/changes/archive/2026-05-24-replace-sdk-with-pty-tui/design.md` (Decision D3)
- Related ADRs: ADR-0001 (PTY-driver), ADR-0007 (hook IPC channel), ADR-0012 (shim path resolution)
- External: MCP stdio transport specification
