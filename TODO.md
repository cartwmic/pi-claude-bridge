# TODO

> **Note (2026-04-25):** the SDK-native refactor on `refactor/sdk-native-inference-only` deletes everything in the previous "Architecture Issues" and "Deferred" sections. The post-abort UUID-rotation race, the JSONL hash mismatch, the cc-session-io coupling, and the deferred-message-replay deadlocks are all gone — not silenced, deleted. The bridge no longer reads or writes `~/.claude/sessions/`, so those failure modes can't occur. See `SCENARIOS.md` and `SCENARIO_RESULTS.md` for the new architecture.

## Features

- **Markdown rendering** in expanded tool result view. Currently plain text. Use `Markdown` from `@mariozechner/pi-tui` with a `MarkdownTheme`.

- **`/claude config` slash command** for runtime configuration. Currently requires editing JSON and `/reload`.

- **`/claude:btw` command** for ephemeral questions: response displayed but not added to LLM context.

- **Audit tool parameter mismatches**: The bash timeout default (120s) was added because pi's bash has no default while Claude Code expects one. Other bridged tools may have similar mismatches (units, defaults, optional-vs-required params). Compare Claude Code's tool schemas against pi's for read, write, edit, grep, find.

## Possible enhancements

- **AskUserQuestion pi shim** (main provider only): CC never sees AskUserQuestion (it's in `DISALLOWED_BUILTIN_TOOLS`), so it can't ask the user questions interactively. Port a pi-native version using `ctx.ui.custom()` for an option picker with free-text fallback. Not applicable to AskClaude subagents (can't interact with user).

- **PlanMode pi shim** (main provider only): Similarly, EnterPlanMode/ExitPlanMode are blocked. A pi-native plan mode could use `pi.setActiveTools()` to restrict to read-only tools, block destructive bash via `tool_call` event, and surface plan approval through pi's TUI.

## Scenario harness

- Add tmux-driven scripts for the remaining scenarios: S2, S3, S4, S5, S8, S9, S10/S10b, S13, S14, S15, S16a, S16b, S17. The infrastructure is in `scripts/scenario-lib.sh`; each new scenario is ~30 lines.

- Switch `scn_send` from "wait for `caching session=` line" to a more robust completion signal once we have a stable structured-diagnostic channel (NDJSON ideal). The current grep-based wait works but is brittle if log format changes.

## Testing gaps

- **`int-session-resume.mjs`** requires a working `CLAUDE_BRIDGE_TESTING_ALT_PROVIDER` / `CLAUDE_BRIDGE_TESTING_ALT_MODEL`. The values shipped in `.env.test` are stale — replace with a current alt provider (e.g. `openai-codex/gpt-5.4-mini`).

- No automated tests for: long-running tool execution (S3), cross-provider subagent (S15), pi `/fork` and `/tree` (S16), pi `/compact` (S17). All are conceptually covered by the architecture's "no compaction-specific code" / "history-shape-change → cold-replay" path, but not exercised.
