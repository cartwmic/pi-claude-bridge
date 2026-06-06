# Spike T0.1 — `claude --resume <missing-transcript-id>` behavior (Clarify C4 / Risk R1)

**Date:** 2026-06-06 · **Binary:** claude 2.1.159 (Claude Code) · **Mode:** `--print --model haiku`

## Question
Does `claude --resume <id>` for a session id that does not exist **hard-error**, or **silently start a fresh session** (which would produce a context-free live turn the post-spawn `staleSuspected` guard cannot catch, because the live turn *does* run)?

## Method (observed, not inferred)
- Empty cwd `/tmp/c4-spike-cwd` (no project dir).
- Guaranteed-missing UUID `4e9bad19-f64e-424d-9fd2-f6acb8a3cec6`.
- `claude --print --model haiku --resume <uuid> "Reply with exactly the token SPIKE_FRESH_OK"`.
- Captured exit code, stdout, stderr, and whether a project dir/transcript was created.

## Result — HARD ERROR
```
exit_code = 1
stdout    = (empty)
stderr    = No conversation found with session ID: 4e9bad19-f64e-424d-9fd2-f6acb8a3cec6
project dir after = (none created)
```
`claude` errors **before any API call** (no `SPIKE_FRESH_OK` was ever produced; no transcript dir was created). It does **NOT** silently start a fresh session.

## Conclusion → C4 resolved: errors, not silent-fresh
- The silent-fresh correctness hole (the original C4 worry) **does not exist** in 2.1.159. A missing `--resume` target is a clean error.
- Therefore the **fail-closed transcript-existence `stat` (R4b) is belt-and-suspenders, not the sole safety** — the `--resume`-error → cold-retry path already prevents a context-free warm turn. The owner chose to keep the existence check committed anyway (cheaper: avoids a spawn+error cycle; robust to future claude behavior changes). That decision stands; this spike just downgrades its *necessity*.
- **Risk R1 downgraded:** "`--resume` of a deleted/cleaned transcript starts silently fresh" is refuted for 2.1.159; the residual is only a future-version behavior change (which the version gate + the committed existence check both cover).

## Limit / follow-up
Tested via `claude --print` directly. The bridge's real path is `claude-p` (TUI). The "No conversation found" check is claude-core (not print-specific), so the TUI path is expected to error identically; a `claude-p --resume <missing>` confirmation is bundled into the T0.2 harness run.
