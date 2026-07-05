# Analyze Findings

**Mode:** single-model (Scale M < L → adversarial-review-cycle not required)
**Generated:** 2026-06-14 by worker (claude)

STRICTLY READ-ONLY report over proposal / specs / clarify / design.

## Check 1 — Constitution compliance

| Principle | Status | Rationale | Severity |
|---|---|---|---|
| I. Pi owns conversation state | inapplicable | No conversation-state persistence touched; resume sidecar untouched. | — |
| II. Bridge is inference-only | compliant | Diagnostics are observation only; no pi-tool execution or UI mutation added. | — |
| III. No filesystem coupling to driver mutable state | compliant | All new diagnostics write under the bridge debug dir (dir of `claude-bridge.log`); `--debug-file` points `claude` at a bridge-owned path, explicitly NOT under `~/.claude/` (design D4/D5; spec asserts it). | — |
| IV. Native Claude tools disallowed | inapplicable | `--disallowedTools` assembly unchanged. | — |
| V. System prompt fidelity per path | compliant | Capture path prompt bytes unchanged; only `timeoutSeconds` plumbing removed + debugFile option added (no prompt mutation). | — |
| VI. Concurrent paths share no state | compliant | Per-spawn debug/stderr files are keyed by sessionId+pid; no shared sink between main and capture paths. | — |
| VII. Failures surface; degradation is explicit | compliant | Core motivation: replaces a silent guess-and-kill watchdog with surfaced stderr + state dump + error-event tail. Stderr-write failure logs explicitly and continues (spec scenario). | — |

## Check 2 — EARS pattern check (major, human-triage)

Regex `/WHEN\s+[^.]*\b(error|fail|invalid|reject|deny|unauthor)/i` → 1 match.

| # | File:line | AC | True positive? | Suggested rewrite | Status |
|---|---|---|---|---|---|
| E1 | driver-diagnostics/spec.md:35 | "...WHEN a claude-p spawn exits without a terminal `result` line and the turn was not aborted, THE driver SHALL include the last N lines... in the `error` event..." | **no** (false positive) | none | n/a |

E1 rationale: the regex fired on the substring "error" inside "`error` event"
(the name of the emitted event type) and "aborted" is not a keyword. The WHEN
antecedent is a **nominal observable event** (a spawn closing without a `result`
line) from the diagnostics capability's perspective — the bridge always observes
this event and reacts; it is not an unwanted-condition antecedent. The genuine
unwanted conditions in this change correctly use IF…THEN (e.g. the stderr-write
failure scenario, the premature-exit-without-stderr scenario, the
claude-p-driver error-classification requirement). No rewrite needed.

## Check 3 — AC↔design coverage

| AC ID | Design section reference | Status | Severity |
|---|---|---|---|
| claude-p-driver.unexpected-driver-exit-surfaces-as-error | D1, D2 (watchdog/killWedged removal; retry gate preserved) | covered | — |
| claude-p-driver.prompt-injection-via-claude-p-input | D3 (no `--timeout`; dropped-prompt surfaces as real exit) | covered | — |
| driver-diagnostics.child-stderr-is-captured-to-a-per-spawn-debug-file | D4 | covered | — |
| driver-diagnostics.premature-exit-error-surfaces-the-last-stderr-lines | D4 | covered | — |
| driver-diagnostics.in-flight-state-dump-on-abnormal-termination | D6 | covered | — |
| driver-diagnostics.claude-debug-logging-is-forwarded-to-a-bridge-owned-file | D5 | covered | — |

## Check 4 — design↔ADR promotion candidates

| Decision | 4-point score | Recommendation |
|---|---|---|
| D1 (remove watchdog) | 4/4 | ADR-worthy; Scale M → optional. Flag for promotion at archive. |
| D2 (remove killWedged) | 3/4 | Mechanical interface narrowing; ADR not warranted. |
| D3 (remove `--timeout`) | 4/4 | ADR-worthy with D1 (could combine into one "no-liveness-timeouts" ADR). |
| D4 (stderr capture) | 3/4 | Visibility mechanism; ADR optional. |
| D5 (`--debug-file` forwarding) | 4/4 | ADR-worthy (documents the no-fork passthrough finding). |
| D6 (state dump) | 1/4 | Not warranted. |

Note: Scale M does not mandate ADRs. Candidates recorded for the archive skill.

## Check 5 — Duplicate detection

| # | Locations | Constraint | Action |
|---|---|---|---|
| D-1 | proposal "no new dependency" / design Non-Goals | Same statement | Acceptable (proposal summarizes; design scopes). No change. |
| D-2 | spec claude-p-driver "Silent spawn is not killed" scenario / "no bridge-side liveness timer" sentence | Reinforce the same removal | Intentional: requirement sentence + a concrete scenario asserting it. Not a true duplicate. |

No problematic duplication.

## Check 6 — Implementation language in specs

| # | AC | Implementation leak? | Action |
|---|---|---|---|
| 6-1 | driver-diagnostics file capture | Mentions "directory of the rotating `claude-bridge.log`" and NDJSON | Justified behavioral constraint (WHERE diagnostics may live = constitution III; WHY not on stdout = domain). Kept; not a gratuitous tech prescription. |
| 6-2 | debug-file forwarding | Names `--debug-file` flag | Necessary: the requirement IS about forwarding that specific flag; behavioral effect (claude's debug log captured to a bridge path) is stated. Acceptable. |

No solution-free violations requiring rewrite.

## Check 7 — Unresolved clarify findings

| Finding | Status |
|---|---|
| A1–A4, I1–I2, C1–C4 | all `answered` |

Clarify gate: READY. Zero unanswered/deferred findings.

## Verdict

**No blockers. No majors.** Tasks generation may proceed. Recommended ADR
promotion candidates (D1+D3, D5) recorded for archive-time review.
