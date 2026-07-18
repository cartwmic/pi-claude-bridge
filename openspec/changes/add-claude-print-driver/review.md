---
scale: M
full_rigor: true
execution_mode: tdd-preferred
verification_mode: retained-required
debug_mode: standard
review_status: not-requested
delegation_mode: subagent-required
code_review_mode: gating-required
loop_max_iterations: 80
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
| Scale | M | Cross-capability driver addition affecting config, process lifecycle, streaming, MCP, capture, resume, diagnostics, and scenario coverage |
| full_rigor | true | ADR-worthy second-driver architecture and cross-cutting parity contract require standalone clarify/analyze, independent doneness, and retrospective |
| Execution Mode | tdd-preferred | Driver parser, argv, config, version, and lifecycle seams are independently testable before integration wiring |
| Verification Mode | retained-required | Equal-support parity requires retained unit, integration, and TUI scenario evidence |
| Debug Mode | standard | Feasibility spikes established root protocol; systematic debugging remains available when failures arise |
| Review Status | not-requested | Canonical verdicts will be sealed by blind dispatched reviewers |
| Delegation Mode | subagent-required | Implementation and every judgment step use configured role dispatch |
| Code Review Mode | gating-required | New inference path cannot ship without quiet multi-model blind review |
| Loop Max Iterations | 80 | Full-rigor Scale-M budget |
| Validation Source Mode | required | Build, unit/integration tests, strict OpenSpec validation, and live scenario evidence remain mandatory |
| Doneness Mode | required | Independent blind judge must confirm frozen intent satisfaction |
| Spec Level | spec-anchored | EARS delta requirements define acceptance contract |
| Model Config | user-configured | Resolved through `opsx models`; no per-change overrides |

## Diff Base + Worktree locator

**Diff Base SHA:** <captured by apply>
**Worktree Path:** <captured by apply>
**Integration Branch:** main

## Manual Adjustments

- Existing `claude-p` remains default while both paths are equally supported.
- `/claude-peek` unavailability under `claude-print` is the only accepted parity exception.
- Claude Code 2.1.208 is the direct-driver minimum because earlier versions can omit terminal `result` on large streamed output.
- Existing integration-checkout edits outside this change are user-owned and excluded from every loop commit.

## Execution Notes

- 2026-07-18 — Frozen baseline: `intent.md`; semantic edits require explicit owner authorization.
- 2026-07-18 — Feasibility evidence proved readiness-gated stream-json input, held multi-round MCP, capture stash, partial streaming, warm cache read, abort partials, and `--tools ""` MCP preservation.
- 2026-07-18 — Worktree locator pending apply lifecycle.

## Scope Expansions

- None.

## Fidelity Round Ledger

| Round | Fidelity | Per-judge verdicts | Attested HEAD |
|---|---|---|---|
