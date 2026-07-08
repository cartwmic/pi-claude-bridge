---
scale: M
full_rigor: false
execution_mode: standard
verification_mode: retained-required
debug_mode: standard
review_status: not-requested
delegation_mode: subagent-required
code_review_mode: gating-required
loop_max_iterations: 40
validation_source_mode: required
spec_level: spec-anchored
doneness_mode: required
review_max_rounds: 5
review_budget_mode: quiet-round
---

# Review

<!-- authored: in-session -->

## Modes

| Mode | Value | Notes |
|---|---|---|
| Scale | M | Cross-cutting claude-p driver behavior change with downstream bridge impact |
| full_rigor | false | Plain Scale M; doneness rides code-review per opsx-loop rules |
| Execution Mode | standard | Worktree execution only |
| Verification Mode | retained-required | Verify artifact required because prompt submission is behavioral and regression-sensitive |
| Debug Mode | standard | No systematic-debugging mode unless failures arise during implementation |
| Review Status | not-requested | Canonical review verdict is sealed worktree-side |
| Delegation Mode | subagent-required | Blind reviewer verdicts required for gate-controlled review steps |
| Code Review Mode | gating-required | Prompt acceptance false positives are correctness defects with prior production impact |
| Loop Max Iterations | 40 | Scale-M default |
| Validation Source Mode | required | No waiver; tests and strict validation retained in worktree `verify.md` |
| Doneness Mode | required | Semantic intent satisfaction must be judged |
| Spec Level | spec-anchored | Acceptance criteria are source of implementation obligations |
| Model Config | (unset) | Use configured opsx role models |

## Diff Base + Worktree locator

**Diff Base SHA:** 3fdbcd3923f54b55f7e3a5f6dce7cb20224b686f
**Worktree Path:** /Volumes/Workshop/git/claude-p--opsx-deterministic-prompt-submission
**Integration Branch:** main

## Manual Adjustments

- This pi-claude-bridge checkout is the loop invocation root for the current turn, but the canonical in-progress implementation and verdict artifacts live in the claude-p opsx worktree recorded above.
- The locator intentionally points at the same in-progress `opsx/deterministic-prompt-submission` worktree so `opsx gate deterministic-prompt-submission` can resolve the already-sealed worktree artifacts instead of failing `change not found` in this checkout.
- Scope assumption: this is an integration-side locator/bookkeeping artifact only; no bridge runtime code is changed in this unit of progress.

## Execution Notes

- 2026-07-07 — Intent is frozen in claude-p at commit `124926b902ba52c8e5a7e725ecc7d714d8689ef7`; do not edit `intent.md` without owner re-authorization.
- 2026-07-07 — Standing no-liveness-timeouts principle applies: no submission/acceptance wall-clock caps; waits are event waits only.
- 2026-07-07 — Worktree captured by `opsx worktree ensure deterministic-prompt-submission`: base `3fdbcd3923f54b55f7e3a5f6dce7cb20224b686f`, path `/Volumes/Workshop/git/claude-p--opsx-deterministic-prompt-submission`, integration branch `main`.
- 2026-07-07 — Current bridge-root gate failure was `GATE-FAIL change 1 change not found: deterministic-prompt-submission`; this locator fixes that root cause without duplicating the canonical change artifacts.

## Scope Expansions

- None.

## Fidelity Round Ledger

| Round | Fidelity | Per-judge verdicts | Attested HEAD |
|---|---|---|---|
