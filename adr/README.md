# Architecture Decision Records

Permanent, immutable records of architectural decisions. One file per
decision. Once accepted, the body is not edited — to change a decision,
create a new ADR with `Status: Supersedes ADR-NNNN` and mark the old one
`Superseded by: ADR-MMMM`.

Format: [MADR 4.0 short form](https://adr.github.io/madr/).

Source: most ADRs here were promoted from
`openspec/changes/archive/<date>-<change>/design.md` Decision blocks
that passed the 4-point rubric (multiple viable approaches? lasting
consequences? disagreement potential? future constraints?) at ≥3/4.

## Index

| # | Title | Status |
|---|---|---|
| [ADR-0001](ADR-0001-pty-driver-over-sdk.md) | Replace the Agent SDK with a PTY-driven `claude` TUI invocation | Accepted |
| [ADR-0002](ADR-0002-node-pty-as-pty-library.md) | node-pty as PTY library | Accepted |
| [ADR-0003](ADR-0003-mcp-stdio-transport-via-shim.md) | MCP transport = stdio with a shim subprocess | Accepted |
| [ADR-0004](ADR-0004-per-block-streaming-via-transcript-jsonl.md) | Per-block streaming via transcript JSONL tail | Accepted |
| [ADR-0005](ADR-0005-capture-mode-as-forced-mcp-tool-call.md) | Capture mode as forced MCP tool-call | Accepted |
| [ADR-0006](ADR-0006-system-prompt-via-system-prompt-flag.md) | System prompt injection via `--system-prompt` / `--system-prompt-file` | Superseded by ADR-0016 |
| [ADR-0007](ADR-0007-hook-ipc-channel-via-shim-relay.md) | Hook IPC channel via shim relay subprocess | Accepted |
| [ADR-0008](ADR-0008-build-to-dist-for-publishable-artifacts.md) | Packaging — build to `dist/` for publishable artifacts | Accepted |
| [ADR-0009](ADR-0009-abort-lifecycle-pty-teardown-router-preserved.md) | Abort lifecycle — PTY torn down, router-state preserved | Accepted |
| [ADR-0010](ADR-0010-capture-mode-mcp-completion-semantics.md) | Capture-mode MCP completion semantics | Accepted |
| [ADR-0011](ADR-0011-deterministic-transcript-path-via-pregenerated-session-id.md) | Deterministic transcript path via pre-generated `--session-id` | Accepted |
| [ADR-0012](ADR-0012-shim-executable-path-resolution.md) | Shim executable path resolution | Accepted |
| [ADR-0013](ADR-0013-capture-mode-authoritative-result-source.md) | Capture-mode authoritative result source | Accepted |
| [ADR-0014](ADR-0014-workspace-trust-dialog-handling.md) | Workspace trust-dialog handling | Accepted |
| [ADR-0015](ADR-0015-prompt-injection-typed-input-post-session-start.md) | Prompt injection — typed input post-`SessionStart` | Accepted |
| [ADR-0016](ADR-0016-system-prompt-bundled-into-typed-user-message.md) | System prompt bundled into typed user message | Accepted |

## Supersession graph

```
ADR-0006 ── Superseded by ──> ADR-0016 (extends ADR-0015)
```

## Promotion provenance

ADRs 0001-0016 promoted on 2026-05-24 from the archived change
`2026-05-24-replace-sdk-with-pty-tui` per opsx-superpowers archive
HARD-GATE 3 (deferred from archive run, recovered post-archive). Each
ADR's "Source change" links back to its `design.md` D-block.

Design decisions that did NOT pass the 4-point rubric (scoring ≤2/4 or
borderline ≤3/4 deemed by the change author not worth promoting):
D6, D8, D9, D10, D11, D17, D20, D22, D23, D24. Their content remains
in the archived `design.md` for historical reference.
