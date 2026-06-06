# Review

Controlled-vocabulary mode switchboard for `apply`.

## Modes

| Mode | Value | Notes |
|---|---|---|
| Scale | L | Constitution **Governance** mandates Scale ≥ L for any change that amends a principle (this amends Principle I, D8). Also: new persistent cross-process state, a hard cross-change dependency, a net-new driver-signal plumbing, and core turn-lifecycle edits. Scale L pulls in mandatory ADR promotion (D1/D2/D5/D8) and the adversarial-review-cycle (this review). Bumped from M during adversarial review — M was a governance violation. |
| Execution Mode | tdd-preferred | Validation logic (sidecar read/write, prefix-match, version/stale gates, key normalization) is cleanly unit-testable; write tests first for those. Resume end-to-end is spike/integration-gated. |
| Verification Mode | retained-required | Touches turn lifecycle + amends the constitution → a retained `verify.md` must exist before archive (incl. the two pre-apply spikes + a pi-TUI resume scenario). |
| Debug Mode | systematic-debugging | Resume mis-latch / divergence bugs are subtle; reproduce-before-fix (matches how the warm-resume stale bug was handled). |
| Review Status | requested | adversarial-review-cycle run (R1: 2 P0 + 7 P1; R2: 2 P0 + ~8 P1; R3: 1 P0 + 4 P1 — converging 9→10→5; all applied). Required by Governance for a principle amendment. The constitution bump is **MAJOR** (partial reversal of Principle I). |
| Delegation Mode | single-agent | |
| Worktree Mode | worktree-eligible | Isolates core `index.ts` turn-lifecycle edits from the live `main` branch during apply. |
| Spec Level | spec-anchored | |

## Worktree Base SHA

**Worktree Base SHA:** <empty until apply captures it>

## Manual Adjustments

- **Hard dependency / sequencing (Clarify C5, Risk R2):** the broader
  stale-result enforcement change SHOULD land first or together. This change
  implements only the per-resume guard (D5) — corrected in adversarial review to
  gate on `staleSuspected` (not `num_turns`) and requiring net-new plumbing of
  that signal onto `ClaudePDoneResult`. Standalone is permissible only once that
  guard is load-bearing. Owner decision required before apply.
- **No kill-switch (owner decision, Step 6):** the change ships with NO feature
  flag — "no conditional logic; we can always revert." Cold-start is the invariant
  floor (D4), so rollback is `git revert` + delete `~/.pi/agent/resume/`.
- **Two pre-apply spikes — both DONE 2026-06-06 (Analyze Check 7):**
  1. T0.1 (C4) — `claude --resume <missing>` **ERRORS, not silent-fresh** (exit 1 direct / exit 2 via claude-p) → fail-closed check is belt-and-suspenders.
  2. T0.2 (D6-limit) — **R7 CONFIRMED**: a dangling tool_use resumes cleanly through claude-p + suppression (`staleSuspected` does not misfire); the abort path self-closes the round anyway.
  Spike notes under `.spike-notes/claude-p-gate/c4-missing-transcript-*` and `d6-dangling-claudep-*`.
- **Adversarial review recommended:** given the Principle I amendment (D8) and
  the prior Scale-L lesson (end-to-end validation against the real OAuth-authed
  binary before marking implementation complete), consider setting Review Status
  = `requested` and running `adversarial-review-cycle` on proposal+specs+design
  before apply.
## Execution Notes

- **Owner decisions (Step 6 of adversarial-review-cycle, 2026-06-06):**
  1. **No kill-switch** — ship without a feature flag; rollback via `git revert` + delete `~/.pi/agent/resume/`.
  2. **Fail-closed transcript-existence check: keep committed** — the warm path always `stat`s the transcript before resuming (closes the silent-fresh hole); this is why the constitution amendment widens Principle III(b) + Enforcement + the CI audit.
  3. **Constitution bump: MAJOR** — partial reversal of Principle I (over the MINOR III(b)-exemption precedent).
- C5 sequencing (stale-result enforcement first/together vs. standalone) remains an owner decision at apply (task 0.3).
