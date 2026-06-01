# Tasks

Implementation checklist for the **claude-p driver** replan. Phases match
design.md Migration Plan + the Replan Amendment. Contract fields enforce scope
per `openspec-apply-change` diff checking.

> The prior in-house-PTY task list (node-pty spawn, ANSI stripper, trust-dialog
> scanner, hook-relay shim, transcript-file tailer, settle window) is SUPERSEDED.
> Those tasks are removed; claude-p owns PTY/ANSI/trust/hooks, and events come
> from claude-p's stdout. See design Replan Amendment D26–D31 + the supersession map.

## 0. Phase 0 — claude-p feasibility spike (DONE 2026-05-31)

The replan's hard gate: "does Claude Code expose a completion-shaped seam, or only
an agent loop?" Spike completed on `claude 2.1.159` + `claude-p 0.1.0`. Findings
promoted into proposal.md + design.md Replan Amendment. (The old Phase-0 node-pty
spikes T0.1–T0.14 are historical; superseded by this gate.)

- [x] 0.1 Spike: confirm Claude Code is an agent loop (no `--max-turns`/stop-at-tool-use; CLI executes MCP tools itself in one invocation). RESULT: confirmed.
- [x] 0.2 Spike: confirm the held-open MCP `tools/call` blocks the CLI inline (the promise-park mechanism). RESULT: confirmed on `-p` AND through claude-p (4–5s holds reproduced exactly).
- [x] 0.3 Spike: confirm claude-p `--output-format stream-json --verbose` flushes lines live, and document its emitted interactive-transcript schema (noise lines, `WaitForMcpServers`, `result` without `stop_reason`, `usage` present). RESULT: documented in design D27.
- [x] 0.4 Spike: confirm claude-p handles the workspace-trust dialog itself (untrusted cwd, no hang) and forwards the flags the bridge needs (`--mcp-config`, `--disallowedTools`, `--setting-sources`, `--session-id`/`--resume`, `--system-prompt`). RESULT: confirmed; `--settings` reserved by claude-p.
- [x] 0.5 Spike: record cold-boot latency observation (heavy vs `-p`). RESULT: noted as risk; Phase-4 benchmark.

## 1. Phase 1 — claude-p driver + MCP shim/router/stream behind feature flag

New driver lives alongside the SDK path; `CLAUDE_BRIDGE_DRIVER` chooses. SDK is
default until Phase 3.

- [ ] 1.1 Create worktree at `worktrees/replace-sdk-with-claude-p`; capture Worktree Base SHA into `review.md`
  - intent: infra
  - files_allowed:
      - openspec/changes/replace-sdk-with-claude-p/review.md
  - allow_new_files: false
- [ ] 1.2 Add runtime dependencies: `claude-p`, `@modelcontextprotocol/sdk`. Do NOT add `node-pty`. Do NOT remove SDK deps yet (Phase 3 cleanup). Pin tested `claude-p` version.
  - intent: infra
  - files_allowed:
      - package.json
      - package-lock.json
  - allow_new_files: false
- [ ] 1.2a Add build pipeline (D14): create `tsconfig.build.json` emitting to `dist/`; add `"build": "tsc -p tsconfig.build.json"`; expand `files` to include `dist/**`; add `bin` entry pointing at `dist/mcp/shim.js`; ensure `prepublishOnly` runs the build. (No node-pty `spawn-helper` chmod postinstall — that prior R19 task is moot.)
  - intent: infra
  - files_allowed:
      - tsconfig.build.json
      - package.json
      - package-lock.json
      - ".npmignore"
  - allow_new_files: true
- [ ] 1.3 Implement `src/driver/claudeP.ts` — claude-p subprocess spawn + flag assembly (`--model`, `--system-prompt`/`--input-file`, `--mcp-config`, `--disallowedTools`, `--strict-mcp-config`, `--setting-sources ""`, `--permission-mode bypassPermissions`, `--session-id`/`--resume`, `--output-format stream-json`, `--verbose`, `--timeout`); MUST NOT emit `--settings`/`-p`/`--print`; SIGINT→SIGKILL grace abort (claude-p-driver.claude-p-spawn-with-model-selection, .native-tool-emission-is-blocked-via-disallowedtools, .abort-propagates-to-the-claude-p-subprocess, .driver-never-reads-or-writes-user-global-claude-config, .unexpected-driver-exit-surfaces-as-error)
  - intent: feature
  - files_allowed:
      - src/driver/claudeP.ts
      - tests/unit-driver-claude-p.mjs
- [ ] 1.4 Implement `src/driver/stream.ts` — claude-p stdout stream-json parser + event emitter; filters noise/built-in lines (mode/permission-mode/file-history-snapshot/attachment/ai-title/stop_hook_summary/turn_duration/WaitForMcpServers); turn-end on `result` line; drift detection (transcript-stream full requirement set)
  - intent: feature
  - files_allowed:
      - src/driver/stream.ts
      - tests/unit-driver-stream.mjs
- [ ] 1.5 Implement `src/mcp/ipc.ts` — unique-per-spawn unix-socket transport (random socket path via `randomBytes`; D20)
  - intent: feature
  - files_allowed:
      - src/mcp/ipc.ts
      - tests/unit-mcp-ipc.mjs
- [ ] 1.6 Implement `src/mcp/shim.ts` — stdio MCP server executable (MCP-server-only; NO hook-relay mode). Advertises only `mcp__custom-tools__*`; forwards `tools/call` to the router (held open); rejects non-bridged names; capture-mode deterministic response per `mcp-stdio-shim.capture-mode-tool-calls-receive-deterministic-shim-response`; absolute-path resolution via `require.resolve` (D19). Wire bin entry in `package.json`.
  - intent: feature
  - files_allowed:
      - src/mcp/shim.ts
      - package.json
      - tests/unit-mcp-shim.mjs
- [ ] 1.7 Implement `src/mcp/router.ts` — in-process router; parks Promise per `tools/call`, resolves on pi's next `streamSimple()` (mcp-stdio-shim.shim-forwards-tool-calls-to-the-in-process-router)
  - intent: feature
  - files_allowed:
      - src/mcp/router.ts
      - tests/unit-mcp-router.mjs
- [ ] 1.8 Add `CLAUDE_BRIDGE_DRIVER` env switch in `index.ts`; default = `sdk` during Phase 1 (values: `sdk` | `claude-p`)
  - intent: feature
  - files_allowed:
      - index.ts
- [ ] 1.9 Wire main-provider path to the claude-p driver when flag = `claude-p`; preserve all conversation-state machinery (divergence detection, abort coordination, supersede, session cache hint)
  - intent: feature
  - files_allowed:
      - index.ts
      - src/driver/**/*.ts
      - src/mcp/**/*.ts
- [ ] 1.10 Integration test: end-to-end main-provider turn via claude-p (text-only) — spawns real claude-p, asserts coherent assistant text + usage
  - intent: feature
  - files_allowed:
      - tests/int-claude-p-main-turn.sh
      - tests/int-claude-p-main-turn.mjs
- [ ] 1.11 Integration test: tool-round via claude-p (model calls bridged tool → shim holds open → pi delivers result → model continues). Asserts the held-open round-trip end-to-end.
  - intent: feature
  - files_allowed:
      - tests/int-claude-p-tool-round.sh
      - tests/int-claude-p-tool-round.mjs
- [ ] 1.12 Integration test: native-tool block — assert `--disallowedTools` + `--strict-mcp-config` + `--setting-sources ""` leave only `mcp__custom-tools__*` callable, via deterministic MCP `tools/list` introspection; assert user-global `permissions.allow` and user-global MCP servers do NOT re-enable anything; assert `WaitForMcpServers` is not surfaced to pi (claude-p-driver.native-tool-emission-is-blocked-via-disallowedtools)
  - intent: feature
  - files_allowed:
      - tests/int-claude-p-tool-isolation.sh
      - tests/int-claude-p-tool-isolation.mjs
- [ ] 1.13 Integration test: abort mid-turn (claude-p-driver.abort-propagates-to-the-claude-p-subprocess, .abort-lifecycle-is-decoupled-from-claude-p-completion) — SIGINT the subprocess, assert clean teardown + `done(aborted)` even with no terminal `result`
  - intent: feature
  - files_allowed:
      - tests/int-claude-p-abort.sh
      - tests/int-claude-p-abort.mjs
- [ ] 1.14 Integration test: abort mid-tool-round preserves late-tool-result coherence (claude-p-driver.abort-preserves-late-tool-result-coherence-with-pi)
  - intent: feature
  - files_allowed:
      - tests/int-claude-p-abort-late-tool-result.sh
      - tests/int-claude-p-abort-late-tool-result.mjs
- [ ] 1.15 Integration test: warm-resume (`--resume <cached-id>`) — turn 2 recalls turn-1 fact; cache-read observed in usage; single driver session id across both turns (claude-p-driver.cached-driver-session-is-a-hint-only)
  - intent: feature
  - files_allowed:
      - tests/int-claude-p-warm-resume.sh
      - tests/int-claude-p-warm-resume.mjs
- [ ] 1.16 Integration test: mid-stream steer (S5) via abort-and-respawn — start a long turn, deliver a steering message mid-flight, assert the in-flight spawn is aborted, the steer dispatches as a fresh turn, and the next response recalls both topics (claude-p-driver.mid-stream-steer-is-handled-by-abort-and-respawn). **Records the S5 disposition** (abort-respawn passes / needs claude-p fork / documented exemption) into design D-S5.
  - intent: feature
  - files_allowed:
      - tests/int-claude-p-steer.sh
      - tests/int-claude-p-steer.mjs
      - openspec/changes/replace-sdk-with-claude-p/design.md

## 2. Phase 2 — Capture path + AskClaude removal

- [ ] 2.1 Implement `src/capture.ts` — forced MCP tool-call capture on the claude-p driver (output-capture MODIFIED + ADDED Requirements)
  - intent: feature
  - files_allowed:
      - src/capture.ts
      - tests/unit-capture.mjs
- [ ] 2.2 Wire `streamSimple` capture-shape detection to the new capture path; preserve classification logic from `output-capture.output-capture-classification-of-ctx-tools` + `strict-call-shape`
  - intent: refactor
  - files_allowed:
      - index.ts
      - src/capture.ts
  - allow_new_files: false
- [ ] 2.3 Integration test: capture happy path (output-capture.synthesized-toolcall-content-block-on-success)
  - intent: feature
  - files_allowed:
      - tests/int-claude-p-capture-success.mjs
- [ ] 2.4 Integration test: capture mid-conversation isolation (output-capture.capture-path-isolation)
  - intent: feature
  - files_allowed:
      - tests/int-claude-p-capture-isolation.mjs
- [ ] 2.5 Integration test: capture error path — model never calls capture tool (output-capture.surface-absent-capture-tool-call-as-error)
  - intent: feature
  - files_allowed:
      - tests/int-claude-p-capture-error.mjs
- [ ] 2.6 Integration test: capture path honors AbortSignal (output-capture.capture-path-honors-abortsignal)
  - intent: feature
  - files_allowed:
      - tests/int-claude-p-capture-abort.mjs
- [ ] 2.7 Remove `AskClaude` tool — delete `runAskClaude`, `wireAskClaudeTool`, config schema, env switch
  - intent: refactor
  - files_allowed:
      - index.ts
      - tests/**/*
  - allow_new_files: false
- [ ] 2.8 Update README — remove AskClaude section; document the claude-p driver mechanism + the "never nominal `claude -p`" stance
  - intent: refactor
  - files_allowed:
      - README.md
  - allow_new_files: false
- [ ] 2.9 Update CHANGELOG — breaking-release entry (SDK removal, AskClaude removal, streaming-granularity change)
  - intent: refactor
  - files_allowed:
      - CHANGELOG.md
  - allow_new_files: false

## 3. Phase 3 — Cut over

- [ ] 3.1 Default `CLAUDE_BRIDGE_DRIVER` to `claude-p`; `sdk` value rejected with deprecation error
  - intent: refactor
  - files_allowed:
      - index.ts
  - allow_new_files: false
- [ ] 3.2 Delete SDK path code — `_realQuery`/`_queryFactory`, `createSdkMcpServer` wiring, SDK-based `runCaptureQuery`, SDK-specific imports
  - intent: refactor
  - files_allowed:
      - index.ts
  - allow_new_files: false
- [ ] 3.3 Remove SDK dependencies from `package.json` — `@anthropic-ai/claude-agent-sdk`, `@anthropic-ai/sdk`
  - intent: infra
  - files_allowed:
      - package.json
      - package-lock.json
  - allow_new_files: false
- [ ] 3.4 Verify no remaining imports from removed packages: `grep -rn "@anthropic-ai" src/ index.ts convert.ts models.ts` returns empty
  - intent: refactor
  - files_allowed:
      - "**/*.ts"
  - allow_new_files: false
- [ ] 3.5 Final README pass — description + capabilities reflect the claude-p architecture
  - intent: refactor
  - files_allowed:
      - README.md
  - allow_new_files: false

## 4. Phase 4 — Hardening + the scenario gate

- [ ] 4.1 **SCENARIO GATE (completion bar):** run the full pi-TUI scenario suite (`scripts/run-all-scenarios.sh`, S0–S25). EVERY scenario passes (mechanical + coherence + cache-shape) OR carries a documented fundamental architectural exemption recorded in `SCENARIO_RESULTS.md` AND design.md. No silent skips. S5 disposition (from T1.16) is recorded here. This task is NOT done until the suite is green-or-exempted.
  - intent: feature
  - files_allowed:
      - scripts/**/*
      - SCENARIO_RESULTS.md
      - openspec/changes/replace-sdk-with-claude-p/design.md
  - allow_new_files: true
- [ ] 4.2 Audit constitution III — grep production code for any read/write under `~/.claude/`; assert the bridge opens NO file there (events come from claude-p stdout). Stronger than the prior exemption-based check.
  - intent: infra
  - files_allowed:
      - scripts/**/*.sh
      - scripts/**/*.mjs
      - .github/workflows/**/*.yml
      - tests/int-claude-dir-audit.mjs
  - allow_new_files: true
- [ ] 4.3 Audit constitution IV — assert the runtime `--disallowedTools` set equals the spec list in `claude-p-driver.native-tool-emission-is-blocked-via-disallowedtools`; assert `--settings`/`-p`/`--print` are NEVER in the assembled claude-p argv
  - intent: infra
  - files_allowed:
      - tests/unit-disallow-list.mjs
      - scripts/**/*
- [ ] 4.4 Integration test suite green on macOS + Linux (CI matrix)
  - intent: infra
  - files_allowed:
      - .github/workflows/**/*.yml
- [ ] 4.4a Tarball verification: `npm pack` artifact's `dist/` contains every runtime import and the `bin` shim runs end-to-end on a fresh install
  - intent: infra
  - files_allowed:
      - tests/int-tarball-verify.sh
      - .github/workflows/**/*.yml
- [ ] 4.5 Produce `verify.md` — canonical AC↔test mapping for EVERY AC ID in `specs/**/spec.md` (enumerate dynamically; do not hard-code a count)
  - intent: refactor
  - files_allowed:
      - openspec/changes/replace-sdk-with-claude-p/verify.md
- [ ] 4.6 Cold-boot + per-turn latency benchmark — measure claude-p spawn→first-event and full-turn latency across N runs (cold + warm-resume); surface median + p99; document the interactive-boot cost vs the prior SDK path; decide whether a warm-pool follow-up change is warranted
  - intent: feature
  - files_allowed:
      - tests/int-claude-p-latency-bench.mjs
      - .github/workflows/**/*.yml
  - allow_new_files: true
- [ ] 4.6a Rollback rehearsal: `git revert <Phase-3 range>` against a scratch branch, run `npm test`, confirm a working tree
  - intent: infra
  - files_allowed:
      - scripts/rollback-rehearsal.sh
      - .github/workflows/**/*.yml
  - allow_new_files: true
- [ ] 4.7 Runtime version check in `src/driver/claudeP.ts`: on first spawn (cached per process), read `claude --version` AND `claude-p` version; warn if outside the README-pinned tested range. Bridge load MUST NOT depend on either binary being present (missing-binary surfaces at first turn).
  - intent: feature
  - files_allowed:
      - src/driver/claudeP.ts
      - README.md
      - tests/unit-driver-version-check.mjs
  - allow_new_files: true
- [ ] 4.8 Capture-mode termination latency benchmark (tokens between first valid capture call and `end_turn`); surface median + p99
  - intent: feature
  - files_allowed:
      - tests/int-capture-termination-bench.mjs
      - .github/workflows/**/*.yml
  - allow_new_files: true
- [ ] 4.9 Prune TODO.md of obsolete SDK-era + node-pty-era items
  - intent: refactor
  - files_allowed:
      - TODO.md
  - allow_new_files: false
- [ ] 4.10 (CONDITIONAL) If Phase 1/4 found upstream claude-p 0.1.0 insufficient (stream-json passthrough gaps, `--disallowedTools` not honored, or S5 needs mid-turn injection): vendor a claude-p fork, document the patch set, and pin the bridge to it (forking-for-custom-patches skill). Record the rationale in design.md.
  - intent: infra
  - files_allowed:
      - vendor/claude-p/**/*
      - package.json
      - openspec/changes/replace-sdk-with-claude-p/design.md
  - allow_new_files: true
