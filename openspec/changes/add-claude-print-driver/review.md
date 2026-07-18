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
- 2026-07-18 — Assumption: adding the inert `<!-- authored: in-session -->` marker required by the configured author-role gate is metadata only and does not alter frozen intent meaning.
- 2026-07-18 — Feasibility evidence proved readiness-gated stream-json input, held multi-round MCP, capture stash, partial streaming, warm cache read, abort partials, and `--tools ""` MCP preservation.
- 2026-07-18 — Worktree locator pending apply lifecycle.
- 2026-07-18 — Clarify round 1 blind dispatch at `8e6e71fc2bc71260e050a1dbaa9abd60417aa499`: configured review set all attested integration root/HEAD and failed (max P0=0, P1=17, P2=4, P3=7). `opsx_dispatch` refused because runtime reported no armed loop despite arm-generation context; fallback launched exact `opsx models review` models as three parallel read-only `pi --no-session` processes, writing sole findings sources under `/tmp/add-claude-print-driver-clarify-r1/`. Read-only window remained unchanged. Resolutions applied autonomously per frozen intent: driver-neutral brownfield restatements, typed memory/sidecars, explicit config/protocol failures, exact native controls, retry safety, direct isolation/images/steering, and deterministic dual-schema fixtures.
- 2026-07-18 — Clarify round-2 dispatch attempt at `0589d1655481498275b74c731907cf786bbef030` timed out at 900s: reviewer 3 produced a valid attested failure (P0=0, P1=5, P2=4, P3=0), reviewers 1/2 produced no findings file and are INVALID. Attempt does not count as completed round. Repository read-only window remained unchanged. Valid findings were fixed before redispatch: exact warm/isolation argv, immediate peek disposal, shim-owned stdin lifecycle, full interactive spawn restatement, env override scenario, driver-neutral diagnostics, and explicit direct stdin lifetime.

## Scope Expansions

- None.

## Fidelity Round Ledger

| Round | Fidelity | Per-judge verdicts | Attested HEAD |
|---|---|---|---|
