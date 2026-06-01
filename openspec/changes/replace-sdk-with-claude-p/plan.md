# Execution Plan

Fine-grained driver for `openspec-apply-change`. `tasks.md` is the coarse
checklist; this file is the ordered sequence the apply skill executes. Execution
Mode is `tdd-preferred` — TDD micro-tasks where feasible, ordered lists where
claude-p integration prevents pure TDD.

> Replan: this plan targets the **claude-p driver** (design Replan Amendment).
> The prior in-house-PTY plan steps (node-pty spawn, ANSI stripper, trust-dialog
> scanner, hook-relay shim, transcript-file tailer, Stop settle window) are
> SUPERSEDED and removed.

## Plan step 1: Phase 0 claude-p feasibility spike — DONE

- **Covers:** T0.1–T0.5
- **Result:** gate cleared 2026-05-31 (claude 2.1.159 + claude-p 0.1.0). Claude Code
  is an agent loop; held-open MCP `tools/call` blocks the CLI inline (promise-park
  validated on `-p` AND through claude-p); claude-p `--output-format stream-json
  --verbose` flushes live and emits the raw interactive schema; claude-p handles the
  trust dialog itself; cold boot is heavy. Findings promoted to proposal.md +
  design.md Replan Amendment (D26–D31).
- **Verification:** `openspec validate replace-sdk-with-claude-p` passes; design
  Replan Amendment present.

## Plan step 2: Worktree + dependencies + build pipeline

- **Covers:** T1.1, T1.2, T1.2a
- **Action:**
  1. `git worktree add worktrees/replace-sdk-with-claude-p` from current HEAD; capture base SHA into `review.md`.
  2. `npm install --save claude-p @modelcontextprotocol/sdk` (NOT node-pty). Pin the tested claude-p version. Commit.
  3. Create `tsconfig.build.json` (`outDir: dist`); add `"build"` + `"prepublishOnly"` scripts; expand `files` to include `dist/**`; add `"bin": { "pi-claude-bridge-shim": "dist/mcp/shim.js" }`. Commit.
- **Verification:** `npm run typecheck` green; `@anthropic-ai/*` still present (Phase 3 removes them); `npm pack --dry-run` shows `dist/**`.
- **Rollback:** `git worktree remove … --force`.

## Plan step 3: claude-p driver (`src/driver/claudeP.ts`)

- **Covers:** T1.3
- **Action (TDD where feasible):**
  1. Failing unit test: argv assembly includes `--model`, `--mcp-config`, `--disallowedTools` (full disallow set), `--strict-mcp-config`, `--setting-sources ""`, `--permission-mode bypassPermissions`, `--output-format stream-json`, `--verbose`; and EXCLUDES `--settings`, `-p`, `--print`. Cite `claude-p-driver.claude-p-spawn-with-model-selection` + `.native-tool-emission-is-blocked-via-disallowedtools`.
  2. Failing unit test: abort sends SIGINT then SIGKILL after grace (`.abort-propagates-to-the-claude-p-subprocess`).
  3. Implement spawn / flag assembly / abort / kill.
  4. Tests green. Commit (`feat(driver): claude-p subprocess spawn + flag assembly + abort`).
- **Verification:** unit green; an integration smoke spawns real claude-p in a tmpdir and asserts a clean lifecycle + that no file under `~/.claude/` is opened by the bridge (`.driver-never-reads-or-writes-user-global-claude-config`).

## Plan step 4: stream-json parser (`src/driver/stream.ts`)

- **Covers:** T1.4
- **Action (TDD):**
  1. Unit tests from canned claude-p stdout fixtures: text-delta, tool-use (with full args), thinking-delta, usage from `result` line; turn-end on `result` (no `stop_reason`); noise-line filtering (mode/permission-mode/file-history-snapshot/attachment/ai-title/stop_hook_summary/turn_duration); `WaitForMcpServers` suppression; partial-line buffering; malformed-line warning; unknown-type drift warning; premature-exit error. Cite the `transcript-stream.*` AC IDs.
  2. Implement the parser.
  3. Tests green. Commit (`feat(driver): claude-p stream-json stdout parser with noise filtering`).

## Plan step 5: MCP IPC transport (`src/mcp/ipc.ts`)

- **Covers:** T1.5
- **Action (TDD):** unique socket path per spawn via `randomBytes` (D20); server + client parity. Commit.

## Plan step 6: MCP shim (`src/mcp/shim.ts`) — MCP-server-only

- **Covers:** T1.6
- **Action (TDD):**
  1. Unit tests: `initialize`+`tools/list` advertise only `mcp__custom-tools__*` (`mcp-stdio-shim.shim-exposes-only-pi-bridged-tools`); `tools/call` forwarded + held open until router resolves (`.shim-forwards-tool-calls-to-the-in-process-router`); unknown-tool rejection (`.shim-rejects-non-bridged-tool-names`); malformed JSON-RPC (`.malformed-mcp-messages-surface-as-errors`); stdin-close → exit (`.shim-lifecycle-is-bound-to-its-spawn`); separate-process invariant (`.shim-is-a-separate-process`); capture-mode deterministic response on valid args + `-32602` on invalid + `-32603` on repeat (`.capture-mode-tool-calls-receive-deterministic-shim-response`). NO hook-relay mode.
  2. Implement as a standalone executable; bin wired in Step 2.
  3. Tests green; `node dist/mcp/shim.js --help` runs. Commit.

## Plan step 7: MCP router (`src/mcp/router.ts`)

- **Covers:** T1.7
- **Action (TDD):** Promise-parking contract — receive over IPC, park, resolve on pi's next `streamSimple()`. Commit.

## Plan step 8: Feature flag + main-provider wiring

- **Covers:** T1.8, T1.9
- **Action:**
  1. Add `CLAUDE_BRIDGE_DRIVER` env switch (default `sdk`; values `sdk` | `claude-p`).
  2. Wire main-provider `streamSimple`: when `claude-p`, dispatch to the new driver; preserve all conversation-state machinery (divergence, abort, supersede, cache hint).
  3. Commit.
- **Verification:** `npm run typecheck` green; SDK-path tests green (default unchanged).

## Plan step 9: Phase 1 integration tests

- **Covers:** T1.10–T1.16 (run with `CLAUDE_BRIDGE_DRIVER=claude-p`)
- **Action:** write/commit per file:
  1. `int-claude-p-main-turn` — text-only turn.
  2. `int-claude-p-tool-round` — held-open round-trip (model→shim→pi→shim→model).
  3. `int-claude-p-tool-isolation` — `--disallowedTools` + isolation flags leave only `mcp__custom-tools__*`; user-global allow/MCP do not re-enable; `WaitForMcpServers` not surfaced.
  4. `int-claude-p-abort` — SIGINT mid-turn; `done(aborted)` without terminal `result`.
  5. `int-claude-p-abort-late-tool-result` — abort mid-tool-round; tool_result delivered post-abort captured for next-turn replay.
  6. `int-claude-p-warm-resume` — `--resume`; cache-read; single session id.
  7. `int-claude-p-steer` — S5 abort-and-respawn; records the S5 disposition into design D-S5.
- **Verification:** all green on macOS + Linux.

## Plan step 10: Capture path + integration tests

- **Covers:** T2.1–T2.6
- **Action (TDD):** implement `src/capture.ts` on the claude-p driver + shim; wire `index.ts` capture-shape detection; four integration tests (happy / isolation / error / abort). Commit per file.

## Plan step 11: AskClaude removal + docs

- **Covers:** T2.7, T2.8, T2.9
- **Action:** delete AskClaude code/config/env + tests; README strip + claude-p Provider section; CHANGELOG breaking entry. Commit each.
- **Verification:** `grep -rn "AskClaude\|askClaude" src/ index.ts tests/` empty.

## Plan step 12: Cut over

- **Covers:** T3.1–T3.5
- **Action:** default flag → `claude-p` (sdk → deprecation error); delete SDK path; remove `@anthropic-ai/*` deps; grep verify empty; README final pass. Commit each.
- **Verification:** full `npm test` green; no `@anthropic-ai` refs.

## Plan step 13: Hardening + the scenario gate

- **Covers:** T4.1–T4.10
- **Action:**
  1. **Scenario gate (T4.1):** run `scripts/run-all-scenarios.sh` (S0–S25). Every scenario green-or-exempted; record results + any exemption (esp. S5) in `SCENARIO_RESULTS.md` + design.md. **This gates completion.**
  2. Constitution III audit (no `~/.claude/` reads at all); constitution IV audit (`--disallowedTools` == spec list; never `--settings`/`-p`/`--print`).
  3. CI matrix macOS + Linux; tarball verify.
  4. `verify.md` AC↔test mapping (dynamic enumeration).
  5. Latency benchmark (cold + warm) + capture-termination benchmark.
  6. Rollback rehearsal; runtime `claude`/`claude-p` version check; prune TODO.md.
  7. CONDITIONAL (T4.10): if upstream claude-p 0.1.0 proved insufficient, vendor a fork and pin to it.
- **Verification:** CI green; `verify.md` present; scenario suite green-or-exempted.

## Completion Verification

- `openspec validate replace-sdk-with-claude-p` passes.
- The full S0–S25 scenario suite passes OR every exception is documented in `SCENARIO_RESULTS.md` + design.md (the replan's hard acceptance bar).
- `npm test` green on macOS + Linux.
- `grep -rn "@anthropic-ai" package.json src/ index.ts convert.ts models.ts tests/` empty (excluding `package-lock.json`).
- `grep -rn "AskClaude\|askClaude" src/ index.ts tests/` empty.
- No production read/write under `~/.claude/`.
- Every AC ID in `specs/**/spec.md` appears in at least one test (per `verify.md`).

## Manual Adjustments

- **Steps 3, 8, 9, 10 are not pure TDD** — claude-p spawn + integration against the real binary can't be driven failing-test-first in the conventional sense; each retains the spirit (assert, see fail, implement, see pass) with an integration test as the failing step where needed.
- **No subagent delegation** — the refactor is tightly coupled.
- **Worktree-required** — all phases execute in `worktrees/replace-sdk-with-claude-p`; base SHA captured at Step 2.
- **claude-p is v0.1.0** — Step 13 T4.10 is the escape hatch to vendor a fork if upstream proves insufficient.
