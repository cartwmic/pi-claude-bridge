## Why

The bridge currently depends on `@anthropic-ai/claude-agent-sdk` for every inference call. The owner no longer trusts the SDK — nor the nominal headless `claude -p` (`--print`) surface it wraps — as a durable execution surface (auth-model coupling, feature drift vs. the user-facing TUI, and the risk that Anthropic restricts headless/programmatic use). Constitution principle III ("no filesystem coupling to the inference driver's mutable state") already commits to treating the driver as a black box; this change extends that spirit to runtime coupling.

**Hard constraint (replan, 2026-05-31):** the bridge MUST completely avoid the nominal `claude -p` surface. The inference surface Anthropic is most committed to keeping unrestricted for personal subscriptions is the **interactive** `claude` TUI. We therefore drive the interactive TUI — but rather than build and maintain an in-house `node-pty` driver (the prior plan for this change), we delegate all terminal-driving to **`smithersai/claude-p`**, an external wrapper that emulates `claude -p`'s ergonomics by driving the interactive TUI inside its own PTY. `claude-p` is adopted as a dependency and **forked/patched if needed**.

**Acceptance bar (replan):** this change is not "done" until the full pi-TUI scenario suite (S0–S26, ~28 scripts under `scripts/run-scenario-*.sh`) passes, OR a specific scenario carries a documented fundamental architectural/design exemption. No silent skips.

**Phase-0 spike (2026-05-31, claude 2.1.159 + claude-p 0.1.0) — *architectural-thesis* gate cleared (reproducible artifact: `.spike-notes/claude-p-gate/`):** Claude Code is an **agent loop**, not a completion endpoint — there is no `--max-turns` / stop-at-tool-use seam in the base CLI; it executes tools itself. The ONLY way pi can execute tools (constitution: "pi executes all tools") is for the bridge to **be the MCP server and hold the `tools/call` open inline** while pi computes the result. The CLI blocks on that held call (verified: 4–5s artificial holds reproduced exactly, on `-p` and — for a SINGLE round — **through claude-p**). Therefore the bridge's "one invocation per pi turn + park-the-promise" model is **structurally forced by Claude Code, not accidental complexity** — and it is preserved. claude-p's `--output-format stream-json --verbose` flushes transcript lines **live** (per-block), handles the workspace-trust dialog itself (ran in an untrusted dir with no hang), and exposes `usage`/cache tokens on the `result` envelope.

**Not yet proven — behavioral hard gates G1–G9 + G-resume (design.md). All BLOCK Phase-3 cut-over EXCEPT G6/S5, which may ship as a documented exemption:** multi-round held blocking (G1); constitution-IV isolation *through claude-p* via `--disallowedTools`/`--strict-mcp-config`/`--setting-sources ""` — claude-p reserves `--settings`, so the previously-verified deny layer is replaced by an unverified forwarding contract (G2, non-negotiable); turn-end + per-turn cache-shape across tool rounds (G3); warm-resume cache reads (G4); S7/S13 abort-coherence under cold-replay (G5); S5 mid-stream steer (G6); `--timeout` not tripping on a held call (G7); cross-channel tool-call correlation across the split shim/stdout channels incl. parallel tools/S11 (G8); concurrent spawns — capture+main/S25 AND nested same-provider subagents/S14 — incl. `WaitForMcpServers` (G9); `--input-file`/`--system-prompt-file` forwarding (G-resume). The SDK path stays as the rollback fallback until every blocking gate is green or the claude-p fork is in place — the irreversible SDK deletion does not precede these verifications.

## What Changes

- **BREAKING** Remove the `@anthropic-ai/claude-agent-sdk` runtime dependency. Replace the SDK's `query()` driver with a subprocess invocation of **`smithersai/claude-p`** (interactive TUI driver). The bridge never invokes nominal `claude -p`/`--print` itself.
- **BREAKING** Remove the `AskClaude` tool, its config surface (`askClaude.*`), and the `CLAUDE_BRIDGE_ASKCLAUDE_ENABLED` env switch. The feature is dropped, not migrated.
- The bridge consumes claude-p's `--output-format stream-json --verbose` **stdout** as its event stream (per-content-block: text, thinking, tool-use, tool-result, usage). The bridge does NOT tail transcript JSONL itself and does NOT read anything under `~/.claude/` — claude-p does any transcript reading internally, as a black box. (This satisfies constitution III more strongly than the prior plan; the 2026-05-21 exemption (b) becomes moot — see design Replan Amendment.)
- Bridge pi tools to the driver via a **stdio MCP shim subprocess** (`--mcp-config` → shim → bridge's in-process router over a per-spawn unix socket). The router **parks a Promise on each `tools/call` and resolves it when pi delivers the tool result via the next `streamSimple()`**. claude-p (and the underlying `claude`) blocks on the held MCP call until then — the load-bearing mechanism the spike validated.
- Reimplement **capture mode** as a forced MCP tool-call: the capture tool is the sole advertised MCP tool, native tools are disallowed, schema enforcement happens at the shim, and the validated arguments are harvested via IPC (D5/D16/D21 retained verbatim).
- Configure the driver via claude-p flags: `--model`, `--system-prompt` (forwarded; `--input-file` for large/multiline prompts), `--mcp-config` (the shim), `--disallowedTools` (native-tool blocking per constitution IV — claude-p **reserves `--settings`** for its own hooks, so the prior `--settings permissions.deny` mechanism is replaced by `--disallowedTools`, which claude-p forwards to `claude`), `--setting-sources`/`--strict-mcp-config` (forwarded) for isolation, `--session-id`/`--resume` for the in-memory cache hint, `--permission-mode bypassPermissions`, `--output-format stream-json --verbose`, `--timeout`.
- The bridge no longer registers `SessionStart`/`Stop` hooks or runs a hook-relay subprocess — **claude-p owns hook registration, prompt-typing, ANSI terminal-probe responses, and the workspace-trust dialog.** The prior plan's `src/driver/{pty,ansi}.ts`, trust-dialog scanner, and the shim's hook-relay dual-mode are **dropped**.
- macOS and Linux only (claude-p is darwin/linux; requires `forkpty`).
- **S5 (mid-stream steer) is the one at-risk scenario.** claude-p is one-prompt-per-spawn with no mid-turn input channel. Steering is handled bridge-side as **abort-current-spawn + respawn with the steer** (the coherence probe still passes because both user messages live in pi's history), OR — if that proves insufficient — by forking claude-p to type a second message mid-turn. Final disposition recorded in design D-S5; if exempted, it is the documented architectural exemption the acceptance bar permits.

## Capabilities

### New Capabilities

- `claude-p-driver`: subprocess invocation of the `claude-p` interactive-TUI driver. Owns process lifecycle (spawn, abort via SIGINT, kill), flag assembly, and the mapping from pi turn to claude-p invocation. Replaces the prior `claude-tui-driver` (in-house node-pty) capability.
- `mcp-stdio-shim`: subprocess that exposes pi-bridged tools to the driver as a stdio MCP server and forwards calls to the bridge's in-process router (the held-open promise-park). Defense-in-depth blocker for any non-pi tool name. (Hook-relay role from the prior plan removed — claude-p owns hooks.)
- `transcript-stream`: parses claude-p's `--output-format stream-json` stdout during an in-flight turn, emits structured events (text-delta, tool-use, thinking-delta, end-turn, usage) to the bridge's stream layer, filtering claude-p's interactive-schema noise lines.

### Modified Capabilities

- `output-capture`: reimplemented on the claude-p driver using a forced MCP tool-call. External call-shape (`piAi.complete` with `ctx.tools = [captureTool]`) is unchanged; v1 limitations preserved. Internal classification, validation, and isolation invariants preserved verbatim.

## Impact

**Dependencies**
- Remove: `@anthropic-ai/claude-agent-sdk`, `@anthropic-ai/sdk` (used only by the SDK path's type imports).
- Add: `claude-p` (smithersai/claude-p; npm prebuilt for darwin/linux × x64/arm64; Zig 0.15.2 only needed to fork/build). A vendored fork is in scope if patches are required.
- Add: `@modelcontextprotocol/sdk` for the stdio MCP shim's server side.
- Keep: `pino`, `rotating-file-stream`, `change-case`, `@sinclair/typebox`, `zod`.
- **Dropped vs prior plan:** `node-pty` is NOT added (claude-p owns the PTY); the node-pty `spawn-helper` postinstall chmod (prior R19) is moot.

**Affected code**
- `index.ts` (1805 lines today): SDK-specific machinery deleted (`_queryFactory`, `createSdkMcpServer` wiring, SDK `runCaptureQuery`, `runAskClaude`, `wireAskClaudeTool`); turn lifecycle / stream consumer rewritten against claude-p's stdout; conversation-state machinery preserved (history-divergence detection, abort coordination, supersede, cache hint).
- `convert.ts`, `models.ts`: stay (driver-agnostic).
- New modules:
  - `src/driver/claudeP.ts` — claude-p subprocess spawn, flag assembly, abort/kill lifecycle.
  - `src/driver/stream.ts` — claude-p stream-json stdout parser + event emitter (the `transcript-stream` capability).
  - `src/mcp/shim.ts` — stdio MCP server entry point (separate executable).
  - `src/mcp/router.ts` — in-process tool-call router (parks/resolves Promises).
  - `src/mcp/ipc.ts` — per-spawn unix-socket transport between shim and router.
  - `src/capture.ts` — capture-mode wiring on top of the driver + mcp.

**APIs**
- `piAi.complete()` (main + capture paths): behavior preserved; per-block (not per-token) streaming documented in CHANGELOG.
- Public extension entry point (`export default function (pi: ExtensionAPI)`): preserved.
- `AskClaude` tool: **removed** (breaking).

**Tests**
- `tests/int-*` integration tests: rewritten against the claude-p driver. Unit tests survive structurally.
- New tests: claude-p spawn smoke, stream-json parser (interactive-schema lines), MCP shim handshake + held-open round-trip, capture forced-tool-call, native-tool-block via `--disallowedTools`.
- **Scenario gate:** the full S0–S26 suite must pass (or carry a documented exemption) before cut-over — this is the completion bar, enforced in Phase 4.

**Config**
- Remove `askClaude.*` keys and `CLAUDE_BRIDGE_ASKCLAUDE_ENABLED`. `CLAUDE_BRIDGE_DEBUG*` preserved. Add (if needed) a `claudeP.*` block for tunables (timeout, claude-p binary path / fork override).

**Documentation**
- README: remove AskClaude; rewrite Provider section for the claude-p mechanism; document the "never nominal `claude -p`" stance and the pinned tested `claude` + `claude-p` version range.
- CHANGELOG: breaking-release entry (SDK removal, AskClaude removal, streaming-granularity change). 1.0.0 major bump recommended.
- TODO.md: prune SDK-era items.

**Operational risk**
- claude-p is **v0.1.0** (very early) and showed **concrete reliability flakiness** in the cache spike: 3/3 plain-prompt turns failed with `SessionStartTimeout`/`StopTimeout` (hook-detection timeouts), while an MCP-tool turn succeeded. This materially raises the likelihood of vendoring/forking claude-p (T4.10) for stability, independent of the feature gates. Its stream-json passthrough, flag-forwarding, and trust-dialog handling are the integration surface. Pin tested versions; vendor a fork if upstream drifts.
- Cold interactive-TUI boot is **heavier than `-p`** (~5s/turn observed; ~17s for an MCP-tool turn incl. generation). claude-p is one-shot, so **every pi turn re-pays process boot** — warm `--resume` preserves the prompt-cache but NOT the process. The D33 resilience retries add up to ~2–3 extra boots (~+10–15s) on a flaky turn. **Latency budget (design D33):** keep `boot + max_tool_wait + retries × boot` under the acceptable p99; if it can't hold, the deferred **warm-PTY pool** becomes required, not optional. T4.6 benchmarks this and decides.
- claude-p reserves `--settings` — native-tool blocking depends on `--disallowedTools`/`--strict-mcp-config`/`--setting-sources` actually forwarding and being honored (Phase-1 verification; constitution IV is non-negotiable).
- Driver couples to claude-p's emitted interactive-transcript schema (noise lines, `result` without `stop_reason`, `WaitForMcpServers` built-in). Parse with explicit guards + drift detection; surface unknown shapes per constitution VII.

**Affects which projects**
- This repo only. Downstream pi users who rely on AskClaude see a breaking change at upgrade.
