# Round Tracker

| Round | P0 | P1 | P2 | P3 | Approvals (out of 2) | P0+P1 | Outcome |
|---|---|---|---|---|---|---|---|
| 1 | 4 | 7 | 5 | 3 | 0/2 | 11 | needs revision; 17 auto-applied, 1 false positive, 5 scope-deferred |
| 2 | 0 | 7 | 5 | 5 | 0/2 | 7  | needs revision; 19 auto-applied, 3 scope-deferred |
| 3 | 0 | 6 | 7 | 3 | 0/2 | 6  | needs revision; major D18 simplification (--session-id); 10 auto-applied, 5 scope-deferred |
| 4 | 1 | 5 | 6 | 1 | 0/2 | 6  | needs revision; constitution III amended (v1.1.0) + D19/D20/D21/D22 added; 12 auto-applied, 2 scope-deferred; **first flat round** |
| 5 | 0 | 6 | 7+ | 3 | 0/2 | 6  | needs revision; **TREADMILL TRIGGERED** (R3=6, R4=6, R5=6 — flat for 2 consecutive rounds); 7 auto-applied (--system-prompt-file fallback, D23 main-path systemPrompt fix, D24 warm-resume baseline, capture-spec IPC-stash alignment, plan.md deterministic-introspection sync, T0.14 liveness gate, hook quoting) |

**Stop conditions** (from adversarial-review-cycle skill):
- P0+P1 = 0 for this round → blockers resolved, move to Step 6
- **P0+P1 flat or rising for 2 consecutive rounds → treadmill, move to Step 6**
- Both reviewers approve → move to Step 6

**Trajectory analysis:** P0+P1 11 → 7 → 6 → 6 (1st flat). Round 5 dispatching. If Round 5 produces P0+P1 ≥ 6, **treadmill condition triggers** and the loop ends.

**Round 4 was meaningful even though flat:** the convergent P0 (constitution III conflict with D18) was definitively resolved via an in-change constitutional amendment ratified by THIS adversarial-review-cycle. Three other P1s closed with new design decisions D19/D20/D21/D22. Round 5 is the convergence test.
