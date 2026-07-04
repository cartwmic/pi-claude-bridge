# Code Review

**Change:** add-claude-peek-overlay
**Verdict:** fail
**review_mode:** adversarial-multimodel
**reviewer-provenance:** subagent(reviewer)@claude-bridge/claude-opus-4-8; subagent(reviewer)@openai-codex/gpt-5.5 (pi-subagents dispatch, blind, fresh context)
**Diff Base SHA:** bccd58ff83cb6578654ef17817ad52901f7b430d
**Reviewed Range:** bccd58ff83cb6578654ef17817ad52901f7b430d..9ad45ebeb2a90ace70391a5beb2254075471ab21
**Baseline:** intent.md + proposal + specs + design/plan + tasks status (+ fork commit 27376d0 in cartwmic/claude-p)
**Generated:** 2026-07-04

## Verdict contract (embed in every reviewer dispatch prompt)

A reviewer may FAIL this review ONLY for (a) a violation of the frozen
baseline — intent.md, delta ACs, design decisions, constitution/domain — or
(b) an objective correctness/security defect, even where the baseline is
silent. Taste, style, alternative-design preference, and beyond-scope demands
are advisory (P2/P3) and cannot gate.
Severity rubric — single lens, cite the violated baseline element:
P0 confirmed baseline violation or critical correctness/security defect ·
P1 must-fix gap within the contract · P2 should-fix advisory · P3 nit.
Verdict: pass ⇔ no open P0/P1.

## Round tracker

| Round | Mode | P0 | P1 | P2 | P3 | Reviewer verdicts | Reviewed HEAD |
|---|---|---|---|---|---|---|---|
| 1 | blind | 1 | 4 | 2 | 1 | opus-4-8:fail gpt-5.5:fail | 9ad45eb |
| 2 | blind | 0 | 2 | 0 | 2 | opus-4-8:pass gpt-5.5:fail | 5b923ba |

## Findings

<!-- Consolidated (max across reviewers; no cross-reviewer matching).
     Gate-manifest check: the diff ADDS openspec/opsx-gates.yaml (net-new,
     three required:true gates) — both reviewers explicitly confirmed it
     WEAKENS nothing. -->

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | (opus#1) Subagent spawns mirrored + retargeted the overlay; owner-less `setCurrentMirror(null)` idles the overlay mid-main-turn — violates `claude-peek-overlay.peek-follows-latest-main-turn-spawn-only` SHALL NOT + frozen intent "Main-turn spawns only" | P0 | fixed |
| 2 | (gpt#1) `CLAUDE_BRIDGE_PEEK_DIR` accepted verbatim — could direct mirror writes under `~/.claude/` (Constitution III) | P1 | fixed |
| 3 | (gpt#2) keep-last-N cleanup ran before lazy file creation → N+1 files retained (violates storage AC) | P1 | fixed |
| 4 | (gpt#3) resilience retry reuses the mirror path without republish; truncation left follower frozen at a stale offset (per-spawn naming / follows-latest AC) | P1 | fixed |
| 5 | (gpt#4) `ctx.ui.custom()` promise dropped with `void` — overlay failure became an unhandled rejection instead of an explicit peek error (failure-isolation AC) | P1 | fixed |
| 6 | (opus#2) Synchronous fs I/O (mkdir/readdir/stat/rm) on the spawn hot path — cannot throw, but blocking; same class as existing per-spawn debug I/O | P2 | deferred |
| 7 | (opus#3) Pin bump inherits 5 intermediate fork commits beyond the reviewed mirror commit (noted in review.md at pin time) | P2 | deferred |
| 8 | (opus#4) `buildOverlayLines` pads by UTF-16 code units — wide/combining glyphs mis-align the box border (cosmetic; fidelity is an explicit non-goal) | P3 | deferred |
| 9 | (r2 gpt#1 / opus r2#1) peek-dir guard was lexical-only — symlinked `CLAUDE_BRIDGE_PEEK_DIR` could land writes under `~/.claude/` (Constitution III) | P1 | fixed |
| 10 | (r2 gpt#2) synchronous `ctx.ui.custom()` throw escaped the command handler (failure-isolation AC as applied to overlay creation) | P1 | fixed |
| 11 | (r2 opus#2) post-dispose `markDirty` re-entry schedules a self-clearing no-op timer — keeps loop warm ≤ coalesceMs | P3 | deferred |

## Applied fixes

- `619350e` on `opsx/add-claude-peek-overlay` — round-2 P1s: symlink-resolving
  peek-dir guard (`physicalPath` realpaths the deepest existing ancestor;
  lexical + physical containment check, injectable home for tests) and
  containment of synchronous `ctx.ui.custom()` throws (log + toggle reset).
  2 new unit tests; 400/400 green; s31 9/9 PASS post-fix.
- `b9b80f0` on `opsx/add-claude-peek-overlay` — all P0/P1 findings:
  main-turn guard (`stack.length === 0` at the pre-push spawn site) +
  owner-guarded clear of the current mirror (#1); `resolvePeekDir` rejects
  overrides resolving under `~/.claude/` with fallback + warn (#2);
  cleanup trims to `KEEP_LAST_N - 1` pre-mint so the lazily-created file
  lands within the limit (#3); follower truncation detection (size < offset
  → reset + replay from byte 0) keeps the overlay live across resilience
  retries on the same path (#4 — implementation decision: retries reuse the
  attempt path and the follower replays on truncation, rather than minting a
  new path mid-resilience-wrapper); `ctx.ui.custom()` rejection handled with
  log + toggle reset (#5). 4 new unit tests; 398/398 unit green; scenario
  s31 9/9 PASS post-fix.

## Residual risks

- #6 (P2): sync fs on spawn path retained deliberately — bounded work
  (keep-5 dir), matches the existing per-spawn debug-file pattern; revisit
  if spawn latency ever regresses.
- #7 (P2): inherited fork commits were already on the fork's origin/main and
  previously validated there (see review.md Execution Notes at pin time).
- #8 (P3): code-unit padding accepted; attribute/wide-glyph fidelity is an
  explicit intent non-goal.

## Verdict rationale

Round 1 (blind, adversarial-multimodel: claude-opus-4-8 + gpt-5.5) found one
P0 and four P1 baseline violations; both reviewers independently verdicted
fail. All five were fixed in `b9b80f0`. Round 2 (blind, same models, full
diff at 5b923ba) found two new P1s (symlink bypass of the peek-dir guard;
sync `ctx.ui.custom()` throw) — fixed in `619350e`. Verdict remains **fail**
pending a quiet round; fixes landed since round 2 (progress signal present),
so per the quiet-round continuation rule the loop dispatches round 3 blind
re-review autonomously. Round-2 doneness rider (opus, designated judge)
judged the intent satisfied at 5b923ba, but the reviewed range moved with
the fixes — doneness will be re-sealed at the final HEAD. Both reviewers confirmed the gate-manifest
addition weakens nothing, Constitution III (no `~/.claude/` writes in the
shipped default), Constitution II (documented ExtensionUIContext only), and
the fork tee's write-only/absent-flag-identical properties.
