# Clarify Findings

Delta scope: the 6 ACs in this change's `specs/**` (2 modified claude-p-driver
requirements + 4 added driver-diagnostics requirements). Domain invariants read:
inv 1 (≤1 in-flight main turn), inv 2 (tool results only via pi). Constitution
III (no writes under `~/.claude/`) and VII (failures surface) consulted.

## Pass 1 — Ambiguity (semantic-entropy lite)

| # | AC ref | Question | Option A (keep) | Option B (change) | Status | Resolution |
|---|---|---|---|---|---|---|
| A1 | driver-diagnostics.premature-exit-error-surfaces-the-last-stderr-lines | "last N lines" — is N a fixed constant or configurable? | Fixed implementation-defined constant | Env-tunable knob | answered | A — fixed constant (default 20 lines). A new tuning knob contradicts the change's intent of *removing* liveness/visibility knobs; a sensible fixed cap keeps the error message bounded. |
| A2 | driver-diagnostics.child-stderr-is-captured-to-a-per-spawn-debug-file | "per-spawn" — one file per spawn attempt, or one per pi turn (shared across resilience retries)? | Per spawn ATTEMPT (each respawn gets its own file) | Per turn (appended across retries) | answered | A — one file per spawn attempt, keyed by sessionId+pid. A retry is a distinct process with distinct stderr; separate files keep RCA unambiguous and match the existing stale-diag per-pid convention. |
| A3 | driver-diagnostics.in-flight-state-dump-on-abnormal-termination | "age of last observed stream delta" — wall-clock ms since last delta, or absolute timestamp? | Both: last-delta epoch ms + derived age ms | Timestamp only | answered | A — log both the last-delta epoch and the derived age; age is the human-facing field, the epoch makes logs joinable. Solution detail, not behavior. |
| A4 | claude-p-driver.unexpected-driver-exit-surfaces-as-error | Does "no bridge-side liveness timer" forbid the *grace* SIGKILL timer inside `abort()`? | A) Only forbids wedge-GUESSING timers; the abort grace timer (SIGINT→SIGKILL) is allowed | B) Forbids all timers | answered | A — the abort grace window (`ABORT_SIGKILL_GRACE_MS`) is part of caller-driven teardown, not a liveness guess. Only the silence-based wedge timer is removed. |

## Pass 2 — Inconsistency (pairwise antecedent overlap)

| # | AC pair | Shared antecedent | Conflict on output | Option A (keep both) | Option B (resolve) | Status | Resolution |
|---|---|---|---|---|---|---|---|
| I1 | claude-p-driver.unexpected-driver-exit-surfaces-as-error × driver-diagnostics.premature-exit-error-surfaces-the-last-stderr-lines | Premature exit, no `result`, not aborted, no tool routed | The error AC says respawn (retry) and only surface error after retries; the stderr AC says include stderr in the error event | Both: stderr is appended to the error event THAT IS SURFACED (i.e. after retries exhausted, or when the gate is closed). Retries themselves do not surface an error event. | n/a | answered | A — no conflict once ordered: retries are silent-but-logged; the stderr tail is attached to the *surfaced* error event (post-retry-exhaustion or gate-closed). The stderr file is written every attempt regardless. |
| I2 | driver-diagnostics.in-flight-state-dump-on-abnormal-termination × claude-p-driver.prompt-injection-via-claude-p-input | Spawn aborts vs prompt-not-accepted exit | Could a single termination emit two state dumps? | One state dump per termination event | Emit exactly one state dump at the single terminal settle point | answered | B — emit the state dump once, at the driver's single `settle()`/abort site, so abort and premature-exit paths cannot double-log. |

## Pass 3 — Completeness (event/state combination enumeration)

Events declared: {spawn-exit-premature, spawn-exit-clean(`result`), abort, child-writes-stderr, argv-assembly}. States declared: {tool-round-held, no-tool-routed, debug-write-fails, debug-forwarding-disabled}.

| # | Combination | Question | Option A (intentional silence) | Option B (add new AC) | Status | Resolution |
|---|---|---|---|---|---|---|
| C1 | abort × tool-round-held | State dump while a tool is parked at abort | Covered: held-round flag = true is exactly the captured field | Add separate AC | answered | A — the existing in-flight-state-dump AC's "whether a tool round was held" field covers this; the abort+late-tool-result coherence is already governed by the unchanged claude-p-driver abort requirements. |
| C2 | clean-exit(`result`) × child-wrote-stderr | Should a *successful* turn still surface stderr to pi? | Intentional silence: stderr file is written, but NOT appended to any pi event on success | Add AC to surface stderr on success | answered | A — on a clean `result` there is no error event; stderr stays in the debug file only (constitution VII concerns failures, not nominal turns). The file capture AC already covers persistence. |
| C3 | debug-write-fails × spawn proceeds | What if the per-spawn debug file or `--debug-file` target is unwritable? | Covered by "stderr capture never crashes the turn" scenario | Add AC for --debug-file unwritable | answered | A — stderr capture degrades gracefully (logged, turn continues). `--debug-file` is forwarded to claude; if claude cannot write it, that is claude's failure surfaced via its own stderr (which we now capture) — no extra bridge AC needed. |
| C4 | argv-assembly × debug-forwarding-disabled | Env escape hatch unset vs set to non-canonical value | Treat any value except the documented "off" token as enabled (always-on default) | Strict parse | answered | A — mirror the existing `CLAUDE_BRIDGE_DEBUG !== "0"` convention: disabled only when the env var equals the documented off value; otherwise on. |

## Outstanding (status != answered)

- None. All findings answered.

## Summary

- Pass 1 findings: 4; unanswered: 0; deferred: 0
- Pass 2 findings: 2; unanswered: 0; deferred: 0
- Pass 3 findings: 4; unanswered: 0; deferred: 0
- **Gate status:** READY for design
