# Phase 0 Spike Status — COMPLETE

Session: 2026-05-21 (continuation of openspec apply for `replace-sdk-with-pty-tui`).

## All spikes resolved

| Spike | Status | Headline |
|---|---|---|
| T0 (binary version) | ✓ | `claude 2.1.114 (Claude Code)`; tested-against range = `>=2.1.x <2.2.x` |
| T0.1 (interactive --system-prompt) | ✓ PASS | sentinel returned verbatim in interactive mode |
| T0.2 (thinking blocks in transcript) | ✓ PASS | `--effort high` + complex prompt → transcript has `{type:"thinking", thinking, signature}` block alongside `text` |
| T0.3 (Stop hook payload + usage shape) | ✓ PASS | NO separate `result` entry; usage lives on `assistant.message.usage`; Stop hook stdin includes `last_assistant_message` |
| T0.4 (fs.watch reliability macOS) | ✓ PASS | `fs.watch(parent, {recursive:true})` fires ≥5× during a single turn, first @ ~400ms |
| T0.5 (mid-turn session_id rotation) | ✓ PASS | session_id STABLE across multi-turn; PTY stdin writes deliver second turn; Stop hook fires once per turn |
| T0.6 (node-pty terminal-query needs) | ✓ PASS | node-pty alone sufficient; no terminal-query responder needed |
| T0.7 (--setting-sources isolation) | ✓ PASS (basic) | flag accepted; user's PreToolUse/UserPromptSubmit hooks did NOT fire in T0.14 spawn → behavioral isolation confirmed. Deep MCP isolation deferred to Phase 1 integration. |
| T0.8 (--system-prompt + CLAUDE.md leak) | ✓ PASS | interactive: `--system-prompt` REPLACES, project CLAUDE.md does NOT leak (no canary in reply); confirms constitution V is satisfied |
| T0.10 (--json-schema availability) | ✓ PARTIAL | flag exists; works under `--print`. Interactive availability unverified but `--print` suffices for capture-mode if needed. Bridge sticks with forced-MCP-tool-call for v1 (D5). |
| T0.11 (cold-start prompt size) | ✓ PASS | **`--system-prompt-file <path>` exists and works in BOTH `--print` and interactive modes** (undocumented in help, referenced in `--bare` description). Sidesteps argv ceiling (~256 KB observed) for arbitrary-size cold-start replays. **Update D7-final**: cold-start large prompts use `--system-prompt-file <tempfile>`; small prompts continue to use `--system-prompt <text>`. |
| T0.12 (--session-id transcript path) | ✓ PASS | path = `~/.claude/projects/<realpath(cwd) "/" → "-">/<uuid>.jsonl` confirmed; `--session-id` honored |
| T0.13 (hook payload shapes) | ✓ PASS | SessionStart stdin: `{session_id, transcript_path, cwd, hook_event_name, source, model}`. Stop stdin: `{session_id, transcript_path, cwd, permission_mode, hook_event_name, stop_hook_active, last_assistant_message}`. Hook stdout: `{}` (empty object) acceptable. |
| T0.14 (HARD GATE — interactive liveness) | ✓ PASS | with `TrustDialogScanner` attached: dialog detected @ 279ms, hooks fired, transcript appeared, PTY alive, Stop hook fired on SIGINT |

## Key empirical findings carried into T0.9

1. **D17 update:** transcript terminal entry is `system / stop_hook_summary` (NOT a `result` entry). Settle-window detector should match this OR Stop-hook-fire-then-grace.

2. **D4 update:** `assistant.message.content` blocks are the streaming surface. Block types observed: `text`, `thinking`. Future: `tool_use`, `redacted_thinking`. Each new `assistant` JSONL line = one complete model turn.

3. **D7-final extension:** when cold-start replay text exceeds 50 KB (heuristic — well under macOS argv ceiling but with margin), use `--system-prompt-file <tempfile>` instead of `--system-prompt <text>`. Tempfile lives in `os.tmpdir()`, deleted after spawn lifetime.

4. **D6 (terminal queries):** confirmed no responder needed. Drop R11 from analyze.md.

5. **D11 layer-2 fallback NOT needed:** `--setting-sources ""` works in practice (T0.14 + T0.7 confirms user's hooks didn't leak). Per-PTY `HOME=<scratch>` override is on standby but not v1-required.

6. **D9 SessionStart:** payload reliably carries `transcript_path` in interactive mode (matches D18-computed path). Cross-check implementable as planned.

7. **Stop hook `last_assistant_message`:** unexpected second delivery channel for plain-text answer. Bridge uses transcript tail as authoritative (structured blocks); Stop's `last_assistant_message` is a defense-in-depth sanity check.

8. **Phase 0 F1 / F2 / F3 / F4 from earlier still hold:**
   - F1 (realpath cwd encoding) → D18 amended
   - F2 (node-pty spawn-helper +x) → T1.2a postinstall
   - F3 (workspace trust dialog) → D25 scanner (now verified)
   - F4 (skill_listing attachment regardless of --system-prompt) → use `--disable-slash-commands` for capture-mode only (defense for constitution V verbatim)

## Files produced

- `.spike-notes/00-claude-version.md` (T0)
- `.spike-notes/08-system-prompt.md` (T0.8 original -p test)
- `.spike-notes/14-liveness.md` (T0.14 initial FAIL → triggered D25)
- `.spike-notes/14b-liveness.md` (T0.14 RE-RUN PASS)
- `.spike-notes/14-liveness-runner.mjs` (initial)
- `.spike-notes/14b-liveness-with-scanner.mjs` (PASS runner)
- `.spike-notes/01-08-system-prompt-interactive.mjs` (T0.1 + T0.8 re-verify)
- `.spike-notes/02-04-05-multiturn.mjs` (T0.2/T0.4/T0.5)
- `.spike-notes/02-thinking.mjs` (T0.2 with --effort high)
- `.spike-notes/07-10-11-flags.mjs` (T0.7 / T0.10 / T0.11 flag probes)
- `.spike-notes/11b-sysprompt-file-interactive.mjs` (T0.11 follow-up — interactive mode)

## Outcome

Phase 0 hard gate cleared. All spike-driven design risks resolved. Ready to begin Phase 1 implementation in earnest. Next step: T0.9 (promote findings into `design.md` + `analyze.md`), then Phase 1 starting with T1.2/T1.2a (deps + build pipeline) and T1.3 (settings builder).
