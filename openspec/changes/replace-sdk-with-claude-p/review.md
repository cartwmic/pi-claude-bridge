# Review

Controlled-vocabulary mode switchboard. The apply instruction reads these
modes and dispatches behavior.

## Modes

| Mode | Value | Notes |
|---|---|---|
| Scale | L | Cross-capability refactor with ADR-worthy decisions (D1, D3, D4, D5 firm) + breaking change (AskClaude removal). XL was considered but ~70% of `index.ts` (conversation state machinery) survives; XL would overstate scope. |
| Execution Mode | tdd-preferred | New modules (`driver/`, `mcp/`, `capture.ts`) have well-defined contracts; AC-driven tests should drive the design. Not `tdd-required` because some PTY-integration code can only be tested against the real `claude` binary; pure-TDD on every line would slow Phase 0 spike work. |
| Verification Mode | retained-required | Constitution principle VII (failures surface) requires durable AC↔test mapping. `verify.md` MUST exist before archive; verify gate's check 5 enforces canonical AC ID grep. |
| Debug Mode | standard | Not a regression-debug change; greenfield refactor. |
| Review Status | requested | Schema mandates adversarial-review-cycle at Scale ≥ L. Owner sign-off required before invocation (the skill is user-invoked-only per its description). Will move to `findings-received` after adversarial round runs. |
| Delegation Mode | subagent-driven | **Owner override 2026-05-31** (was `single-agent`): owner directed subagent-driven implementation. Main agent is WRITEBACK OWNER (owns artifact `.md` writeback, tasks-checkbox marking, commits, per-task contract diffs); fresh subagents implement code/tests per task and return structured handoffs. |
| Worktree Mode | same-tree | **Owner override 2026-05-31** (was `worktree-required`): owner directed implementation in the current work tree (branch `replan-driver-from-phase-0`), no separate git worktree. Feature-flag default stays `sdk` through Phase 2, so the SDK path remains the in-tree rollback fallback; contract diffs use the fixed Base SHA below. |
| Spec Level | spec-anchored | OpenSpec's natural mode. The specs in this change describe behavior; the code implements them. Not `spec-as-source` — bridge code already exists with significant non-spec'd implementation detail. |

## Worktree Base SHA

<!-- Captured by apply at worktree creation. Leave empty until apply starts. -->

**Worktree Base SHA:** `3f732090cb705a8d2eb4ca343d2505e59d5ae13c`
<!-- 2026-05-31: re-pointed to current HEAD of `replan-driver-from-phase-0` for same-tree apply.
     The prior value `27a471c` was the SUPERSEDED in-house-PTY base; the 2026-05-21 Execution
     Note below (worktree at worktrees/replace-sdk-with-claude-p, base 27a471c) is from that
     superseded plan and does not apply to this same-tree run. -->
T1.1 (worktree creation) is N/A under same-tree mode — marked done with this note instead.

## Manual Adjustments

- **Scale = L** instead of default S: cross-capability change touching 4 specs (3 new + 1 modified), removes a runtime dependency, drops a public feature.
- **Execution Mode = tdd-preferred** instead of standard: new code surface has well-defined ACs; tests should lead. PTY-integration testing prevents `tdd-required`.
- **Verification Mode = retained-required** instead of retained-recommended: constitution VII makes AC↔test mapping non-negotiable for this change.
- **Review Status = requested** instead of not-requested: schema mandates adversarial review at Scale ≥ L. Pending owner sign-off because the `adversarial-review-cycle` skill is user-invoked-only.
- **Worktree Mode = worktree-required** instead of same-tree: feature-flag rollout across multiple phases requires isolation and clean rollback.

## Execution Notes

<!-- Transient observations appended during apply. -->

- 2026-05-21 00:31 — Worktree created at `worktrees/replace-sdk-with-claude-p`. Base SHA `27a471c`. Adversarial review complete (5 rounds, treadmill stop); persistent log in `.opsx-review/replace-sdk-with-claude-p/`. Beginning Phase 0 spikes. **[SUPERSEDED — in-house-PTY plan; superseded by the claude-p replan.]**
- 2026-06-01 — Foundation modules (T1.4 stream, T1.5 ipc, T1.6 shim, T1.7 router) landed via 2 parallel subagents; 48 new unit tests green (stream 14, ipc 9, router 8, shim 17). **Canonical shim dist path is `dist/src/mcp/shim.js`** (root-level `index.ts` forces `rootDir:"."`, so `src/` is preserved under `dist/`). `bin` corrected to match; **T1.9 wiring MUST use `require.resolve("pi-claude-bridge/dist/src/mcp/shim.js")`** (D19), and dev/tsx spawns use `src/mcp/shim.ts`. Shim config contract: argv `--socket <path> --mode <main|capture> --tools <base64-json> [--capture-tool <name>]` (env `PI_CLAUDE_BRIDGE_SHIM_TOOLS` fallback). Router API: `start/declareTools/deliver(piId,result)/getCaptureStash/listParkedCalls/stop` + `pendingResolvers`/`pendingResults` maps. Stream parser: `new ClaudePStreamParser({onEvent,logger}); .write(chunk); .endOfStream({aborted,exitInfo})`; events synchronous; turn-end = `usage` then `done(result)`; `tool-use` events observational only (routing owned by shim/router per D32).
- 2026-05-31 — Apply started under owner overrides: Delegation Mode → subagent-driven, Worktree Mode → same-tree (branch `replan-driver-from-phase-0`, HEAD `3f73209`). Base SHA re-pointed to `3f73209`. T1.1 N/A (no worktree). Observation: `src/driver/{ansi.ts,pty.ts}` + `tests/unit-driver-{ansi,trust-scanner}.mjs` are leftover in-house-PTY artifacts (commit 59f3885) the replan supersedes — not in any claude-p task contract; left in place behind the default-`sdk` flag, flagged for Phase-3 cleanup. claude-p obtained via npm (`claude-p@0.1.0`); `claude` 2.1.159 present. Executing plan.md order (foundation modules before the 0b empirical gates, which need the built shim/router/driver).
- 2026-06-02 — **APPLY COMPLETE. All 64 tasks done; `openspec validate` green; `npm run test:unit` 285/285.** claude-p is the sole/default driver; SDK path + `@anthropic-ai/*` deleted; AskClaude removed. All blocking hard gates (G1–G9 + G-resume) PASS on **upstream claude-p 0.1.0 — no fork** (G2 constitution-IV isolation closed; G4 single-shot caching works with a large pinned prefix; the original G4 "fail" was a test artifact). S0–S27 scenario suite green-or-exempt (sole exemption: S7 exact-number recall — claude-p buffers turn text). verify.md Completion Decision = **green** (37/37 ACs). **Reliability caveat (accepted by owner as a follow-up):** the full sequential real-claude-p `npm test` is flaky — root-caused to claude-p 0.1.0 missing its `Stop` hook under concurrent boots (`hang-rootcause.md`); a RUNTIME limitation, not a bridge defect (deterministic `test:unit` is the CI gate; scenario suite is the acceptance bar with retries; each int test passes in isolation). PROPER fix = **persistent-process** model (one long-lived session) — owner accepted this as a SEPARATE follow-up change (documented in design.md "Fork decision (T4.10)" + the persistent-process/idle-watchdog/concurrency-cap notes + TODO.md). Change is **archive-ready** (run `/opsx:archive` when ready). Bugs fixed during apply: F1 tool double-prefix, G2 denylist completeness, warm-resume re-echo, MCP-startup race, claude-p bin resolution, abort-test text-streaming assumption.
