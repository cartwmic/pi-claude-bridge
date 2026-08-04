# TODO

> **Note (2026-06-02):** the `replace-sdk-with-claude-p` change deleted the
> in-process Claude Agent SDK driver, the `AskClaude` tool, and the SDK-era
> capture/`outputFormat` path. Inference now drives the interactive `claude`
> TUI via `claude-p` (a stdio MCP shim + an in-process held-open router; the
> bridge never touches the nominal `claude -p`/`--print` surface). The earlier
> in-house `node-pty` plan for this work — node-pty driver, ANSI stripper,
> workspace-trust-dialog scanner, transcript-file tailer, hook-relay — was
> superseded by `claude-p` (which owns the PTY, hooks, ANSI probes, and trust
> dialog) and is not pursued. See `SCENARIOS.md` / `SCENARIO_RESULTS.md` and
> `AGENTS.md` for the architecture.

## Features

- **Markdown rendering** in expanded tool result view. Currently plain text. Use `Markdown` from `@mariozechner/pi-tui` with a `MarkdownTheme`.

- **`/claude config` slash command** for runtime configuration. Currently requires editing JSON and `/reload`.

- **`/claude:btw` command** for ephemeral questions: response displayed but not added to LLM context.

- **Audit tool parameter mismatches**: The bash timeout default (120s) was added because pi's bash has no default while Claude Code expects one. Other bridged tools may have similar mismatches (units, defaults, optional-vs-required params). Compare Claude Code's tool schemas against pi's for read, write, edit, grep, find.

## Possible enhancements

- **AskUserQuestion pi shim** (main provider only): CC never sees AskUserQuestion (it's in `DISALLOWED_BUILTIN_TOOLS`), so it can't ask the user questions interactively. Port a pi-native version using `ctx.ui.custom()` for an option picker with free-text fallback.

- **PlanMode pi shim** (main provider only): Similarly, EnterPlanMode/ExitPlanMode are blocked. A pi-native plan mode could use `pi.setActiveTools()` to restrict to read-only tools, block destructive bash via `tool_call` event, and surface plan approval through pi's TUI.

## claude-p follow-ups

- **Persistent-process optimization** (deferred follow-up change; premise proven, fork feasible — see design "Long-session reliability risk" / `g4-investigation.md`): the single-shot `--resume` model re-spawns a fresh `claude-p` and replays the full transcript every turn, which (a) re-pays the ~1.7s/turn boot tax and (b) hits `claude-p` `StopTimeout` flakiness that worsens as the replayed transcript grows on long sessions — a reliability wall the D33 bounded-retry layer cannot clear (a retry re-hits the same slow replay). Hold one live `claude-p` per pi session (drop `claude-p`'s `session.terminate()`, feed turns into the live PTY) to remove both. Phase-4 (T4.6) should characterize the transcript size at which `StopTimeout` becomes frequent and decide whether this is required vs. optional.

- **Same-provider concurrency cap** (G9 follow-up; recommended, not a cut-over blocker): `claude-p` `StopTimeout` rates climb steeply with concurrent boots (2-way tolerable, ≥3-way mostly failing — all retriable, none correctness-affecting). A deep S14 nest (claude-bridge calling claude-bridge as a subagent, recursively) could spawn enough concurrent `claude-p` to make D33 retries thrash. Add a bridge-wide semaphore/queue bounding concurrent `claude-p` spawns (e.g. ≤2–3) so nested same-provider turns queue rather than contend. D33 retry stays the per-spawn safety net.

- **Capture-path MCP-attach retry**: S25-A2 showed the capture sub-spawn's MCP-attach race fails ~1/3 on haiku — it passes within scenario retries, but the capture path lacks the main path's re-prompt retry on a slow/missing MCP attach. Port the main-path MCP-startup re-prompt retry onto the capture path.

## Scenario harness

- Add tmux-driven scripts for any remaining scenarios not yet scripted. The infrastructure is in `scripts/scenario-lib.sh`; each new scenario is ~30 lines.

- Switch `scn_send` from "wait for `caching session=` line" to a more robust completion signal once we have a stable structured-diagnostic channel (NDJSON ideal). The current grep-based wait works but is brittle if log format changes.

## Testing gaps

- **`int-session-resume.mjs`** requires a working `CLAUDE_BRIDGE_TESTING_ALT_PROVIDER` / `CLAUDE_BRIDGE_TESTING_ALT_MODEL`. The values shipped in `.env.test` are stale — replace with a current alt provider (e.g. `openai-codex/gpt-5.4-mini`).

- No automated tests for: long-running tool execution (S3), cross-provider subagent (S15), pi `/fork` and `/tree` (S16), pi `/compact` (S17). All are conceptually covered by the architecture's "no compaction-specific code" / "history-shape-change → cold-replay" path, but not exercised.
