# Changelog

## Unreleased

### v1.0.0 — PTY-driven `claude` TUI integration (BREAKING)

This release replaces the `@anthropic-ai/claude-agent-sdk` dependency with a `node-pty`-driven invocation of the real interactive `claude` TUI binary. The provider's outward behavior on the main path is unchanged, but the underlying inference channel is now identical to running `claude` interactively. See `openspec/changes/archive/replace-sdk-with-pty-tui/` for the full design.

**BREAKING changes:**

- **`AskClaude` tool REMOVED.** The tool was a thin wrapper around the SDK's one-shot `query()`. With the SDK path removed there is no underlying engine. The `CLAUDE_BRIDGE_ASKCLAUDE_ENABLED` env var no longer has any effect. If you need to delegate to a separate `claude` session, invoke the binary directly via the new pi `bash` tool (`claude --print '...'`) or use a wrapper extension.
- **Runtime dependency on `claude` binary.** v1.0.0 requires `claude` on `$PATH` at first turn (tested-against range: `claude 2.1.x`). Bridge load no longer imports the SDK; missing-binary surfaces as a per-turn error rather than a load-time crash.
- **Streaming granularity change.** Token-level streaming is replaced with per-content-block streaming sourced from `claude`'s transcript JSONL tail. Users will see text appear in sentence-ish chunks rather than per-token; the final assembled message is identical.
- **`@anthropic-ai/claude-agent-sdk` + `@anthropic-ai/sdk` dependencies dropped.**
- **D26 typed-injection (added 2026-05-22 post-scenario-validation):** the pi user prompt is NOT passed as a positional CLI argument to `claude`. Instead, after `SessionStart` hook fires and Ink quiescence is detected (~80ms silent on PTY output), the bridge writes the prompt bytes to the PTY input, waits 120ms (defeats Ink's bracketed-paste burst-merging), then writes `\r` to trigger submit. Reason: positional-prompt invocations triggered `claude`'s internal headless-auto-submit code path whose request shape is rejected by Anthropic's OAuth interactive-mode tier cap (`API Error: 400 "out of extra usage"`) for substantive system prompts. Reference implementation: [`smithersai/claude-p`](https://github.com/smithersai/claude-p). Added latency: ~200ms per turn. SUPERSEDES original D13 in `openspec/changes/replace-sdk-with-pty-tui/design.md`.
- **`--system-prompt-file` is now always used** (regardless of size). Previous 50KB heuristic dropped — typed-injection removed argv pressure, and file form keeps the request shape closer to what a real interactive user generates.

**Added:**

- `CLAUDE_BRIDGE_DRIVER` env var (`sdk` | `pty`) selects the inference driver. Default flips from `sdk` to `pty` in Phase 3 cutover. `sdk` retained transiently for rollback.
- ANSI-aware workspace-trust-dialog scanner (D25) auto-dismisses `claude`'s first-time-cwd dialog so the bridge boots cleanly in fresh-tmpdir capture cwds + first-time pi projects.
- Per-PTY unix-domain socket transport between the in-process router and a multi-mode shim subprocess (`pi-claude-bridge-shim --mode mcp|hook`). The bridge never writes under `~/.claude/`.
- Inline `--settings` + `--mcp-config` + `--strict-mcp-config` + `--setting-sources ""` + `--permission-mode bypassPermissions` + `--session-id <uuid>` for full isolation from user-global Claude Code config (constitution III + IV).
- Bounded post-`Stop` transcript settle window (D17, 250ms default, `CLAUDE_BRIDGE_TRANSCRIPT_SETTLE_MS` override).
- Deterministic transcript path: `~/.claude/projects/<realpath(cwd) '/' → '-'>/<uuid>.jsonl` (D18, Phase-0 F1 realpath correction).
- Capture path: forced MCP tool-call (D5/D16). Deterministic shim response; first-call-wins per D21; v1 schema limitations as in v0.4.0.
- Build pipeline emits to `dist/`; published artifact includes `dist/mcp/shim.js` as a `bin` entry.

**Migration:**

- Update `CLAUDE_BRIDGE_DRIVER` env if you were testing the experimental path; default is `pty` from this version forward.
- Remove any reference to `CLAUDE_BRIDGE_ASKCLAUDE_ENABLED` from settings/env (no-op as of v1.0.0).
- Install `claude` 2.1.x and ensure it's on `$PATH`.
- Re-run any code that depended on token-level streaming granularity — the new bridge emits blocks, not tokens.


## 0.4.0 — 2026-05-05

- **Add: structured output / output-capture tools** — pass `ctx.tools = [captureTool]` with a single unregistered tool to receive a validated `toolCall` content block in the returned `AssistantMessage`, matching the shape direct pi-ai providers return. Uses the SDK's `outputFormat: { type: "json_schema", schema }` option with built-in validation and retry.
- **Capture path is fully isolated** — runs a one-shot `query()` with `cwd: os.tmpdir()`, no shared stack, no session-cache writes, no interference with a concurrent interactive turn.
- **`ctx.systemPrompt` forwarded verbatim** on the capture path (unlike the agent-loop path, which replaces it).
- **`usage` and `cost` propagated** from the SDK result including cache-token accounting; also propagated on SDK validation-failure paths.
- **Rejection errors for invalid call shapes** — multiple capture tools, mixed capture+executable, or non-object root schema all resolve with `stopReason: "error"` before any query is started.
- **v1 limitations:** one capture tool per call; mutually exclusive with executable tools; object-root schema only; `tool.description` is dropped (embed instructions in `systemPrompt` or user message); capture-tool names that collide with active pi tool names route through MCP instead; multi-message history replay is text-only and lossy (images dropped, tool-call args truncated to 200 chars, tool-result content to 500 chars).
- **Downstream:** `pi-session-search`'s `provider !== "claude-bridge"` workaround in `digest/builder.ts` is now deletable — see release notes.

## 0.3.1 — 2026-04-18

- **Fix: empty thinking blocks on Opus 4.7** — Opus 4.7 silently changed default `thinking.display` from `"summarized"` to `"omitted"`, so streams emitted `thinking_start` + `signature_delta` with zero `thinking_delta` events, leaving `ThinkingBlock.thinking == ""`. Now pass `--thinking-display=summarized` via `extraArgs` whenever `effort` is set (both provider and AskClaude paths). Bump `@anthropic-ai/claude-agent-sdk` to ^0.2.111 (required for Opus 4.7 + `--thinking-display` CLI flag). See [anthropics/claude-agent-sdk-python#830](https://github.com/anthropics/claude-agent-sdk-python/pull/830).
- **Fix: `cachePct` debug metric misleading** — denominator was `input + cacheRead`, so once a conversation warmed up (tiny `input`, huge `cacheRead`) every turn rounded to 100% — even turns that rebuilt the cache from scratch. Now `cacheRead / (input + cacheRead + cacheWrite)`, so cache-rebuild turns show a low percentage.
- **Internal: extract pure modules from `index.ts`** — split `models`, `skills`, `session-verify`, `extract-tool-results`, and `query-state` into their own TS files with real unit tests (no more `.js`+`.d.ts` mirror drift). Add `typecheck` script, `typescript` + `tsx` devDeps; test scripts run via `--import tsx`.

## 0.3.0 — 2026-04-17

- **Add: claude-opus-4-7 model** — Added `claude-opus-4-7` as a selectable model. The `opus` shortcut now resolves to 4.7 by default; 4.6 remains available for explicit pinning. Bumped `@mariozechner/pi-ai` to ^0.67.6 to include official model definitions (removed fallback).
- **Refactor: QueryContext class replaces module-level state** — 12 mutable `let` variables + manual `SavedQueryState` push/pop replaced with a `QueryContext` class and context stack. Adding new per-query state is now 1 property instead of 6 edit sites. Fixes `deferredUserMessages` not being isolated across reentrant queries (subagent could consume parent's deferred steers). MCP handlers now close over captured context, abort handler captures context at the correct point after push.
- **Fix: MODELS baseUrl leak** — the MODELS array exported to pi's provider registration now projects only the fields pi needs (id/name/reasoning/input/cost/contextWindow/maxTokens), stripping pi-ai's `baseUrl`/`api`/`provider`/`headers` so they can't shadow the values `registerProvider` supplies.
- **Internal: `repairToolPairing` moved to cc-session-io 0.3.0**; convert logic extracted to `convert.js` with `convert.d.ts` types; various dead-code / type-safety cleanup.

## 0.2.0 — 2026-04-15

- **Fix: stale cursor after tool-using first turn (issue #4)** — after the first turn used tools, the session cursor pointed at the wrong message, causing Claude to re-process stale context. Now correctly advances past all tool_result blocks.
- **Fix: session resume on symlinked paths / CLAUDE_CONFIG_DIR** — cc-session-io now resolves symlinks (realpathSync + NFC) and honors `CLAUDE_CONFIG_DIR`, matching how Claude Code resolves session paths. Fixes "No conversation found" on macOS symlinked dirs. Bump cc-session-io → 0.2.0.
- **Verify-after-write for session files** — warns with diagnostic context if the written session file doesn't round-trip correctly, instead of letting Claude silently resume a corrupt session.
- **Session rebuild preserves sessionId** — provider switches no longer churn UUIDs.
- **CC CLI debug capture** — `CLAUDE_BRIDGE_DEBUG=1` now also writes Claude Code's own debug stream to `~/.pi/agent/cc-cli-logs/`, one file per query.
- **Fix: debug() logged Error objects as `{}`** — now formats with message and stack.
- **Repair orphan tool_use/tool_result pairs before import** — prevents potential API 400s when history starts mid-turn after a provider switch.

## 0.1.6 — 2026-04-10

- **Fix: steer messages during tool execution now reach Claude** — when a user sends a steer while a tool is executing, pi injects it into context alongside the tool result. The bridge previously only processed tool results in this path, silently dropping the steer. Now detected and replayed as a continuation query after the current query completes.
- **Fix: "No conversation found with session ID" in dirs with dots/underscores/spaces** — bump `cc-session-io` to 0.1.2; `projectPathToHash` now matches the CLI's sanitization (`/[^a-zA-Z0-9]/g` → `-`) instead of only replacing slashes
- **Fix: steer/followUp during tool execution no longer hangs** — `extractAllToolResults` now walks past injected user messages instead of stopping at them
- **ID-based tool result matching** — tool results are matched to MCP handlers by `toolCallId` instead of FIFO position; eliminates silent wrong-result delivery if order diverges
- Add integration tests for tool execution scenarios (normal, followUp, steer, parallel+steer, abort) with auto-restart on failure
- Add `defaultIsolated` config option for AskClaude
- Remove skill path aliasing (`.pi/` → `.claude/` round-trip); pass through real paths instead
- Rewrite skills block to reference MCP-bridged read tool (`mcp__custom-tools__read`)
- **Fix: AskClaude action summary showed raw SDK tool names** — normalize `mcp__custom-tools__*` and SDK names at creation; hide redundant `BashOutput` and recursive `AskClaude`; collapse only consecutive same-tool calls
