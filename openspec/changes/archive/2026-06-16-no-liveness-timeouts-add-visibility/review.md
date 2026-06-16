# Review

Controlled-vocabulary mode switchboard for the
`no-liveness-timeouts-add-visibility` change. Apply reads these modes.

## Modes

| Mode | Value | Notes |
|---|---|---|
| Scale | M | Typical cross-file single-concern change; full M artifact graph + verify. BREAKING but stays within two capabilities, so M (not L). |
| Execution Mode | standard | No TDD mandate; tests added alongside removals + new visibility code. |
| Verification Mode | retained-recommended | verify.md authored post-apply (AC↔test map) but not a hard archive gate. |
| Debug Mode | standard | Not chasing a live regression; this is a deliberate breaking refactor. |
| Review Status | not-requested | Self-review only (Scale M < L → adversarial cycle not required). |
| Delegation Mode | single-agent | Single coherent edit surface; no subagent fan-out. |
| Worktree Mode | same-tree | Direct edits on a clean main working tree; owner pre-approved. |
| Spec Level | spec-anchored | OpenSpec's natural mode. |

## Worktree Base SHA

**Worktree Base SHA:** N/A (Worktree Mode = same-tree). Pre-apply HEAD =
`52eafc16aac38d1b72837ed22fdd387c34c56d43`.

## Manual Adjustments

- Scale = M (not default S): the change is BREAKING (removes public env knobs
  `CLAUDE_BRIDGE_WATCHDOG_IDLE_MS` + `CLAUDE_BRIDGE_CLAUDE_P_TIMEOUT_SECONDS` and
  the `killWedged` driver method) and spans two capabilities (claude-p-driver
  delta + new driver-diagnostics), warranting the full clarify→design→analyze
  gate. Not L: no constitution amendment, no new ADR-mandatory decision, single
  reviewer sufficient.
- Verification Mode = retained-recommended (not required): unit + integration
  validators are the binding gate; verify.md is a documentation aid.

## Execution Notes

- 2026-06-14 — Apply begins on same-tree clean main; baseline validators green
  (typecheck ✔, build ✔, unit 367/367) recorded before edits.
