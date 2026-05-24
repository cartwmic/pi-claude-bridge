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
| Delegation Mode | single-agent | One agent owns the refactor end-to-end. Subagent dispatch adds coordination overhead that outweighs parallelism benefits for a tightly-coupled inference-driver swap. |
| Worktree Mode | worktree-required | Phases 1–3 swap the inference driver behind a feature flag (`CLAUDE_BRIDGE_DRIVER=pty\|sdk`). A worktree isolates the refactor from `main`, keeps the SDK path testable during transition, and provides clean rollback. File-contract diffs need a stable base SHA. |
| Spec Level | spec-anchored | OpenSpec's natural mode. The specs in this change describe behavior; the code implements them. Not `spec-as-source` — bridge code already exists with significant non-spec'd implementation detail. |

## Worktree Base SHA

<!-- Captured by apply at worktree creation. Leave empty until apply starts. -->

**Worktree Base SHA:** `27a471ceeb643c8ce386e66fdce3cc64a957cc57`

## Manual Adjustments

- **Scale = L** instead of default S: cross-capability change touching 4 specs (3 new + 1 modified), removes a runtime dependency, drops a public feature.
- **Execution Mode = tdd-preferred** instead of standard: new code surface has well-defined ACs; tests should lead. PTY-integration testing prevents `tdd-required`.
- **Verification Mode = retained-required** instead of retained-recommended: constitution VII makes AC↔test mapping non-negotiable for this change.
- **Review Status = requested** instead of not-requested: schema mandates adversarial review at Scale ≥ L. Pending owner sign-off because the `adversarial-review-cycle` skill is user-invoked-only.
- **Worktree Mode = worktree-required** instead of same-tree: feature-flag rollout across multiple phases requires isolation and clean rollback.

## Execution Notes

<!-- Transient observations appended during apply. -->

- 2026-05-21 00:31 — Worktree created at `worktrees/replace-sdk-with-pty-tui`. Base SHA `27a471c`. Adversarial review complete (5 rounds, treadmill stop); persistent log in `.opsx-review/replace-sdk-with-pty-tui/`. Beginning Phase 0 spikes.
- 2026-05-22 — Phase 5 added post-scenario-validation. **Adversarial review post-mortem:** All 5 review rounds (`smith/codex` + `claude-bridge/opus`) missed the OAuth interactive-mode tier-cap failure mode for positional-prompt invocations. Not documented in `claude --help`, not in Anthropic public docs. Only discovered by running the scenario suite end-to-end against the real `claude` binary on a real OAuth account. D13 → D26 supersession is the resulting mitigation; reference `smithersai/claude-p` was the source of the working typed-injection pattern. Failure-class lesson: future Scale-L PTY/IDE/TUI integrations should require end-to-end scenario validation against the real OAuth-authed third-party binary BEFORE marking implementation phase complete.
- 2026-05-23 — **Scope expansion (owner directive).** Completion criterion tightened to: ALL 28 pi-tui scenario tests (S0-S25) must pass end-to-end via `bash scripts/run-all-scenarios.sh`. No deferred scenarios. Previously v1.1.0-scoped items absorbed into v1.0.0: warm-resume cache (D22), real tool round-trip (replace v0 stub `[pi: deferred]`), abort+steer+supersede frame machinery, capture-mode isolation against concurrent main-path turns, first-turn-after-pi-boot transcript-timeout flake debug. Phase 7 added to tasks.md (7.1–7.19); verify.md Completion Decision flipped from amber → red with per-scenario root-cause triage table. Estimated effort: substantial — buckets A (warm-resume), B (tool round-trip), C (abort/supersede) each represent multi-file refactor of streamPty.ts to port machinery from the SDK path (index.ts). Reviewer-driven invariants (D7-final, D11, D15, D17, D18, D20, D22, D25 + new D26+D27) remain intact; the absorbed work was already designed and reviewed, just unimplemented in v0.
