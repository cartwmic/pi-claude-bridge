# Changelog

## Unreleased

- **Add: `/claude-peek` live overlay** — toggle a live, read-only
  picture-in-picture view of the underlying Claude Code TUI inside the pi
  terminal (nonCapturing top-right overlay; explicit idle/error states;
  ≤20 updates/s). Backed by a new write-only `--mirror-file` tee in the
  claude-p fork (pin bumped to 27376d0) and a headless 120×40 terminal
  emulator (`@xterm/headless`, new dependency). Mirror files live under
  `<tmpdir>/claude-bridge-peek/` (override `CLAUDE_BRIDGE_PEEK_DIR`, keep
  last 5); main-provider spawns only. Peek failures can never affect the
  inference turn. New e2e scenario S31.
- **Add: claude-sonnet-5 and claude-fable-5 models** — Added `claude-sonnet-5` and `claude-fable-5` to `MODEL_IDS_IN_ORDER`, making them selectable in the picker. The `sonnet` shortcut still resolves to `claude-sonnet-4-6` (listed first); `fable` is a distinct family with no shortcut collision. Both require a runtime `@mariozechner/pi-ai` that exposes the matching model definition (silently dropped from the picker otherwise); the bundled pi runtime pi-ai already does.
- **BREAKING: no liveness/wedge timeouts.** The held-round-aware idle **watchdog** (`CLAUDE_BRIDGE_WATCHDOG_IDLE_MS`) and claude-p's wall-clock `--timeout` backstop (`CLAUDE_BRIDGE_CLAUDE_P_TIMEOUT_SECONDS`) are **removed**, along with the `ClaudePHandle.killWedged()` driver method. A silent `claude-p` is no longer guessed-as-wedged and SIGKILLed on a timer; recovery is caller-driven abort (pi's `AbortSignal` → SIGINT → grace → SIGKILL of the process group) plus the existing bounded retry on a real `error`-classified premature exit. Both env knobs no longer exist; an unattended-batch ceiling belongs to the supervisor (abort the turn).
- **Add: driver visibility (handle hangs reactively).** Each `claude-p` spawn now tees its child **stderr** to a per-spawn file (`claude-p-stderr-<sid>-<pid>-<ts>.log`) in the bridge debug dir, and the last stderr lines are folded into the surfaced error message on a premature exit (so `PromptNotAccepted` / `StopTimeout` / upstream stream errors are observable). On any abnormal termination the bridge logs an in-flight state dump (`claudeP.lifecycle.stateDump`: last-delta age, held-round flag, partial-buffer length). The child `claude`'s own debug log is forwarded via `--debug-file` to a bridge-owned path (always on; disable with `CLAUDE_BRIDGE_CLAUDE_DEBUG_FILE=0`) — feasible with no claude-p fork because claude-p forwards unrecognized flags verbatim to `claude`. No diagnostics are written under `~/.claude/`.
- **Add: claude-opus-4-8 model** — Added `claude-opus-4-8` as a selectable model. The `opus` shortcut now resolves to 4.8 by default; 4.7 and 4.6 remain available for explicit pinning. Requires a runtime `@mariozechner/pi-ai` that exposes the `claude-opus-4-8` model definition (silently dropped from the picker otherwise).

## 0.5.0 — 2026-06-02

- **BREAKING: inference now drives the interactive `claude` TUI via [`claude-p`](https://www.npmjs.com/package/claude-p), not the Claude Agent SDK.** The in-process `@anthropic-ai/claude-agent-sdk` `query()` path is gone; every turn is one `claude-p` spawn that drives the same interactive session a human would. The bridge **never** shells out to the nominal `claude -p` / `--print` surface. The `@anthropic-ai/*` dependencies are removed. `CLAUDE_BRIDGE_DRIVER` defaults to `claude-p` and is the only supported value — setting `CLAUDE_BRIDGE_DRIVER=sdk` (or anything other than `claude-p`) now fails fast with a deprecation error at load time instead of silently falling back. macOS and Linux only (`claude-p` requires `forkpty`).
- **BREAKING: the `AskClaude` tool is removed.** Its config surface (`askClaude.*`) and the `CLAUDE_BRIDGE_ASKCLAUDE_ENABLED` switch are dropped, not migrated. Downstream users that called `AskClaude` will need to remove those references.
- **Change: streaming is per-block, not per-token.** `claude-p` flushes its `--output-format stream-json` transcript live at content-block granularity (text, thinking, tool-use, tool-result), so deltas arrive per block rather than per token. `usage` (including cache-token accounting) and `cost` are reported once per spawn at turn end rather than incrementally.
- **New: stdio MCP shim + in-process held-open router.** pi's tools are exposed to `claude` through a stdio MCP server the bridge spawns; an in-process router parks each `tools/call` open while pi computes the result and resolves it on the next turn. This held-open mechanism is what lets a single interactive spawn span an arbitrary number of pi-executed tool rounds. The bridge keeps the claude session id in memory only as a prompt-cache resume hint — it never reads or writes `~/.claude/sessions/`. Aborts SIGINT the `claude-p` process group; there is no session-file surgery.
- **New: structured output / capture via a forced MCP tool-call.** The capture path (`piAi.complete` with `ctx.tools = [captureTool]`) is reimplemented on the driver: the capture tool is the sole advertised MCP tool, native tools are disallowed, schema enforcement happens at the shim, and the validated arguments are harvested over IPC. The external call shape and the v1 limitations from 0.4.0 are preserved; the SDK `outputFormat` mechanism it replaces is gone.

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
