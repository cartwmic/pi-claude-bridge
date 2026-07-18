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
review_max_rounds: 8
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

- Owner's autonomous drive-to-green instruction preauthorizes continuing past the original five-round review budget without an interactive checkpoint; `review_max_rounds` extended to 8 after round 5 exposed objective remaining blockers.
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
- 2026-07-18 — Analyze/fidelity round 2 at `0a7ef20d6cb759f9f2c49f181be1f67c30959cba`: review approve/needs-revision/needs-revision, fidelity delivered/violated/violated; max P0=0, P1=3, P2=4, P3=5. Every judge attested correct integration root/HEAD and supplied 126 rows; two used noncanonical markdown wrappers around attestation, accepted for round evidence but not reusable as seal provenance. Read-only window unchanged. Fixes: phase-aware pre-submit-abort persistence, pi-id resolver authority with model-id aliases, fail-closed scenario harness, exact observational allowlist, deterministic capture validation retention, warn-on-divergence, two-retry envelope, concrete readiness env, source-of-record docs migration, and required S28/S29 integrations.
- 2026-07-18 — Analyze/fidelity round 3 at `2b05c412eeff138e4d8be6a6f40f7c1d6622d66d`: review approve/needs-revision/needs-revision; fidelity delivered ×3 over exact 128-row sweeps; max P0=0, P1=1, P2=4, P3=4. Canonical attestation grammar and read-only window passed for every judge. Remaining plan-review blockers fixed without changing intent: private prompt artifacts (0700 directory/0600 exclusive files/all-exit cleanup) and version floor before inference-child spawn. Advisories tightened terminal/line bounds, D32 causal closure, retry logging, diagnostics failure tolerance, and mandatory S21 assertions.
- 2026-07-18 — Analyze/fidelity round 4 at `cae93b36fe5751eb454c08b79b4f71011384fd4a`: review approve/needs-revision/needs-revision; fidelity delivered/violated/violated over exact 129-row sweeps; max P0=0, P1=3, P2=5, P3=4. All judges used canonical attestation and left tree unchanged. Final-budget fixes: cold/warm prompt construction and capture usage mapping, phase-aware direct acceptance persistence, submitted-warm retry cold repack, downgrade quarantine for direct sidecars, config I/O fail-loud rules, and explicit result/line/cleanup bounds.
- 2026-07-18 — Analyze/fidelity round 5 at `45d472508c1a95face9989b96e811c4cdf227ae8`: review approve/needs-revision/needs-revision; fidelity delivered/violated/delivered over exact 131-row sweeps; max P0=0, P1=2, P2=4, P3=4. All attestation/read-only checks passed. Owner's standing autonomous drive-to-green directive resolves original hard-cap landing in favor of continued blind convergence; budget extended to 8. Fixes: post-submit/pre-accept abort invalidates direct session, rollback stop-before-quarantine ordering, S31 dual-driver evidence, bridged-only observation accounting, direct WaitFor preamble removal, nested-record rule, and fail-closed config symlink handling.
- 2026-07-18 — Analyze/fidelity round 6 at `b0009adc5c2e1af1fcd01af2e7ec394985e249c0`: review approve ×3 with max P0=0, P1=0 (quiet review), and all judge summaries said fidelity delivered over 131 rows. Fail-closed key consolidation nevertheless yields `violated` because reviewer 1 placed S31 large-cold-start in `not-covered`, despite D10 naming S31 twice; reviewer 2/3 marked it entailed. No human waiver used. Made S31 gate id/script/two-driver sentinel assertion explicit and scheduled full rejudge.
- 2026-07-18 — Analyze/fidelity round 7 at `3ed274ecdef18496a3017e720108b0a42c29d07a`: review approve/approve/needs-revision; fidelity delivered/delivered/violated over exact 131-row sweeps; max P0=0, P1=1, P2=5, P3=4. All attestations/read-only checks passed. Objective final issue: capture prompt-fidelity cleanup needed explicit interactive fork readiness gate. D8 now names direct pre-NDJSON sentinel and interactive `claude-p --mcp-ready-file` Enter hold; D5 also states bridged observations are count-mandatory but order-optional and native/foreign observations never enter counts.
- 2026-07-18 — Analyze/fidelity round 8 SEALED at `d701c827b737e221e0642a5506b2f54b1987ce3d`: review approve ×3, max P0=0/P1=0; every judge summary delivered, canonical key sets complete (reviewer 2 used keyed TSV rather than markdown table), and deterministic worst-of consolidation is 131/131 `entailed`. `design-fidelity.md` filled from shipped template with bound-file digests and adversarial-multimodel provenance; `analyze.md` records 0 blockers/0 majors and READY for tasks. Read-only window unchanged.

## Scope Expansions

- None.

## Fidelity Round Ledger

| Round | Fidelity | Per-judge verdicts | Attested HEAD |
|---|---|---|---|
| 1 | violated | reviewer-1 delivered; reviewer-2 violated; reviewer-3 violated | `9679d05231723e3f6b95dc9135123e2887222369` |
| 2 | violated | reviewer-1 delivered; reviewer-2 violated; reviewer-3 violated | `0a7ef20d6cb759f9f2c49f181be1f67c30959cba` |
| 3 | delivered | reviewer-1 delivered; reviewer-2 delivered; reviewer-3 delivered | `2b05c412eeff138e4d8be6a6f40f7c1d6622d66d` |
| 4 | violated | reviewer-1 delivered; reviewer-2 violated; reviewer-3 violated | `cae93b36fe5751eb454c08b79b4f71011384fd4a` |
| 5 | violated | reviewer-1 delivered; reviewer-2 violated; reviewer-3 delivered | `45d472508c1a95face9989b96e811c4cdf227ae8` |
| 6 | violated | reviewer-1 summary delivered but S31 row not-covered; reviewer-2 delivered; reviewer-3 delivered | `b0009adc5c2e1af1fcd01af2e7ec394985e249c0` |
| 7 | violated | reviewer-1 delivered; reviewer-2 delivered; reviewer-3 violated | `3ed274ecdef18496a3017e720108b0a42c29d07a` |
| 8 | delivered | reviewer-1 delivered; reviewer-2 delivered; reviewer-3 delivered | `d701c827b737e221e0642a5506b2f54b1987ce3d` |
