---
scale: M
full_rigor: false
# worktree_mode: (derived when absent: M ⇒ worktree-required)
execution_mode: standard
verification_mode: retained-recommended
debug_mode: standard
review_status: not-requested
delegation_mode: subagent-eligible
# code_review_mode: (derived when absent: M ⇒ gating-required)
loop_max_iterations: 40
validation_source_mode: required
spec_level: spec-anchored
doneness_mode: required
loop_hold: true
loop_hold_reason: "decision audit in code-review.md — review_max_rounds hard cap (5) reached with round-5 P1 fixed post-round; all P0/P1 from all rounds fixed and landed; awaiting human ruling: extend rounds / waive re-review of the round-5 fix / inspect"
---

# Review

## Modes

| Mode | Value | Notes |
|---|---|---|
| Scale | M | Cross-repo feature (claude-p fork + bridge extension), single capability, new npm dep — typical M per schema heuristics; no cross-capability/breaking/migration traits that would demand full_rigor |
| full_rigor | false | No ADR-worthy decisions, no breaking change, no migration |
| Execution Mode | standard | |
| Verification Mode | retained-recommended | |
| Debug Mode | standard | |
| Review Status | not-requested | |
| Delegation Mode | subagent-eligible | Blind review/doneness dispatches per openspec-loop |
| Worktree Mode | derived (absent) | M ⇒ worktree-required |
| Code Review Mode | derived (absent) | M ⇒ gating-required |
| Loop Max Iterations | 40 | M authoring-time default |
| Validation Source Mode | required | tsc + unit tests + e2e tmux scenario (intent.md validation constraint) |
| Doneness Mode | required | |
| Spec Level | spec-anchored | |
| Model Config | (unset) | session model |

## Diff Base + Worktree locator

**Diff Base SHA:** bccd58ff83cb6578654ef17817ad52901f7b430d
**Worktree Path:** /Volumes/Workshop/git/pi-claude-bridge-wt-add-claude-peek-overlay
**Integration Branch:** main

## Manual Adjustments

- Scale M chosen per the explore session's recommendation (frozen in
  intent.md context; spike record `.spike-notes/claude-peek/CONCLUSION.md`):
  cross-repo but single-capability, no full_rigor traits.
- Delegation Mode subagent-eligible (template default single-agent): the
  openspec-loop drive requires blind subagent dispatch for gating reviews.
- review_models unresolved at dispatch time (`opsx models get review` → unset):
  loop selected claude-bridge/claude-opus-4-8 + openai-codex/gpt-5.5 (two
  distinct strong models across providers, both verified in `pi
  --list-models`) for the adversarial-multimodel rounds.

## Execution Notes

- 2026-07-04 — review.md authored by the loop (gate: review.md absent).
- 2026-07-04 — apply: worktree created (branch opsx/add-claude-peek-overlay); Diff Base = pre-apply main HEAD bccd58f.
- 2026-07-04 — fork pin bump will move b24e3827 → new fork HEAD, inheriting intermediate fork commits already on origin/main (paste-collapse archive, transcript API-error recovery 18c6185) — all previously validated on the fork's main.
- 2026-07-04 — code-review round 5 (blind, full diff at 13a3e34, HARD CAP): opus pass (2 P2 + 3 P3; doneness satisfied — 4th consecutive) / gpt fail (1 P1: fork accepted empty --mirror-file; plan step 1 requires rejection) — fixed in fork 12f3672 + pin bump fcd58b6. Budget exhausted → loop LANDED (loop_hold set); decision audit in code-review.md.
- 2026-07-04 — code-review round 4 (blind, full diff at 5f034d7): opus pass (3 P3; doneness satisfied) / gpt fail (2 P1: unguarded tmpdir fallback under ~/.claude; retry mirror-path reuse) — both fixed on worktree d927826. Round 5 = hard cap; not-quiet ⇒ disclosure/landing.
- 2026-07-04 — code-review round 3 (blind, full diff at 871cf3d): opus pass (1 P2 + 2 P3; doneness rider satisfied) / gpt fail (1 P1: mirror-prep failure invisible to overlay; 1 P2) — P1 fixed on worktree 6c12278. Trajectory 5→2→1 P0+P1. Round 4 due (converging; budget 3/5 used).
- 2026-07-04 — note: two dispatch results were lost to needs-attention turn interrupts before landing; round 3 re-dispatched with durable /tmp output files + control disabled. unit-mcp-shim flake under 4-concurrent-claude-p machine load recorded (finding #13, untouched file).
- 2026-07-04 — code-review round 2 (blind, full diff at 5b923ba): opus pass (2 P3) / gpt fail (2 P1: symlink peek-dir bypass, sync custom() throw) — both P1s fixed on worktree 619350e; doneness rider judged satisfied but will re-seal at final HEAD. Round 3 due (converging).
- 2026-07-04 — code-review round 1 (blind, opus-4-8 + gpt-5.5) verdict fail: 1 P0 + 4 P1 — all fixed on worktree b9b80f0 (main-turn guard, ~/.claude env rejection, keep-N pre-mint trim, truncation replay, custom() rejection handling); 3 advisory deferred. Round 2 due.
- 2026-07-04 — T4.3+T5.1 done on worktree (6cb7acb): openspec/opsx-gates.yaml (typecheck/unit/s31, all required) + README /claude-peek section + CHANGELOG. All 11 tasks complete.
- 2026-07-04 — T4.1+T4.2 done on worktree (1a09565): scenario s31 9/9 PASS ×2; T4.1 audit — all listed unit tests landed with T2.2/T3.1/T3.2 (26 peek tests citing ACs). Scenario caught a real defect: claude-p lazy mirror creation vs retarget-at-spawn ENOENT error-latch; fixed with a pre-first-byte grace window (10s default) in MirrorFollower; 395/395 green.
- 2026-07-04 — T3.2 done on worktree (bf6ac4b): /claude-peek command + overlay (nonCapturing, top-right, 60%, requestRender on frames/states, retarget subscription, dispose cleanup); buildOverlayLines pure + tested; handler signature (args, ctx) asserted by test. 394/394 green.
- 2026-07-04 — T3.1 done on worktree (ec864fd): PeekScreen (@xterm/headless 120x40) + MirrorFollower (poll tail, replay-from-0 retarget, idle|live|error, 50ms coalescing, failure latch). Spike capture committed as tests/fixtures/peek-full-turn.raw; 387/387 green.
- 2026-07-04 — T2.2 done on worktree (de387c6): src/peek/mirror.ts (peek dir <tmpdir>/claude-bridge-peek or CLAUDE_BRIDGE_PEEK_DIR; keep-last-5; current-mirror retarget hook); main-provider spawn wires prepareMirrorForSpawn, turn end publishes null (idle). 378/378 green.
- 2026-07-04 — T2.1 done on worktree (cc70512): ClaudePSpawnConfig.mirrorFile + argv emission both-ways unit tests; 369/369 green.
- 2026-07-04 — T1.2+T2.3 done on worktree (8bb754d): pin → 27376d0, @xterm/headless ^5.5.0 added; installed claude-p --help lists --mirror-file; 367/367 unit tests + typecheck green. T2.3 batched with T1.2 (same package.json/lock contract).
- 2026-07-04 — T1.1 done: fork commit 27376d0 (`custom: add --mirror-file write-only PTY output mirror`) pushed to cartwmic/claude-p main. zig build test green; live smoke stdout byte-identical with/without flag (41*17=697 both), mirror file captured session.

## Scope Expansions

- 2026-07-04 — hardened two pre-existing load-flaky timing tests
  (tests/unit-mcp-shim.mjs fixed 400ms window → 15s signal poll;
  tests/unit-driver-resilience.mjs backoff/4 sleep → spawn-signal poll +
  immediate abort; assertions unchanged in both) — evidence: the change's
  required `unit` validation gate (opsx-gates.yaml, mandated by the frozen
  intent's validation constraint) failed non-deterministically at machine
  load avg 15-19 (4 concurrent claude-p sessions); code-review r3 finding
  #13 documents the class. Worktree commit 9546901.
