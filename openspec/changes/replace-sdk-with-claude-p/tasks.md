# Tasks

Implementation checklist for the **claude-p driver** replan. Phases match
design.md Migration Plan + the Replan Amendment. Contract fields enforce scope
per `openspec-apply-change` diff checking.

> The prior in-house-PTY task list (node-pty spawn, ANSI stripper, trust-dialog
> scanner, hook-relay shim, transcript-file tailer, settle window) is SUPERSEDED.
> Those tasks are removed; claude-p owns PTY/ANSI/trust/hooks, and events come
> from claude-p's stdout. See design Replan Amendment D26–D32 + the supersession map.

## 0. Phase 0 — claude-p feasibility spike (DONE 2026-05-31)

The replan's **architectural-thesis** gate: "does Claude Code expose a
completion-shaped seam, or only an agent loop?" Cleared on `claude 2.1.159` +
`claude-p 0.1.0`. Reproducible artifact (harness + captured claude-p stdout) is
committed at `.spike-notes/claude-p-gate/`; findings promoted into proposal.md +
design.md Replan Amendment. (The old node-pty spikes T0.1–T0.14 are historical.)

**The thesis gate is NOT the behavioral gate.** The spike proved the agent loop +
a SINGLE held tool round through claude-p. It did NOT prove multi-round blocking,
constitution-IV isolation through claude-p, turn-end/cache-shape across rounds,
warm-resume cache reads, S7/S13 abort coherence, S5, cross-channel correlation, or concurrent spawns — those are gates **G1–G9 + G-resume**
in `0b` below, which BLOCK the Phase-3 cut-over.

- [x] 0.1 Spike: confirm Claude Code is an agent loop (no `--max-turns`/stop-at-tool-use; CLI executes MCP tools itself in one invocation). RESULT: confirmed.
- [x] 0.2 Spike: confirm the held-open MCP `tools/call` blocks the CLI inline (the promise-park mechanism). RESULT: confirmed on `-p` AND through claude-p (4–5s holds reproduced exactly).
- [x] 0.3 Spike: confirm claude-p `--output-format stream-json --verbose` flushes lines live, and document its emitted interactive-transcript schema (noise lines, `WaitForMcpServers`, `result` without `stop_reason`, `usage` present). RESULT: documented in design D27.
- [x] 0.4 Spike: confirm claude-p handles the workspace-trust dialog itself (untrusted cwd, no hang) and forwards the flags the bridge needs (`--mcp-config`, `--disallowedTools`, `--setting-sources`, `--session-id`/`--resume`, `--system-prompt`). RESULT: confirmed; `--settings` reserved by claude-p.
- [x] 0.5 Spike: record cold-boot latency observation (heavy vs `-p`). RESULT: noted as risk; Phase-4 benchmark.

## 0b. Phase-1 HARD GATES (G1–G9 + G-resume-flags) — must pass (or trigger the fork) BEFORE Phase-3 cut-over

These verify the load-bearing claude-p behaviors the thesis spike did NOT cover.
Each captures a committed fixture/result under `.spike-notes/claude-p-gate/`. The
Phase-3 SDK deletion (T3.2/T3.3) is BLOCKED until G1–G5 + G7 + G8 + G9 + G-resume pass empirically OR the
vendored claude-p fork (T4.10) is in place. **G2 is non-negotiable** (constitution IV).

- [ ] 0b.G1 Multi-round held blocking: drive ≥3 sequential held MCP tool rounds in ONE claude-p spawn; assert each blocks inline and the turn completes. Record fixture.
  - intent: infra
  - files_allowed: [".spike-notes/claude-p-gate/**", "tests/int-claude-p-multiround.mjs"]
  - allow_new_files: true
- [ ] 0b.G2 **Constitution IV (HARD):** with a user-global `permissions.allow:["Bash(*)"]` + a user MCP server present, spawn through claude-p with `--disallowedTools`+`--strict-mcp-config`+`--setting-sources ""`; assert (a) `tools/list` shows EXACTLY `mcp__custom-tools__*` (closed-set), AND (b) an actual model `Bash` emission is REFUSED (no native execution), AND (c) the bridged `mcp__custom-tools__*` surface SURVIVES the disallow set (a tool round still works — the disallow set must not match the bridge's own namespace). If any fails → fork (T4.10) mandatory before cut-over. (claude-p-driver.native-tool-emission-is-blocked-via-disallowedtools)
  - intent: infra
  - files_allowed: [".spike-notes/claude-p-gate/**", "tests/int-claude-p-tool-isolation.mjs"]
  - allow_new_files: true
- [ ] 0b.G3 Turn-end & multi-round schema (in the G1–G5 blocking set): record a multi-tool-round claude-p stdout fixture; determine whether `result` is per-turn or per-segment; pin the transcript-stream turn-end rule (transcript-stream.held-open-tool-rounds-do-not-terminate-the-turn). The **turn-end correctness** clause is cut-over-BLOCKING (a per-segment `result` mis-detected as turn-end corrupts S1/S2/S11); the **cache-token aggregation** clause (summing per-turn from multiple segments) shares G4's exemption fallback if unobtainable. Verify parallel tool_use (S11) emits distinct correlated events.
  - intent: infra
  - files_allowed: [".spike-notes/claude-p-gate/**", "tests/unit-driver-stream.mjs"]
  - allow_new_files: true
- [ ] 0b.G4 Cache-shape (HARD, blocks cut-over — cost+latency critical): prove per-turn `(cache_creation, cache_read)` is recoverable across tool rounds from `result.usage`, AND that `claude-p --resume <id>` yields `cache_read_input_tokens > 0` (warm) across process boundaries over ≥6 sequential turns — NOT a full-prefix re-creation each spawn. The specific risk: claude-p's per-spawn interactive injections (skill-listing/`attachment`, `ai-title`, `file-history-snapshot`, dynamic system-prompt sections) perturbing the cached prefix → creation every turn. Pin `--system-prompt` + exclude dynamic sections; if injections still bust the prefix, that is a per-turn cache-creation regression which is **NOT acceptable** → triggers the T4.10 fork (strip/pin the injections) or blocks the swap. Verified by the new scenario **S26** (sustained warm cache). NOTE: a single `claude-p` turn already shows caching is ACTIVE (spike Exp C: `cache_read_input_tokens=127119`); the unproven bit is cross-`--resume`-spawn warm preservation. claude-p 0.1.0 also showed `SessionStartTimeout`/`StopTimeout` flakiness on plain turns during the spike — reliability is part of this gate.
  - intent: infra
  - files_allowed: [".spike-notes/claude-p-gate/**", "SCENARIO_RESULTS.md"]
  - allow_new_files: true
- [ ] 0b.G5 Abort coherence (S7 + S8 + S13): prove cold-replay of pi history reproduces interrupted-partial recall. MUST cover (a) text-streaming abort (S7), (b) **abort-while-blocked-on-a-held-tool (S8)** where there is no in-flight text — define what is preserved (prior tool_use blocks + "interrupted" marker) so "did the sleep finish? — no" holds, (c) that pi cold-replay actually INCLUDES the content of an aborted/error AssistantMessage (the SDK got the partial from session-resume, NOT pi history — this is unproven). ALSO decide the post-abort cache-shape for S7/S8/S9/S13: test whether `claude-p --resume` of a SIGINT-aborted session yields warm reads (→ keep cache on abort, rows stay "read") OR pre-record "read OR creation (cold-replay)" exemptions in SCENARIO_RESULTS.md. If coherence insufficient, escalate (more context, or documented exemption).
  - intent: infra
  - files_allowed: [".spike-notes/claude-p-gate/**", "tests/int-claude-p-abort-coherence.mjs", "SCENARIO_RESULTS.md"]
  - allow_new_files: true
- [ ] 0b.G7 `--timeout` semantics: determine whether claude-p `--timeout` counts wall-time blocked on a held MCP call; set/derive it (or route cancellation via pi AbortSignal) so S3 (45s) / S8 (120s) tools cannot trip exit 124 (claude-p-driver.timeout-must-not-trip-on-a-held-tool-round).
  - intent: infra
  - files_allowed: [".spike-notes/claude-p-gate/**"]
  - allow_new_files: true
- [ ] 0b.G6 S5 disposition (also tracked at T1.16): finalize abort-and-respawn vs fork vs documented exemption; pre-record the forced cache-creation + abandoned-prefix-recall + no-duplicated-tail outcomes in `SCENARIO_RESULTS.md`. NOTE: G6 is intentionally EXCLUDED from the cut-over-blocking set (G1–G5 + G7 + G8 + G9 + G-resume); S5 may legitimately ship as a documented exemption; its disposition is re-openable if the T4.10 fork later adds mid-turn injection.
  - intent: infra
  - files_allowed: [".spike-notes/claude-p-gate/**", "SCENARIO_RESULTS.md", "openspec/changes/replace-sdk-with-claude-p/design.md"]
  - allow_new_files: true
- [ ] 0b.G8 **Parallel tool-call routing (HARD, blocks cut-over):** on a 2-parallel-tool fixture through claude-p, prove the router routes each held call to the correct pi `toolResult` with no cross-wiring. Per the claude-p investigation + design D32 reframe, routing goes via the MCP shim (bridge mints its OWN pi-facing id keyed to the parked `tools/call`; the model's `toolu_…` id is NOT needed to route) — so the cross-channel `toolu_…` reconciliation is UX-only, NOT a routing blocker. This still shapes the router's data structures, so it runs BEFORE T1.7 (router impl). (mcp-stdio-shim.tool-call-correlation-across-the-split-channels; S11)
  - intent: infra
  - files_allowed: [".spike-notes/claude-p-gate/**", "tests/int-claude-p-parallel-tools.mjs"]
  - allow_new_files: true
- [ ] 0b.G9 **Concurrent spawns / S25 + S14 (HARD, blocks cut-over):** prove two claude-p subprocesses run concurrently — BOTH (a) main + capture (a capture spawn while a main turn's tool is parked, S25) AND (b) **nested same-provider main + main** (a claude-bridge parent parked on `subagent` while a claude-bridge child runs, S14) — each with an isolated shim/socket/router and per-frame D32 correlation, no cross-talk, and that `WaitForMcpServers` resolves against a shim concurrently holding a DIFFERENT spawn's call open. Measure concurrent cold-boot cost. NOTE (from the investigation): claude-p's FIFO/relay-script paths are unique-per-invocation (`$TMPDIR/claude-p-<pid>-<rand>/`) so path collision is already retired; 2-way concurrency tested clean; the WATCH ITEM is higher-order concurrent-boot contention, which is the suspected trigger of the observed hook-timeout flakiness (D33) — G9 must stress ≥2 concurrent boots and confirm the resilience layer covers any contention-induced timeout. (claude-p-driver.concurrent-spawns-are-fully-isolated-capture-and-nested-subagents; output-capture.capture-path-isolation; design V/VI)
  - intent: infra
  - files_allowed: [".spike-notes/claude-p-gate/**", "tests/int-claude-p-concurrent.mjs"]
  - allow_new_files: true
- [ ] 0b.G-resume Verify claude-p forwards `--input-file` AND `--system-prompt-file` (large/multiline prompt + cold-start replay >50 KB). Historical D7 verified these on raw `claude`, NOT through claude-p. If unsupported, document the fallback before relying on it.
  - intent: infra
  - files_allowed: [".spike-notes/claude-p-gate/**"]
  - allow_new_files: true

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
- [ ] 1.9a Implement the claude-p resilience layer (design D33) in `src/driver/claudeP.ts`: bridge-side watchdog detects exit≠0-without-`result` / `SessionStartTimeout` / `StopTimeout`; bounded-retry-respawn (≤2, backoff, warn-logged) before surfacing `stopReason: "error"`; never retry after pi has consumed streamed output; abort signals the process GROUP and reaps orphaned `claude`/zmux descendants. (claude-p-driver.unexpected-driver-exit-surfaces-as-error retry path + abort orphan clause)
  - intent: feature
  - files_allowed:
      - src/driver/claudeP.ts
      - tests/unit-driver-resilience.mjs
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
- [ ] 1.12a Scenario S27 (tool-surface isolation, pi-TUI level): drive a turn that tempts native tools; assert via the bridge's `tools/list` introspection + log that the advertised surface is EXACTLY `mcp__custom-tools__*` and that NO native tool was routed/executed (emission-then-dropped is a PASS; `WaitForMcpServers` allowed). Surfaces the G2 guarantee at the acceptance-bar level per constitution IV. (claude-p-driver.native-tool-emission-is-blocked-via-disallowedtools; SCENARIOS.md S27)
  - intent: feature
  - files_allowed:
      - scripts/run-scenario-s27.sh
      - tests/int-claude-p-tool-isolation.mjs
  - allow_new_files: true
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
- [ ] 1.14a Implement abort partial-preservation: wire `index.ts`'s abort path to commit the assistant text (and prior tool_use blocks, or an "interrupted" marker when no in-flight text) streamed so far into the aborted-turn `AssistantMessage` handed to pi, so cold-replay carries it (claude-p-driver.abort-preserves-the-interrupted-partial-for-next-turn-recall). Ordered BEFORE 0b.G5's empirical proof.
  - intent: feature
  - files_allowed:
      - index.ts
      - tests/unit-abort-partial.mjs
- [ ] 1.16b Integration test: image handling (claude-p-driver.image-content-handling-in-v1) — main-path image strip + warn; capture-path image reject pre-spawn with stopReason error
  - intent: feature
  - files_allowed:
      - tests/int-claude-p-image.mjs
- [ ] 1.16c Unit test: stream premature-exit error (transcript-stream.driver-exit-without-terminal-result-surfaces-as-error) + malformed/garbage MCP message handling (mcp-stdio-shim.malformed-mcp-messages-surface-as-errors)
  - intent: feature
  - files_allowed:
      - tests/unit-driver-stream.mjs
      - tests/unit-mcp-shim.mjs
- [ ] 1.16d Integration test: abort-then-immediate-steer does not interleave the dying subprocess's stdout into the new turn (claude-p-driver.respawn-does-not-race-the-dying-subprocesss-stdout-reader; S9/S13)
  - intent: feature
  - files_allowed:
      - tests/int-claude-p-abort-steer-race.mjs
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
- [ ] 2.4 Integration test: capture mid-conversation isolation (output-capture.capture-path-isolation) — covers SINGLE-spawn isolation invariants (no shared `cachedSessionId`/socket/router state); the CONCURRENT two-spawn case (capture while a main tool is parked, + `WaitForMcpServers`) is gate 0b.G9
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

> **BLOCKED until gates pass.** T3.2/T3.3 (delete SDK path + deps) SHALL NOT run
> until G1–G5 + G7 + G8 + G9 + G-resume pass empirically AND G2 (constitution IV)
> is closed — OR the vendored claude-p fork (T4.10) is in place. (G6/S5 excluded —
> may ship as documented exemption.) The SDK path is the rollback fallback;
> deleting it before the gates is the risk-inversion the review flagged. T4.10 is
> reachable as a Phase-1 decision (see its note), not deferred to Phase 4.

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

- [ ] 4.1 **SCENARIO GATE (completion bar):** run the full pi-TUI scenario suite (`scripts/run-all-scenarios.sh`, S0–S27). EVERY scenario passes (mechanical + coherence + cache-shape) OR carries a documented fundamental architectural exemption recorded in `SCENARIO_RESULTS.md` AND design.md. No silent skips. S5 disposition (from T1.16) is recorded here. This task is NOT done until the suite is green-or-exempted.
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
- [ ] 4.3 Audit constitution IV — the BINDING assertion is the CLOSED-SET check: `tools/list` through claude-p shows EXACTLY `mcp__custom-tools__*` (catches any unknown re-enabled built-in), with the enumerated `--disallowedTools`/`--allowedTools` list as the mechanism (per D28(ii)); assert `--settings`/`-p`/`--print` are NEVER in the assembled claude-p argv; the runtime version-skew check (T4.7) re-audits the disallow set against `claude --help`'s tool list
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
- [ ] 4.10 (DECISION GATE — reachable in Phase 1) Vendor a claude-p fork if ANY blocking gate (G1–G5, G7, G8, G9, G-resume) fails or G2 (constitution IV) cannot be closed on upstream claude-p 0.1.0 (stream-json passthrough gaps, `--disallowedTools`/isolation not honored, no mid-turn injection for S5, `--timeout` counts held-call time). Vendor the fork, document the patch set, pin the bridge to it (forking-for-custom-patches skill), record rationale in design.md. This task is NOT deferred to Phase 4 — it is the precondition that unblocks Phase-3 cut-over when a gate fails.
  - intent: infra
  - files_allowed:
      - vendor/claude-p/**/*
      - package.json
      - openspec/changes/replace-sdk-with-claude-p/design.md
  - allow_new_files: true
