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
| 3 | blind | 0 | 1 | 2 | 2 | opus-4-8:pass gpt-5.5:fail | 871cf3d |
| 4 | blind | 0 | 2 | 0 | 3 | opus-4-8:pass gpt-5.5:fail | 5f034d7 |

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
| 12 | (r3 gpt#1) mirror-PREPARATION failure never reached the overlay error state — overlay stayed idle/stale during a live turn (explicit-idle-and-error-states AC) | P1 | fixed |
| 13 | (r3 opus#1) pre-existing load-sensitive flake in untouched tests (unit-driver-resilience timing; unit-mcp-shim under concurrent claude-p load) now gates via required `unit` | P2 | deferred |
| 14 | (r3 gpt#2) s31 asserts clean completion via bridge log but not byte-level NDJSON with/without-mirror comparison | P2 | deferred |
| 15 | (r3 opus#3) overlay width 60% exceeds the 122-col cap guidance on very wide terminals — blank-pads, never resizes session | P3 | deferred |
| 16 | (r4 gpt#1) tmpdir() FALLBACK unguarded — TMPDIR under ~/.claude made even the default peek dir violate Constitution III | P1 | fixed |
| 17 | (r4 gpt#2) resilience retries reused the first attempt's mirror path — per-spawn naming + latest-spawn retarget not honored across retries | P1 | fixed |
| 18 | (r4 opus#2) no overlay max-height clamp; relies on pi-tui clipping on short terminals | P3 | deferred |
| 19 | (r4 opus#3) turn-end idle guard's undefined-mirror branch assumes sequential main turns | P3 | deferred |

## Applied fixes

- `d927826` on `opsx/add-claude-peek-overlay` — round-4 P1s: fallback peek dir
  guarded (TMPDIR under ~/.claude escalates to ~/.cache/claude-bridge-peek);
  per-spawn mirror re-mint across resilience retries via
  ResiliencePolicy.remintMirrorFile + latest-path-aware turn-end owner check.
  3 new unit tests; 405/405 green; s31 9/9 PASS post-fix.
- `6c12278` on `opsx/add-claude-peek-overlay` — round-3 P1: mirror-preparation
  failure now publishes an explicit mirror-error (publishMirrorError /
  hasCurrentMirrorError) routed to the overlay's forceError() state;
  main-turn-guarded turn-end clear returns the overlay to idle. 3 new unit
  tests; peek suites green; s31 9/9 PASS post-fix.
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
- #13 (P2): load-sensitive flakes live in files untouched by this diff
  (pre-base); tracked as follow-up hardening of test timeouts, not a defect
  of this change.
- #14 (P2): byte-level NDJSON comparison is already covered at the unit tier
  by the fork's Zig tee tests + the argv both-ways tests; s31 asserts the
  end-to-end completion signal. Accepted.
- #15 (P3): blank-padding on >200-col terminals accepted; session never
  resized (the AC's binding requirement).

## Verdict rationale

Round 1 (blind, adversarial-multimodel: claude-opus-4-8 + gpt-5.5) found one
P0 and four P1 baseline violations; both reviewers independently verdicted
fail. All five were fixed in `b9b80f0`. Round 2 (blind, same models, full
diff at 5b923ba) found two new P1s (symlink bypass of the peek-dir guard;
sync `ctx.ui.custom()` throw) — fixed in `619350e`. Verdict remains **fail**
pending a quiet round; fixes landed since round 2 (progress signal present),
so per the quiet-round continuation rule the loop dispatched round 3, which
found 1 P1 (fixed in `6c12278`), and round 4 at 5f034d7, which found 2 P1s
(fixed in `d927826`). Open-P0+P1 trajectory: 5 → 2 → 1 → 2-then-fixed; every
round's findings were landed change-scoped before the next dispatch
(progress signal present each round). Round 5 is the review_max_rounds hard
cap: if it is not quiet, the loop lands for disclosure/decision-audit per
the budget rule. Doneness riders (opus, designated judge) ruled satisfied at
5b923ba, 871cf3d, and 5f034d7; doneness re-seals at the final HEAD. Both reviewers confirmed the gate-manifest
addition weakens nothing, Constitution III (no `~/.claude/` writes in the
shipped default), Constitution II (documented ExtensionUIContext only), and
the fork tee's write-only/absent-flag-identical properties.
