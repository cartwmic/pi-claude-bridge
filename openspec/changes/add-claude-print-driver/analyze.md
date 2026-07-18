# Analyze Findings

<!-- authored: subagent -->

**Mode:** adversarial-review-cycle
**Generated:** 2026-07-18 by blind review set (claude-fable-5, gpt-5.6-sol, cursor-grok-4.5)

## Check 1 — Constitution compliance

| Principle | Status | Rationale | Severity |
|---|---|---|---|
| I. Pi owns conversation state | compliant | D6 persists only content-free typed hints; pi history remains canonical and unsafe hints cold-start. | — |
| II. Bridge is inference-only | compliant | D1/D5 retain shim/router routing and pi execution; direct observations never execute tools. | — |
| III. No filesystem coupling to mutable Claude state | compliant | Direct path uses flags/process channels/bridge-owned artifacts and never reads or writes `~/.claude/`. | — |
| IV. Native Claude tools are disallowed | compliant | Direct `--tools ""`, exact roster and non-execution gates; interactive denylist adds `ReportFindings`/`SendMessage`. | — |
| V. System prompt fidelity per path | compliant | D8 restores capture static-system-prompt byte fidelity and moves bridge control to user suffix. | — |
| VI. Concurrent paths share no state | compliant | D5/D8 assign disjoint process, shim, router, socket, queues, session and correlation state. | — |
| VII. Failures surface | compliant | Config/version/readiness/protocol/correlation/process failures are explicit; no cross-driver fallback. | — |

## Check 2 — EARS pattern check (major, human-triage)

Regex used: `/WHEN\s+[^.]*\b(error|fail|invalid|reject|deny|unauthor)/i`. All matches were read in context.

| # | File:line | AC | True positive? | Suggested rewrite | Status |
|---|---|---|---|---|---|
| E1 | delta specs (contextual sweep) | `error_during_execution`, `without error`, and caller-abort lifecycle mentions | no | None; keywords are record names, negated success text, or nominal events | fixed |

No true-positive WHEN-on-failure requirement remains.

## Check 3 — AC↔design coverage

| AC ID | Design section reference | Status | Severity |
|---|---|---|---|
| bridge-driver-selection.driver-selection-uses-layered-bridge-configuration | D2, D6, D7 | covered | minor |
| bridge-driver-selection.selected-driver-is-pinned-to-invocation-lifecycle | D2, D6, D7 | covered | minor |
| bridge-driver-selection.in-memory-session-hints-are-driver-typed | D2, D6, D7 | covered | minor |
| bridge-driver-selection.driver-failures-never-trigger-cross-driver-fallback | D2, D6, D7 | covered | minor |
| bridge-driver-selection.direct-driver-enforces-independent-version-floor | D2, D6, D7 | covered | minor |
| claude-p-driver.claude-p-spawn-with-model-selection | D1, D7 | covered | minor |
| claude-p-driver.native-tool-emission-is-blocked-via-disallowedtools | D1, D7 | covered | minor |
| claude-p-driver.image-content-handling-in-v1 | D1, D7 | covered | minor |
| claude-p-driver.interactive-held-calls-have-no-upstream-idle-cutoff | D1, D7 | covered | minor |
| claude-peek-overlay.overlay-toggle-command | D9 | covered | minor |
| claude-peek-overlay.peek-follows-latest-main-turn-spawn-only | D9 | covered | minor |
| claude-peek-overlay.peek-explicitly-rejects-non-tui-driver | D9 | covered | minor |
| claude-peek-overlay.interactive-peek-behavior-remains-available | D9 | covered | minor |
| claude-print-driver.direct-print-invocation-uses-bidirectional-stream-protocol | D3–D7 | covered | minor |
| claude-print-driver.prompt-submission-waits-for-exact-mcp-readiness | D3–D7 | covered | minor |
| claude-print-driver.direct-native-tool-surface-is-closed | D3–D7 | covered | minor |
| claude-print-driver.partial-stream-is-normalized-without-duplication | D3–D7 | covered | minor |
| claude-print-driver.direct-protocol-drift-surfaces-explicitly | D3–D7 | covered | minor |
| claude-print-driver.one-direct-process-spans-held-tool-rounds | D3–D7 | covered | minor |
| claude-print-driver.direct-usage-and-session-metadata-are-authoritative | D3–D7 | covered | minor |
| claude-print-driver.direct-abort-preserves-partial-and-reaps-process-group | D3–D7 | covered | minor |
| claude-print-driver.direct-failure-and-retry-preserve-side-effect-safety | D3–D7 | covered | minor |
| claude-print-driver.direct-driver-has-no-inference-liveness-timeout | D3–D7 | covered | minor |
| claude-print-driver.direct-concurrent-invocations-are-isolated | D3–D7 | covered | minor |
| claude-print-driver.direct-image-behavior-matches-bridge-contract | D3–D7 | covered | minor |
| claude-print-driver.direct-steering-uses-abort-and-fresh-dispatch | D3–D7 | covered | minor |
| claude-print-driver.direct-driver-avoids-mutable-claude-filesystem-coupling | D3–D7 | covered | minor |
| driver-diagnostics.child-stderr-is-captured-to-a-per-spawn-debug-file | D9 | covered | minor |
| driver-diagnostics.premature-exit-error-surfaces-the-last-stderr-lines | D9 | covered | minor |
| driver-diagnostics.in-flight-state-dump-on-abnormal-termination | D9 | covered | minor |
| driver-diagnostics.claude-debug-logging-is-forwarded-to-a-bridge-owned-file | D9 | covered | minor |
| driver-diagnostics.diagnostics-identify-selected-driver | D9 | covered | minor |
| mcp-stdio-shim.shim-lifecycle-is-bound-to-its-spawn | D3, D5, D7 | covered | minor |
| mcp-stdio-shim.tool-call-correlation-across-the-split-channels-d32 | D3, D5, D7 | covered | minor |
| mcp-stdio-shim.shim-readiness-proves-exact-tool-availability | D3, D5, D7 | covered | minor |
| output-capture.output-capture-classification-of-ctx-tools | D2, D8 | covered | minor |
| output-capture.strict-call-shape-capture-mode-mutually-exclusive-with-executable-tools-root-must-be-object | D2, D8 | covered | minor |
| output-capture.capture-path-isolation | D2, D8 | covered | minor |
| output-capture.synthesized-toolcall-content-block-on-success | D2, D8 | covered | minor |
| output-capture.surface-absent-capture-tool-call-as-error | D2, D8 | covered | minor |
| output-capture.capture-path-honors-abortsignal | D2, D8 | covered | minor |
| output-capture.capture-path-forwards-systemprompt-and-replays-message-history-text-only-lossy | D2, D8 | covered | minor |
| output-capture.capture-path-does-not-leak-resources | D2, D8 | covered | minor |
| output-capture.empty-prompt-handling | D2, D8 | covered | minor |
| output-capture.capture-path-emits-no-intermediate-stream-events | D2, D8 | covered | minor |
| output-capture.capture-uses-owning-invocation-driver | D2, D8 | covered | minor |
| scenario-coverage.large-cold-start-prompt-coverage | D10 | covered | minor |
| scenario-coverage.full-bridge-scenarios-run-against-both-drivers | D10 | covered | minor |
| scenario-coverage.direct-protocol-integration-gates-are-retained | D10 | covered | minor |
| scenario-coverage.both-stream-schemas-have-deterministic-fixtures | D10 | covered | minor |
| scenario-coverage.direct-concurrency-scenarios-prove-state-isolation | D10 | covered | minor |
| warm-pi-resume.resume-sidecar-persisted-on-successful-turn | D6, D10 | covered | minor |
| warm-pi-resume.validated-warm-resume-on-pi-resume | D6, D10 | covered | minor |
| warm-pi-resume.driver-guarantees-a-live-resume-result-no-bridge-side-stale-guard | D6, D10 | covered | minor |
| warm-pi-resume.warm-path-performs-no-new-claude-config-access | D6, D10 | covered | minor |
| warm-pi-resume.aborted-mid-tool-sessions-remain-resumable | D6, D10 | covered | minor |
| warm-pi-resume.resume-sidecar-records-driver-identity | D6, D10 | covered | minor |
| warm-pi-resume.cross-driver-warm-resume-is-forbidden | D6, D10 | covered | minor |

All 58 requirement-level ACs and final canonical 131 scenario keys are covered. Sealed worst-of fidelity sweep records every scenario as `entailed`.

## Check 4 — design↔ADR promotion candidates (full_rigor)

| Decision | 4-point score | ADR-candidate? | Rationale |
|---|---:|---|---|
| D1 driver-neutral orchestration | 4/4 | yes | Lasting seam constrains every current/future driver. |
| D2 layered config and pinning | 4/4 | yes | Public precedence and lifecycle policy. |
| D3 readiness-gated stream input | 4/4 | yes | Protocol/billing/tool-availability boundary. |
| D4 direct stream authority | 4/4 | yes | Fail-closed schema and duplication policy. |
| D5 split-channel correlation | 4/4 | yes | Correctness-critical resolver and batch semantics. |
| D6 typed resume/version floor | 4/4 | yes | Persisted compatibility and safe-cold boundary. |
| D7 lifecycle/retry/idle policy | 4/4 | yes | Side-effect-sensitive process policy. |
| D8 selected-driver capture | 4/4 | yes | Prompt-fidelity and result-authority boundary. |
| D9 peek/diagnostics | 3/4 | yes | Lasting capability and observability contract. |
| D10 validation matrix | 3/4 | yes | Lasting shipping-evidence policy. |

All ten remain archive-time ADR promotion candidates.

## Check 5 — Duplicate detection

| # | Locations | Restated constraint | Action |
|---|---|---|---|
| Dup1 | bridge-driver-selection + warm-pi-resume | Driver identity on in-memory and persisted hints | Keep differentiated by storage layer. |
| Dup2 | claude-p-driver + claude-print-driver | Upstream MCP idle cutoff disabled | Keep per-driver parity ACs; D7 owns shared mechanism. |
| Dup3 | driver specs + scenario-coverage | Native roster closure | Keep mechanism ACs plus independent shipping gate. |
| Dup4 | capture + image requirements | Capture warn/drop text-only policy | Keep; clarify I1 makes output-capture authoritative. |

No contradictory duplicate remains.

## Check 6 — Implementation language in specs

| # | AC ID | Tech mentioned | Judgment |
|---|---|---|---|
| Imp1 | claude-print-driver protocol ACs | Claude CLI flags, NDJSON, environment variables | justified external interoperability/security contract frozen by intent |
| Imp2 | output-capture isolation ACs | temporary cwd, MCP/IPC | justified path-isolation and authority contract inherited from spec of record |
| Imp3 | warm-pi-resume sidecar ACs | persisted driver field and hashes | justified content-free compatibility contract |

No unjustified technology prescription remains.

## Check 7 — Unresolved clarify findings

| # | clarify.md ref | Status | Risk |
|---|---|---|---|
| — | A1–A10, I1–I6, C1–C10 | answered | none |

## Adversarial round appendix

| Round | HEAD | Review result | Consolidated fidelity | Primary remediation |
|---:|---|---|---|---|
| 1 | `9679d052…` | P1 present | violated | prompt channel, capture IPC/fidelity, correlation, manifest |
| 2 | `0a7ef20d…` | P1 present | violated | abort persistence, resolver key, fail-closed harness |
| 3 | `2b05c412…` | P1 present | delivered | private artifacts, version timing, parser/lifecycle bounds |
| 4 | `cae93b36…` | P1 present | violated | prompt construction, retry/resume, rollback quarantine |
| 5 | `45d47250…` | P1 present | violated | observation filtering, preamble removal, rollback order |
| 6 | `b0009adc…` | quiet review | violated (one inconsistent not-covered row) | explicit S31 gate |
| 7 | `3ed274ec…` | P1 present | violated | interactive capture readiness under prompt fidelity |
| 8 | `d701c827…` | approve ×3; P0=0/P1=0 | delivered; 131/131 entailed | sealed |

## Outstanding risks

- P2/P3 advisory only: executable scenario catalog must backfill missing human-readable entries while required script inventory stays fail-closed.
- Direct dangling-tool resume and capture user-suffix compliance remain non-waivable live stop gates, already required by D10.
- Parser allowlist intentionally fails loud on new Claude records; version upgrades require fixtures.
- D5 under-count waits for process terminal/failure/caller abort by no-watchdog policy; diagnostics must make held state visible.
- Rollback-quarantine and private-temp crash scavenging need deterministic tests in apply.

## Summary

- Blockers: 0
- Major findings: 0
- Minor findings: 5 retained as implementation advisories/required tests
- **Gate status:** READY for tasks
