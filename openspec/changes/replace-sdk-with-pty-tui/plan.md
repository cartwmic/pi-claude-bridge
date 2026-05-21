# Execution Plan

Fine-grained driver for `openspec-apply-change`. `tasks.md` is the coarse
checklist; this file is the ordered sequence the apply skill executes.
Execution Mode is `tdd-preferred` — TDD micro-tasks used where feasible,
simple ordered lists where PTY integration prevents pure TDD.

## Plan step 1: Phase 0 spikes

- **Covers:** T0.1, T0.2, T0.3, T0.4, T0.5, T0.6, T0.7, T0.8, T0.9, T0.10, T0.11, T0.12, T0.13, T0.14
- **Pre-conditions:**
  - `claude` binary on `$PATH`
  - Claude Max/Pro subscription active locally
  - `.spike-notes/` directory present (created if not)
- **Action (simple ordered list — spike work, not TDD):**
  1. T0.1 — invoke `claude` with `--system-prompt`, `--append-system-prompt`, and `--settings '{"systemPrompt":"…"}'` variations. Record which (if any) fully replaces CC's default. Write findings to `.spike-notes/01-system-prompt.md`.
  2. T0.2 — invoke `claude` with a thinking-eligible model + reasoning effort; tail the transcript JSONL at the real path `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` (use `--session-id <uuid>` to make the path deterministic). Record whether thinking blocks appear and their JSON shape. Write `.spike-notes/02-thinking-blocks.md`.
  3. T0.3 — register a `Stop` hook capturing the payload; inspect the terminal `result` JSONL entry. Record presence and shape of `usage` (input/output/cache tokens) and `total_cost_usd`. Write `.spike-notes/03-stop-payload-result.md`.
  4. T0.4 — write a small script that watches a transcript file on macOS using `fs.watch`, then concurrently runs `claude` and counts missed writes vs polling. Write `.spike-notes/04-fswatch-macos.md`.
  5. T0.5 — run a multi-turn `claude --resume <id>` session; inspect transcript for any `session_id` changes mid-turn. Write `.spike-notes/05-session-rotation.md`.
  6. T0.6 — spawn `claude` inside a bare `node-pty` session, log all bytes the binary writes to the PTY in the first 5 seconds, and check whether DEC primary/secondary device attributes (`\e[c`, `\e[>c`), XTVERSION (`\e[>q`), DSR (`\e[5n`), or window-size queries (`\e[14t`, `\e[18t`) arrive. If any do and `claude` does NOT proceed past them without a reply, write a minimal canned responder and confirm boot completes. Record decision in `.spike-notes/06-terminal-queries.md`.
  6a. T0.14 — **HARD GATE** liveness spike. Spawn `claude --session-id <uuid> 'hello'` inside `node-pty`, wait 30s, assert SessionStart hook fires + assistant JSONL line appears + process alive when SIGINT'd + Stop hook fires (or clean PTY exit). If liveness fails, design needs a new D-decision. Write `.spike-notes/14-positional-liveness.md`.
  7. T0.7 — verify isolation: create a temp `~/.claude/settings.json` with `permissions.allow: ["Bash(*)"]` and a temp `~/.claude/mcp.json` with a sentinel MCP server, then spawn `claude` with `--setting-sources "" --strict-mcp-config --permission-mode bypassPermissions`. Use DETERMINISTIC MCP `tools/list` introspection (NOT model self-report) to enumerate exposed tools. Confirm neither the user's allow-list tool nor the sentinel MCP server's tools appear. Write `.spike-notes/07-isolation-flags.md`.
  8. T0.8 — spawn `claude --system-prompt 'TEST_SENTINEL_XYZ' --session-id <uuid>` INSIDE A `node-pty` SESSION IN INTERACTIVE MODE (not `-p`), in a temp directory containing a fixture `CLAUDE.md` and with the user's real `~/.claude/` present, then drive a turn that asks the model to repeat its system prompt verbatim. Read the deterministic transcript path post-Stop. DETERMINISTIC CHECK: grep the transcript JSONL for the sentinel string AND for known-distinctive `CLAUDE.md` content (e.g. the file's first line); assert sentinel present, CLAUDE.md content absent. If leakage occurs, escalate: try also setting `--bare` (which disables hooks; would invalidate D9/D12 — record the cascade). Write `.spike-notes/08-system-prompt.md`.
  10. T0.10 — try `claude --json-schema '{"type":"object","properties":{"foo":{"type":"string"}},"required":["foo"]}'` in BOTH interactive (`node-pty`) and `-p` modes; record whether interactive honors the flag. If yes, document the D5 alternative #1 viability for a future change. Write `.spike-notes/10-json-schema.md`.
  11. T0.11 — enumerate the longest cold-start prompt size pi typically produces (sample ~20 real pi sessions); confirm against `getconf ARG_MAX` ceilings on macOS + Linux. **PRIMARY candidate** (Round-5 A.P1#2): verify `--system-prompt-file <path>` and `--append-system-prompt-file <path>` exist + honor in interactive mode (write a temp file, pass the path, ask model to repeat its system prompt, confirm file contents present). If verified, escape mechanism = write cold-start history to `os.tmpdir()` and pass `--system-prompt-file <tempfile>`. If flag is missing or `--print`-only, document v1 hard limit. Write `.spike-notes/11-argv-size.md`.
  12. T0.12 — verify `--session-id <uuid>` honors the supplied UUID. Spawn `claude --session-id <known-uuid>` interactively, wait for the transcript to appear, confirm it lands at `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` where `<encoded-cwd>` is `cwd` with `/` replaced by `-`. Repeat on macOS and Linux to confirm encoding portability. ALSO capture the `SessionStart` payload and record whether it includes `transcript_path` matching the computed path (informational cross-check only — the bridge no longer depends on the payload field per D18). Write `.spike-notes/12-session-id-determinism.md`.
  13. T0.13 — capture the JSON payload shape `claude` writes to hook subprocess stdin for both `SessionStart` and `Stop`. Determine the JSON RESPONSE shape `claude` expects the hook subprocess to write back to stdout (or whether empty stdout is acceptable). Document in `.spike-notes/13-hook-payload-shapes.md`.
  14. T0.9 — synthesize findings: edit `design.md` to confirm D7-final (or escalate), finalize D2 PTY-bootstrap decision (raw `node-pty` vs `node-pty` + ANSI responder) based on T0.6 result, pin the isolation flag set per T0.7 (with HOME-override fallback if `""` rejected), confirm or revise D17's settle-window default, record D5 alternative status per T0.10, record the prompt-size threshold + fallback per T0.11, confirm or revise D4 (transcript discovery) per T0.12, update transcript-stream AC if T0.2 found no thinking-block emission, update `analyze.md` outstanding risks.
- **Verification:**
  - Each spike note exists and contains a concrete observed result + decision.
  - `design.md` D7 has a `**Final choice:**` line.
  - `openspec validate replace-sdk-with-pty-tui` passes.
- **Rollback:**
  - `.spike-notes/` is throwaway. To rollback design.md edits: `git checkout -- openspec/changes/replace-sdk-with-pty-tui/design.md openspec/changes/replace-sdk-with-pty-tui/specs/`.

## Plan step 2: Worktree + dependencies + build pipeline

- **Covers:** T1.1, T1.2, T1.2a
- **Pre-conditions:**
  - Phase 0 complete; D7-final committed
  - Clean working tree on `main` branch
- **Action:**
  1. `git worktree add worktrees/replace-sdk-with-pty-tui` from current HEAD.
  2. `cd worktrees/replace-sdk-with-pty-tui`. Capture `git rev-parse HEAD` into `review.md` Worktree Base SHA field.
  3. `npm install --save node-pty @modelcontextprotocol/sdk`. Commit (`infra: add node-pty and MCP SDK deps for PTY driver`).
  4. T1.2a: create `tsconfig.build.json` (`outDir: dist`, `noEmit: false`, copies `tsconfig.json`'s settings); add `"build": "tsc -p tsconfig.build.json"` + `"prepublishOnly": "npm run build"` to `package.json` scripts; expand `package.json` `files` to include `dist/**` (drop the existing top-level entries that won't ship post-Phase-3 — see Step 14); add `"bin": { "pi-claude-bridge-shim": "dist/mcp/shim.js" }`. Commit (`infra: TypeScript build pipeline to dist/ for publishable artifacts`).
  5. `npm run build` should still succeed (no `src/` yet — build is empty); `npm pack --dry-run` should list `dist/` in the future tarball composition.
- **Verification:**
  - `npm run typecheck` passes.
  - `package-lock.json` updated; `@anthropic-ai/*` deps still present (Phase 3 removes them).
  - `npm pack --dry-run` shows `package.json files` whitelist includes `dist/**`.
- **Rollback:**
  - `git worktree remove worktrees/replace-sdk-with-pty-tui --force`.

## Plan step 3: Settings builder (`src/driver/settings.ts`)

- **Covers:** T1.3
- **Pre-conditions:** Step 2 done.
- **Action (5-step TDD micro-tasks):**
  1. Write failing unit test asserting the built JSON contains all disallowed tool names from `claude-tui-driver.native-tool-emission-is-blocked-at-driver-configuration` and only `mcp__custom-tools__*` in any allow set. Test cites the AC ID.
  2. `npm run test:unit` → expect FAIL (module not present).
  3. Implement `src/driver/settings.ts` with `buildSettings({ hooks, disallowList })` returning the JSON string.
  4. Run test → expect PASS.
  5. Commit (`feat(driver): inline --settings builder enforcing disallow list`).
- **Verification:** `npm run test:unit` green; `npm run typecheck` green.
- **Rollback:** `git revert` the commit; leaves Phase 0 + Step 2 intact.

## Plan step 4: PTY driver core (`src/driver/pty.ts`)

- **Covers:** T1.4
- **Pre-conditions:** Step 3 done.
- **Action (TDD where feasible; PTY spawn integration test gates pure TDD):**
  1. Write failing unit test for abort behavior using a fake PTY (claude-tui-driver.abort-propagates-to-the-pty).
  2. Run → FAIL.
  3. Implement `spawn()`, `interrupt()`, `kill()` with the 3-second SIGINT→SIGKILL grace window (D10). Hook callbacks are stubs at this stage.
  4. Run unit test → PASS.
  5. Add an integration smoke test that spawns real `claude` with `--version`-equivalent or smallest possible turn and asserts process lifecycle. Cite ACs `claude-tui-driver.pty-spawn-with-model-selection` and `.unexpected-driver-exit-surfaces-as-error`.
  6. Commit (`feat(driver): PTY spawn, hook dispatch, abort propagation`).
- **Verification:** unit + integration smoke green; the `tests/int-claude-dir-audit.mjs` runtime directory-diff check (T4.2) asserts no BRIDGE-AUTHORED write occurred under `~/.claude/` during the test (transcripts written by `claude` itself under `~/.claude/projects/` are allowed; the assertion targets `~/.claude/sessions/`, `~/.claude/settings.json`, etc.) (cite AC `.driver-never-writes-to-user-global-claude-config`; Round-2 B.P2#1).
- **Rollback:** `git revert`.

## Plan step 5: Transcript stream (`src/driver/transcript.ts`)

- **Covers:** T1.5
- **Pre-conditions:** Step 4 done.
- **Action (TDD):**
  1. Write unit tests for each of: text-delta, tool-use, thinking-delta, usage event emission from canned JSONL fixtures (transcript-stream.emit-text-delta-tool-use-thinking-and-usage-events). Cite AC IDs.
  2. Write unit test for partial-line buffering (`transcript-stream.partial-lines-are-buffered-until-newline`).
  3. Write unit test for malformed-line warning (`transcript-stream.malformed-jsonl-lines-surface-as-warnings-not-stream-errors`).
  4. Write unit test for missing-transcript error (`transcript-stream.missing-or-unreadable-transcript-surfaces-as-error`).
  5. Run → FAIL.
  6. Implement tailer (with polling fallback hook for Phase 4 if Phase 0.4 required it).
  7. Run → PASS.
  8. Commit (`feat(driver): JSONL transcript tailer with per-block event emission`).
- **Verification:** unit tests green.
- **Rollback:** `git revert`.

## Plan step 6: MCP IPC transport (`src/mcp/ipc.ts`)

- **Covers:** T1.6
- **Action (TDD):**
  1. Write unit test asserting unique socket paths per call (R10) using `randomBytes`. Test for client-side and server-side parity.
  2. Run → FAIL.
  3. Implement unix-socket server + client.
  4. Run → PASS.
  5. Commit (`feat(mcp): unix-socket IPC transport for shim↔router`).
- **Verification:** unit tests green.
- **Rollback:** `git revert`.

## Plan step 7: MCP shim multi-mode binary (`src/mcp/shim.ts`)

- **Covers:** T1.7
- **Action (TDD):**
  1. Write unit tests for: `--mode mcp` handshake (mcp-stdio-shim.shim-exposes-only-pi-bridged-tools, .shim-binary-serves-both-mcp-server-and-hook-relay-roles), unknown-tool rejection (.shim-rejects-non-bridged-tool-names), malformed JSON-RPC handling (.malformed-mcp-messages-surface-as-errors), stdin-close → exit (.shim-lifecycle-is-bound-to-its-pty), separate-process invariant (.shim-is-a-separate-process), `--mode hook` payload relay for `SessionStart` and `Stop` (NOT PreToolUse — dropped per design D9/D11) (.shim-binary-serves-both-mcp-server-and-hook-relay-roles + claude-tui-driver.hook-relay-subprocess-is-the-bridges-hook-ipc-channel), capture-mode deterministic response on valid args + MCP-error on invalid args + repeated-call handling (.capture-mode-tool-calls-receive-deterministic-shim-response).
  2. Run → FAIL.
  3. Implement the multi-mode shim as a standalone executable; bin entry was wired in Step 2.
  4. Run → PASS.
  5. Commit (`feat(mcp): multi-mode shim binary (mcp + hook) with capture-mode handling`).
- **Verification:** unit tests green; `npm run build` produces `dist/mcp/shim.js`; `node dist/mcp/shim.js --help` runs.
- **Rollback:** `git revert`.

## Plan step 8: MCP router (`src/mcp/router.ts`)

- **Covers:** T1.8
- **Action (TDD):**
  1. Write unit test for Promise-parking contract (`mcp-stdio-shim.shim-forwards-tool-calls-to-the-in-process-router`).
  2. Run → FAIL.
  3. Implement router: receives MCP requests over IPC, parks Promise, resolves on pi's next streamSimple call.
  4. Run → PASS.
  5. Commit (`feat(mcp): in-process router preserving handler-Promise contract`).
- **Verification:** unit green.
- **Rollback:** `git revert`.

## Plan step 9: Feature flag + main-provider wiring

- **Covers:** T1.9, T1.10
- **Action:**
  1. Add `CLAUDE_BRIDGE_DRIVER` env switch in `index.ts` with default `sdk`.
  2. Wire main-provider `streamSimple` path: when flag = `pty`, dispatch to new PTY driver; preserve all conversation-state machinery (divergence detection, abort, supersede, session cache).
  3. Commit (`feat: CLAUDE_BRIDGE_DRIVER feature flag; PTY driver wired into main path`).
- **Verification:** `npm run typecheck` green; existing SDK-path unit tests green (`CLAUDE_BRIDGE_DRIVER=sdk` still default).
- **Rollback:** revert; SDK path is the default so production unaffected.

## Plan step 10: Phase 1 integration tests

- **Covers:** T1.11, T1.12, T1.13, T1.14, T1.15, T1.16, T1.17, T1.18, T1.19, T1.20
- **Action:**
  1. Write `tests/int-pty-main-turn.{sh,mjs}` driving a text-only turn through the PTY driver. Cite ACs.
  2. Write `tests/int-pty-tool-round.{sh,mjs}` exercising a bridged-tool round trip via the shim + router.
  3. Write `tests/int-pty-abort.{sh,mjs}` triggering pi abort mid-turn; covers `claude-tui-driver.abort-lifecycle-is-decoupled-from-stop-hook-firing` (abort path completes even if `Stop` does not fire).
  4. Write `tests/int-hook-relay.{sh,mjs}` covering `claude-tui-driver.hook-relay-subprocess-is-the-bridges-hook-ipc-channel`.
  5. Write `tests/int-strict-mcp-config.{sh,mjs}` proving user-global MCP servers are isolated from the spawned PTY.
  6. Write `tests/int-setting-sources-isolation.{sh,mjs}` proving user-global `permissions.allow` cannot re-enable disallowed tools (deterministic MCP `tools/list` introspection).
  7. Write `tests/int-pty-abort-late-tool-result.{sh,mjs}` covering `claude-tui-driver.abort-preserves-late-tool-result-coherence-with-pi`: abort mid-tool-round, deliver tool_result via streamSimple post-abort, assert next-turn cold-start replay includes the captured tool_result.
  8. Write `tests/int-transcript-settle-window.{sh,mjs}` covering the Stop pre-flush settle scenario (D17): fixture transcript that writes its terminal `result` line 100ms after Stop fires; assert the settle window catches it.
  9. Run each with `CLAUDE_BRIDGE_DRIVER=pty`.
  10. Commit per test file (8 commits).
- **Verification:** all eight integration tests green on macOS + Linux runners.
- **Rollback:** revert individual commits; default flag still `sdk`.

## Plan step 11: Capture path implementation

- **Covers:** T2.1, T2.2
- **Action (TDD):**
  1. Write unit tests for capture classification (preserved from existing tests under PTY semantics) + forced-MCP-tool-call synthesis logic. Cite ACs `output-capture.synthesized-toolcall-content-block-on-success`, `.surface-absent-capture-tool-call-as-error`, `.capture-path-honors-abortsignal`.
  2. Run → FAIL.
  3. Implement `src/capture.ts` on top of `src/driver/pty.ts` and `src/mcp/shim.ts`.
  4. Wire `index.ts` capture-shape detection to dispatch to `src/capture.ts` (preserves all `output-capture.*` external behavior).
  5. Run → PASS.
  6. Commit (`feat(capture): forced MCP tool-call capture path on PTY driver`).
- **Verification:** unit tests green.
- **Rollback:** revert.

## Plan step 12: Capture integration tests

- **Covers:** T2.3, T2.4, T2.5, T2.6
- **Action:**
  1. Write four integration tests covering: happy path, mid-conversation isolation, error path (model never calls tool), abort.
  2. Run each.
  3. Commit per file (4 commits).
- **Verification:** all four green.
- **Rollback:** revert individual commits.

## Plan step 13: AskClaude removal + docs

- **Covers:** T2.7, T2.8, T2.9
- **Action:**
  1. Delete `runAskClaude`, `wireAskClaudeTool`, `askClaude` config schema, `CLAUDE_BRIDGE_ASKCLAUDE_ENABLED` env switch, related tests. One commit.
  2. README: strip AskClaude section; update Provider section to reflect PTY mechanism. One commit.
  3. CHANGELOG: write breaking-release entry covering SDK removal + AskClaude removal + streaming-granularity change. One commit.
- **Verification:** `grep -rn "AskClaude\|askClaude" src/ index.ts tests/` returns empty; `npm run test:unit` green.
- **Rollback:** revert; AskClaude has no consumers in this repo (downstream impact only).

## Plan step 14: Cut over

- **Covers:** T3.1, T3.2, T3.3, T3.4, T3.5
- **Action:**
  1. Change `CLAUDE_BRIDGE_DRIVER` default to `pty`; setting it to `sdk` raises a deprecation error. Commit.
  2. Delete SDK path code from `index.ts`. Commit.
  3. Remove `@anthropic-ai/claude-agent-sdk` + `@anthropic-ai/sdk` from `package.json`; `npm install` to refresh lockfile. Commit.
  4. Grep verification: `grep -rn "@anthropic-ai" src/ index.ts convert.ts models.ts tests/` returns empty (excluding lockfile). If non-empty, halt and clean up.
  5. README final pass + commit.
- **Verification:** full `npm test` green; `package.json` no longer references Anthropic SDK packages; bundle size diff in commit message.
- **Rollback:** the previous 4 commits are individually revertible. Pre-cut-over state is one `git revert` chain away.

## Plan step 15: Hardening

- **Covers:** T4.1, T4.2, T4.3, T4.4, T4.4a, T4.5, T4.6, T4.6a, T4.7, T4.8
- **Action:**
  1. If Phase 0.4 found `fs.watch` unreliable: implement polling fallback in `transcript.ts`; add unit test.
  2. Add CI grep check asserting no writes to `~/.claude/` from production code (constitution III).
  3. Add unit test asserting the runtime disallow list equals the spec list (constitution IV).
  4. Update CI matrix to test both macOS and Linux.
  5. Add `tests/int-tarball-verify.sh` that runs `npm pack`, installs the tarball into a fresh tmpdir with `npm install <tarball>`, then runs both the extension loader and `pi-claude-bridge-shim --help` from that install to prove the published artifact is self-contained.
  6. Produce `verify.md` with the AC↔test mapping for EVERY AC ID enumerated from `specs/**/spec.md` (do not hard-code the count; Round-2 A.P2#1).
  7. Add `scripts/rollback-rehearsal.sh`: take the Phase-3 cut-over commit range, `git revert <range>` against a scratch branch, run `npm test`, assert success (Round-2 A.P3#4 / R14).
  8. Add `tests/int-capture-termination-bench.mjs`: drive N capture-mode turns, measure tokens emitted between the first valid capture-tool call and `end_turn`, surface median + p99 in CI output (Round-2 A.P3#3 / R17).
  9. Add runtime `claude --version` check in `src/driver/pty.ts` with README-pinned tested range (Round-2 A.P2 truncated finding).
  10. Prune `TODO.md` of obsolete SDK-era items.
- **Verification:** CI green on macOS + Linux; `verify.md` exists; AC↔test grep finds every AC ID in at least one test.
- **Rollback:** individual reverts.

## Completion Verification

- `openspec validate replace-sdk-with-pty-tui` passes.
- `openspec status --change replace-sdk-with-pty-tui` reports 8/8 schema artifacts done + `verify.md` present.
- `npm test` green on both macOS and Linux CI runners.
- `grep -rn "@anthropic-ai" package.json src/ index.ts convert.ts models.ts tests/` returns empty (excluding `package-lock.json`).
- `grep -rn "AskClaude\|askClaude" src/ index.ts tests/` returns empty.
- Every AC ID in `specs/**/spec.md` appears in at least one test file (per `verify.md` Check 5).

## Manual Adjustments

- **Plan steps 4, 9, 10, 12 are not pure TDD** because PTY spawn and integration tests against a real `claude` binary cannot be driven by failing-test-first cycles in the conventional sense. Each retains the TDD spirit (write the assertion, see it fail, implement, see it pass) but the failing-test step may be an integration test rather than a unit test.
- **No subagent delegation** despite Scale L. The refactor is tightly coupled; coordination overhead would dominate parallelism gains.
- **Worktree-required.** All phases execute in `worktrees/replace-sdk-with-pty-tui`. Worktree Base SHA captured at Step 2.2 governs file-contract diffs for the duration.
