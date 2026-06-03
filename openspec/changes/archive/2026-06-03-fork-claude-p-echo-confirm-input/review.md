# Review

Controlled-vocabulary mode switchboard. The apply instruction reads these modes
and dispatches behavior.

## Modes

| Mode | Value | Notes |
|---|---|---|
| Scale | S | Small fix: ~30 lines of Zig + a `RunError`, plus a dependency repoint and an identity check on the bridge side. One new capability + one small driver delta. Cross-repo, but bounded — not a refactor and not breaking. |
| Execution Mode | tdd-preferred | Bridge-side identity check + resolution are test-leadable; the Zig patch + PTY echo behavior can only be validated against the real binary, so not tdd-required. |
| Verification Mode | retained-recommended | S default. The reliability gate (G-echo) gives a durable check; a full retained AC↔test map is recommended, not forced. |
| Debug Mode | systematic-debugging | Acceptance is reproduction-based (re-run `stoptimeout-proof.mjs` under the bug load); the spike may surface a micro-behavior (clarify C3 clear-line). |
| Review Status | not-requested | S does not mandate adversarial review. Owner may still request a round given the cross-repo fork surface. |
| Delegation Mode | single-agent | Small enough for one agent; the fork patch and bridge integration are a handful of edits. |
| Worktree Mode | same-tree | Bridge work lands on `replan-driver-from-phase-0`. The fork is a separate clone at `~/git/claude-p` (per `forking-for-custom-patches`), not a bridge worktree. |
| Spec Level | spec-anchored | Both the bridge and upstream `claude-p` code already exist. |

## Worktree Base SHA

Worktree Mode = same-tree → N/A. Bridge file-contract diffs base on the branch HEAD
at apply start.

**Worktree Base SHA:** `ee002c6` (bridge branch HEAD at proposal time; apply re-captures)

## Manual Adjustments

- **Scale = S** (right-sized from an initial over-scoped L): the change is a ~30-line
  Zig patch + a dependency repoint + an identity check; the multi-platform CI/release
  pipeline that made it feel larger is split out as a follow-up.
- **Execution Mode = tdd-preferred**: integration is test-leadable; real-binary PTY
  behavior prevents tdd-required.
- **Debug Mode = systematic-debugging**: fix-to-a-diagnosed-defect with
  reproduction-based acceptance.

## Execution Notes

<!-- Transient observations appended during apply. -->

- Two-repo change: the patch + Zig build live in `~/git/claude-p` (default branch,
  `custom:` commit, `upstream` remote retained); the repoint + validation live on the
  bridge branch. Per-task contracts state which repo each task targets.
