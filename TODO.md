# pi-claude-bridge TODO

## v1.0.0 status

The PTY-driven driver swap (openspec change `replace-sdk-with-pty-tui`)
is complete. The bridge now drives the interactive `claude` TUI via
node-pty instead of `@anthropic-ai/claude-agent-sdk`. See `CHANGELOG.md`
for the BREAKING-change rundown.

## v1.1.0 follow-up (deferred from v1.0.0 apply)

These tasks live in `openspec/changes/archive/replace-sdk-with-pty-tui/tasks.md`
as deferred items per `verify.md`:

- **Physical delete of SDK code path.** The SDK code is unreachable at
  runtime (driver='sdk' is rejected at module load) but still imports
  and types from `@anthropic-ai/*`. v1.1.0 will physically remove:
  - `_realQuery`, `_queryFactory`, `__setQueryFactoryForTests` test seam
  - `createSdkMcpServer` MCP wiring
  - SDK-backed `runCaptureQuery`
  - QueryFrame stack machinery (replaced by router pendingResolvers)
  - All `@anthropic-ai/*` imports
- **Drop `@anthropic-ai/claude-agent-sdk` + `@anthropic-ai/sdk` from package.json.**
- **PTY-path caching.** v1.0.0 PTY path cold-starts every turn. v1.1.0
  reintroduces session caching via `--resume` per
  `claude-tui-driver.cached-driver-session-is-a-hint-only`.
- **CI matrix** (T4.4) and **tarball verify** (T4.4a).
- **Rollback rehearsal script** (T4.6a).
- **Capture-mode termination latency benchmark** (T4.8).
- **Constitution III audit script** (T4.2) — manual audit done in v1.0.0.

## v1.0.x in-version follow-ups

- Run the integration tests (`tests/int-*.sh`) on machines with `claude`
  installed and an Anthropic auth source. Tests are scaffolded but not
  yet exercised in this repo's CI.
