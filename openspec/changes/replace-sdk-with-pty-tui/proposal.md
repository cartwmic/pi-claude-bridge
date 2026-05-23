## Why

The bridge currently depends on `@anthropic-ai/claude-agent-sdk` for every inference call. The owner no longer trusts the SDK as a durable execution surface (auth model coupling, feature drift vs. the user-facing TUI, risk of restrictions on headless/programmatic use). Constitution principle III ("no filesystem coupling to the inference driver's mutable state") already commits to treating the inference driver as a black box; this change extends the spirit of that principle to also avoid runtime coupling to the SDK as a library. After the change, the bridge speaks only to the user-facing `claude` interactive TUI binary, configured via inline flags and read-only transcript JSONL — the same contract a human user gets, with no SDK in the dependency graph.

## What Changes

- **BREAKING** Remove `@anthropic-ai/claude-agent-sdk` runtime dependency. Replace the SDK's `query()` driver with a PTY-driven invocation of the real `claude` interactive TUI binary using `node-pty`.
- **BREAKING** Remove the `AskClaude` tool, its config surface (`askClaude.*`), and the `CLAUDE_BRIDGE_ASKCLAUDE_ENABLED` env switch. The feature is dropped, not migrated.
- Stream assistant output by tailing the inference driver's transcript JSONL (path delivered via `Stop` hook payload), not via per-event SDK iterator. Granularity becomes per-content-block rather than per-token.
- Bridge pi tools via a **stdio MCP shim subprocess** that the bridge spawns alongside each `claude` PTY. The shim speaks MCP on stdin/stdout to `claude` and proxies calls back to the bridge's in-process router over a unix-domain socket / named pipe.
- Reimplement **capture mode** on top of the new driver as a forced MCP tool-call: the capture tool is registered as the sole MCP tool, all native tools are disallowed, and the model's tool-use block becomes the structured output. Schema enforcement happens at the shim's MCP request handler (JSON-schema validation before forwarding); on a valid call the shim returns a deterministic success MCP response and the bridge harvests the validated arguments via IPC. The `ctx.systemPrompt` is forwarded verbatim per constitution V — no capture-only addendum is appended. Steering relies on (a) the sole-tool advertisement (the model has no other MCP tool to call), (b) the deterministic shim response, (c) the disallow-set blocking any native-tool alternative. If the model emits text alongside the tool call, the text is ignored (clarify I3). Image-bearing capture inputs are NOT supported in v1 — callers passing image content blocks on the capture path receive `stopReason: "error"` with a documented v1-limitation message.
- Configure the driver entirely via inline `--settings '<json>'`, `--mcp-config '<json>'`, `--strict-mcp-config`, `--setting-sources ""`, `--permission-mode bypassPermissions`, `--session-id <pre-generated-uuid>`, and `--system-prompt[-file]` flags + hook handlers (`SessionStart`, `Stop`). The pi user prompt is delivered by typing into the TUI input post-`SessionStart` (per design D26), NOT as a positional CLI argument — the positional form triggers `claude`'s internal headless-auto-submit code path which is rejected by Anthropic's OAuth interactive-mode tier cap. No reads or writes anywhere under `~/.claude/` other than reading a transcript JSONL file at a path the bridge deterministically computes from the pre-generated session UUID (real location format: `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`, where `<encoded-cwd>` is the cwd with `/` replaced by `-`). The hook-delivered `transcript_path` is treated as a confirmation cross-check, not the discovery mechanism.
- Hooks in interactive mode are SUBPROCESS COMMANDS (per `claude`'s hook contract; `--include-hook-events` only works with `--print`). The bridge registers only `SessionStart` (a confirmation that the model run has begun) and `Stop` (the signal to drain the transcript). `PreToolUse` was considered as informational defense-in-depth but dropped: the per-tool-emission subprocess fork cost outweighs its observability value, which the MCP shim's `tools/call` log already provides in-process. A single `pi-claude-bridge-shim` binary serves both roles — stdio MCP server when invoked with `--mode mcp`, hook-payload relay when invoked with `--mode hook --event <name>` — connecting back to the long-lived bridge process via a per-PTY unix-domain socket.
- macOS and Linux only. Drop any latent Windows path — `node-pty` works there via ConPTY but the project does not commit to supporting it.
- Update `disallowedTools` enforcement to use the driver's settings/flags surface rather than the SDK `options.disallowedTools` array, preserving constitution principle IV.

## Capabilities

### New Capabilities

- `claude-tui-driver`: PTY-driven invocation of the `claude` interactive TUI binary. Owns process lifecycle (spawn, abort, kill), hook configuration, and the mapping from pi turn to `claude` session.
- `mcp-stdio-shim`: subprocess that exposes pi-bridged tools to `claude` as a stdio MCP server and forwards calls to the bridge's in-process router. Defense-in-depth blocker for any non-pi tool name.
- `transcript-stream`: tails the driver's transcript JSONL during an in-flight turn, emits structured events (text-delta, tool-use, thinking-delta, end-turn, usage) to the bridge's stream layer.

### Modified Capabilities

- `output-capture`: reimplemented on the PTY driver using a forced MCP tool-call instead of the SDK's `outputFormat`. External call-shape (`piAi.complete` with `ctx.tools = [captureTool]`) is unchanged; v1 limitations from the original spec remain. Internal classification, validation, and isolation invariants are preserved verbatim.

## Impact

**Dependencies**
- Remove: `@anthropic-ai/claude-agent-sdk`, `@anthropic-ai/sdk` (used only by the SDK path's type imports).
- Add: `node-pty` (microsoft/node-pty, current 1.1.0).
- Add: `@modelcontextprotocol/sdk` (or equivalent) for the stdio MCP shim's server side.
- Keep: `pino`, `rotating-file-stream`, `change-case`, `@sinclair/typebox`, `zod`.

**Affected code**
- `index.ts` (1805 lines today): ~30% deleted (SDK-specific machinery: `_queryFactory`, `createSdkMcpServer` wiring, `runCaptureQuery` via SDK, `runAskClaude`, `wireAskClaudeTool`). ~40% rewritten (turn lifecycle, frame state, stream consumer). ~30% preserved (history-divergence detection, message conversion, abort coordination, model registration, config loading).
- `convert.ts`: stays — the message-conversion logic is driver-agnostic.
- `models.ts`: stays.
- New modules (proposed structure, finalized in design.md):
  - `src/driver/pty.ts` — PTY spawn, hook injection, lifecycle.
  - `src/driver/transcript.ts` — JSONL tailer + event emitter.
  - `src/mcp/shim.ts` — stdio MCP server entry point (separate executable).
  - `src/mcp/router.ts` — in-process tool-call router the shim talks to.
  - `src/capture.ts` — capture-mode driver wiring on top of `driver/pty.ts`.

**APIs**
- `piAi.complete()` with `ctx.tools = [captureTool]`: behavior preserved.
- `piAi.complete()` for normal turns: behavior preserved (per-block streaming instead of per-token is a minor UX-tier change; documented in CHANGELOG).
- Public extension entry point (`export default function (pi: ExtensionAPI)`): preserved.
- `AskClaude` tool: **removed**. Consumers that referenced it must migrate (likely: invoke `claude` directly themselves, or use an alternative provider).

**Tests**
- `tests/int-*` integration tests: most will need rewriting against the PTY driver. The unit tests (queue, import, skills) survive structurally.
- New tests required: PTY driver smoke, transcript tailer, MCP shim handshake, capture-mode forced-tool-call, hook-payload contract assertions.

**Config**
- `~/.pi/agent/claude-bridge.json` / `.pi/claude-bridge.json`: remove `askClaude.*` keys. Add (if needed) `pty.*` configuration block for tunables (timeout defaults, hook overrides).
- Env: remove `CLAUDE_BRIDGE_ASKCLAUDE_ENABLED`. `CLAUDE_BRIDGE_DEBUG*` preserved.

**Documentation**
- README rewrite for the AskClaude section (removed) and the Provider section (mechanism change).
- CHANGELOG entry as a breaking release.
- TODO.md cleanup of items that referenced the SDK path.

**Affects which projects**
- This repo only. Downstream pi users who rely on AskClaude will see a breaking change at upgrade.

**Operational risk**
- The PTY driver couples to public hook payload contracts (`SessionStart`, `Stop`, transcript JSONL shape). Anthropic changing these is a real-API-level change, not a UI tweak — moderate but bounded risk.
- TUI boot latency (~1–3s per `claude` spawn) impacts capture mode per call; deferred mitigation (PTY pool) is out of scope for this change.
- `claude` interactive mode may issue terminal-emulator queries (DEC primary/secondary device attributes, XTVERSION, DSR, window-size) during boot. `node-pty` provides a real pseudoterminal; whether that is sufficient or whether the bridge must respond to those queries (per `smithersai/claude-p`'s approach) is a Phase 0 spike. If insufficient, the bridge embeds a small ANSI responder before forwarding output to the transcript stream.
- Interactive mode does NOT support `--no-session-persistence` (that flag is `--print`-only). Every bridge-spawned PTY therefore writes a transcript file under `~/.claude/projects/` that survives the turn. The bridge does not clean these files (constitution III forbids writes); they accumulate at the same rate the user's own `claude` usage produces them.

**Affected files (current best estimate; refined in design.md)**
- `index.ts` — retained as the top-level pi extension entrypoint (referenced by `package.json` `pi.extensions: ["./index.ts"]`); contents become a thin wrapper that imports from `dist/` after build. Pi's extension loader is documented to handle `.ts` via its built-in TypeScript-aware loader, so the top-level `.ts` file stays — only the implementation moves into compiled `src/` modules
- `package.json` — dependency swap; `files` whitelist expansion to include both `index.ts` AND `dist/**`; `bin` entry for the shim/hook-relay binary; `pi.extensions` field UNCHANGED (`["./index.ts"]`)
- new build pipeline (`tsconfig.build.json`, `npm run build` script) producing JS in `dist/` for the runtime-loaded modules (driver, mcp, capture). The top-level `index.ts` is NOT built; pi's loader handles it at runtime
- `tests/int-*.{sh,mjs}` — rewrite or replace
- `tests/unit-*.mjs` — preserve, possibly extend
- `README.md` — section rewrites
- `CHANGELOG.md` — breaking-release entry (1.0.0 major bump recommended given SDK removal + AskClaude removal + streaming-granularity change + cold-start prompt formatting; final version decision deferred to release time)
- `TODO.md` — prune SDK-era items
