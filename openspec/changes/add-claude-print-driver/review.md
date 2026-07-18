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
- 2026-07-18 — Clarify round 2 completed at `92d39851b5d3883238cc77b108a72ab1c3c8025e`: reviewer verdicts pass/fail/fail, max P0=0, P1=10, P2=7, P3=6; first split round, below disclosure trigger. All three attested integration root/HEAD and read-only window remained unchanged. Fixes preserve full frozen intent: explicit direct shim argv and record matrix, standalone capture resolution, sole router correlation, driver-neutral peek/correlation/diagnostics, exact MCP idle env, bare-restart resume, typed sidecar constitution PATCH clarification, capture mappings/truncation/error shape/empty-prompt semantics, and dual-driver large-prompt evidence.
- 2026-07-18 — Clarify round-3 attempt at `1251cb860d6a54747d0403ea32bec79aaa132d5d`: reviewers 1/2 valid (pass/fail; max P1=2), reviewer 3 INVALID after cursor provider `EPIPE`; attempt incomplete and does not count. Read-only window remained unchanged. Fixed all valid must-fix findings plus advisories tied to intent: conditional debug flag, terminal-result-required capture success, explicit terminal error/correlation behavior, exact MCP config, project-owned standalone capture, config validation, direct prompt-file/timeout/retry bounds, resolution-point peek disposal, dangling direct warm resume evidence, and canonical scenario source.
- 2026-07-18 — Clarify round 3 completed QUIET at `f73bc6e5745953dc40cd8b6bdb5cdfd29c960b14`: pass/pass/pass; max P0=0, P1=0, P2=9, P3=4. All reviewers attested integration root/HEAD; read-only window unchanged. Advisory decisions resolved in `clarify.md`; no unanswered/deferred findings.
- 2026-07-18 — Analyze/fidelity round 1 at `9679d05231723e3f6b95dc9135123e2887222369`: review needs-revision ×3, fidelity delivered/violated/violated; max P0=0, P1=4, P2=5, P3=4. All judges supplied exact 126-row canonical sweeps and attested integration root/HEAD; read-only window unchanged. Fixes: large system prompt channel, fail-closed observational taxonomy, explicit direct steering, exact interactive denylist, asynchronous D32 coordinator, capture validation IPC + verbatim system-prompt channel, manifest-owned validation commands, hard live-proof stops, shared-refactor rollback, and stale path correction.

## Scope Expansions

- None.

## Fidelity Round Ledger

| Round | Fidelity | Per-judge verdicts | Attested HEAD |
|---|---|---|---|
| 1 | violated | reviewer-1 delivered; reviewer-2 violated; reviewer-3 violated | `9679d05231723e3f6b95dc9135123e2887222369` |
