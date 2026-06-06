# Execution Plan

<!--
tasks.md is COARSE (task IDs + contracts). This is the fine-grained driver
openspec-apply-change executes. Execution Mode = tdd-preferred → unit-testable
steps use the 5-step micro-task loop; spike/doc/integration steps use an ordered
list. Debug Mode = systematic-debugging → resume-latch steps carry an Observed
Failure + Debugging Trail (the RED test is the observed failure for greenfield
steps; the latch guard carries the real prior bug).
AC IDs are canonical: `<capability>.<requirement-slug>`.
-->

## Plan step 0: Pre-apply gates — spikes + sequencing decision

- **Covers:** T0.1 (spike C4), T0.2 (spike D6-limit), T0.3 (land fork resume-staleness gate + repin)
- **Pre-conditions:**
  - On `main`, working tree clean except this change dir.
  - `claude` + `claude-p` on PATH; OAuth-authed binary available (spikes hit the real binary).
  - `.spike-notes/claude-p-gate/` writable.
- **Action (ordered — NOT TDD; these unblock the rest):**
  1. **C4 spike — DONE 2026-06-06:** ran `claude --resume <missing-id>` directly AND through `claude-p`. Result: **ERRORS, not silent-fresh** (direct exit 1 "No conversation found"; via claude-p exit 2 `SessionStartTimeout`). Notes: `.spike-notes/claude-p-gate/c4-missing-transcript-claude-2.1.159-2026-06-06T19-17-24Z/`.
  2. **C4 decision — DONE:** silent-fresh is refuted, so the error→cold guard already suffices; the fail-closed existence check was **DROPPED** (owner: no defense-in-depth complexity), which also removed the Principle III(b)/Enforcement/CI-audit amendment + the OS-cwd encoding work.
  3. **D6-limit spike — DONE 2026-06-06:** crafted a genuinely-dangling tool_use transcript and resumed it through the **full `claude-p` + `suppressResumeReplay` path**: exit 0, terminal result, live prompt answered, `staleSuspected:false` (no misfire). **R7 CONFIRMED, not inverted.** Bonus: the bridge's abort/kill path self-closes the round (claude writes an `is_error` tool_result on MCP disconnect), so dangling only arises from a crash mid-write. Notes: `.spike-notes/claude-p-gate/d6-dangling-claudep-claude-haiku-4-5-2026-06-06T19-21-34Z/` (+ harness `d6-dangling-*.mjs`).
  4. **Fork resume-staleness gate (D5) — SPIKED 2026-06-06; land it:** the source-level transcript-growth gate (state-gate `.stop` + require `num_turns > baseline` before emitting) is proven on fork branch `spike/resume-staleness-gate` (`zig build test` green incl. a deterministic unit test; under-load e2e → 0 stale emits). Merge to claude-p `main`, build, bump the bridge pin. This DISSOLVES the old Thread-B dependency and the C5 sequencing question. Notes: `.spike-notes/claude-p-gate/resume-staleness-gate-claude-haiku-4-5-2026-06-06T22-02-26Z/`.
- **Verification:**
  - Three spike-note dirs with CONCLUSION.md (C4, D6, resume-staleness-gate) — all DONE. The only remaining Step-0 work is landing the fork gate on claude-p `main` + repin (0.3).
- **Rollback:** none (read-only experiments + a doc line). Delete spike-note dirs if abandoning.
- **Observed Failure (the bug this gate de-risks):**
  - Verbatim (from the named dependency / warm-resume stale-result bug): a `--resume` spawn replays prior terminal state and returns the *previous* turn's answer because the live turn never ran — a replay boundary was seen with no live prompt after it (`sawReplayBoundary && !livePromptAfterBoundary` → `staleSuspected`).
- **Debugging Trail:**
  - D6 (claude direct) ruled out "dangling = hard blocker." T0.2 (DONE) extended this through claude-p's suppression path: still clean, and `staleSuspected` correctly stayed false (live prompt ran after the replay boundary).
  - T0.1 (DONE): `claude --resume <missing>` errors, so no code relies on resuming an absent transcript silently.

## Plan step 1: Amend Constitution (Principle I) and Domain invariant 3 (D8)

- **Covers:** T1.1 (constitution — Principle I only), T1.2 (domain)
- **Pre-conditions:** Step 0 complete (the amendment text references the spike outcomes); `openspec/constitution.md` + `openspec/domain.md` present.
- **Action (ordered — doc edits, not feature TDD):**
  1. **Principle I** — permit a **content-free** resume-metadata sidecar (fingerprints + ids + version; never message content, no counters; the fingerprint chain is a one-way digest) stored **outside `~/.claude/`**. (Principle III is UNCHANGED — the existence `stat` was dropped, so the warm path adds no new `~/.claude` access; no III(b)/Enforcement/CI-audit edits.)
  2. **Domain invariant 3** (`domain.md:40-43`) — remove `restart` from the unconditional cold-start list; replace with "restart **without a validated resume sidecar** → cold-start." Bump domain.md version. (Round-2 P0: today's text contradicts the change.)
  3. Bump constitution version — **MAJOR** (partial reversal of Principle I per the Versioning rule); pin the exact version + changelog lines.
  4. Commits: `docs(constitution): permit content-free resume sidecar (Principle I, MAJOR)`, `docs(domain): invariant 3 — validated warm resume on restart`.
- **Verification:**
  - `openspec validate --strict` (constitution + domain parse; versions bumped).
  - Manual: Principle I scopes to fingerprints only (no language admitting message content); Principle III untouched; invariant 3 no longer asserts unconditional restart→cold.
- **Rollback:** `git revert` the doc commits; restore prior Principle I + invariant 3 text + versions.

## Plan step 2: Resume-store module (D1, D3) — TDD

- **Covers:** T2.1 (failing tests), T2.2 (store impl), T2.3 (prune-on-read)
- **Pre-conditions:** Step 1 merged (the amendment authorizes this persistent state); `tests/` runner green at HEAD.
- **Action (5-step micro-tasks):**
  1. **Write failing tests** `tests/unit-resume-store.mjs` citing:
     - `warm-pi-resume.resume-sidecar-persisted-on-successful-turn` — write/read round-trip returns the same `{ claudeSessionId, piSessionId, historyHashChain, claudeVersion }` (NO `lastNumTurns`, NO `spawnCwd` — the stale guard is self-contained `staleSuspected` and the dropped existence check was spawnCwd's only consumer).
     - `warm-pi-resume.sidecar-stores-no-conversation-content` — serialized sidecar contains no message bodies / tool args / tool results (assert against a fixture with content-bearing inputs that the store must drop).
     - `warm-pi-resume.warm-path-performs-no-new-claude-config-access` — resolved path is under `~/.pi/agent/`, never under `~/.claude/`.
     - key derivation: the **literal** `frame.cwd` (NOT realpath) — assert a symlink-alias path and its real target map to DISTINCT keys (C1: `claude` fragments transcripts by literal cwd, and `--resume` can't cross `-Users-cartwmic-git-…` vs `-Volumes-Workshop-git-…`, so warm-resume MUST miss across the alias); the **FULL** `sessionId` — assert two ids sharing an 8-char prefix get DISTINCT keys (C3b; the existing `getPiSessionId()` truncates to 8); corrupt/torn file → `null`; atomic write survives concurrent read; prune-on-read drops over-TTL/over-cap files (T2.3).
  2. **Run** `npm run test:unit -- unit-resume-store.mjs` → **expect FAIL** (module absent).
  3. **Minimal impl** `src/resume-store.ts`: `readSidecar(cwd, sessionId)`, `writeSidecar(...)`, `invalidate(...)` over `~/.pi/agent/resume/<key>.json`; key = literal `frame.cwd` + full `sessionId`; atomic writes (temp+rename); prune-on-read; the writer accepts only the typed fingerprint schema (no content field exists to leak).
  4. **Run** the test → **expect PASS**.
  5. **Commit:** `feat(resume-store): content-free sidecar keyed by literal cwd + full sessionId`.
- **Verification:** `npm run typecheck` + `npm run test:unit` green; new file is `src/resume-store.ts` only.
- **Rollback:** delete `src/resume-store.ts` + `tests/unit-resume-store.mjs`; `git revert` the commit. No runtime wiring yet → zero blast radius.
- **Observed Failure (greenfield):** RED from step 2 — `Cannot find module '../src/resume-store.ts'` / assertion failures on round-trip + content-free + alias-distinctness + prefix-distinctness.
- **Debugging Trail:** the symlink finding (two transcript dirs) was MIS-resolved in Round 1 (key on realpath); Round 2 corrected it — `claude` keys by literal cwd and `--resume` can't cross it, so keying on literal cwd is correct and removes the net-new realpath work. Full-id keying corrects the C3 collision gap. Both carried into test 1.

## Plan step 3: Pre-spawn validation gate (D2, D4) — TDD

- **Covers:** T3.1 (gate tests), T3.2 (gate impl). NO stale-signal plumbing — staleness is fixed in the fork (step 0.3 / D5), so the bridge has no `staleSuspected` input.
- **Pre-conditions:** Step 2 merged; `detectHistoryDivergence` available to reuse (parameterized by the digest fn — the gate prefix-compares the **`sha256`** chain recomputed over pi's loaded history against the sidecar's persisted `sha256` chain; the in-process `hashMessage` baseline is recomputed separately and locally, R6).
- **Action (5-step micro-tasks):**
  1. **Write failing tests** `tests/unit-warm-resume-gate.mjs` citing:
       - `warm-pi-resume.validated-warm-resume-on-pi-resume` — `sha256` prefix-extension match + version match → `{ warm: true }`.
       - `warm-pi-resume.cold-start-when-validation-does-not-pass` — no sidecar / divergence / version-skew → `{ warm: false, reason }` (normal cold).
       - `warm-pi-resume.cold-start-on-unreadable-or-malformed-sidecar` — corrupt/torn sidecar → `{ warm: false, reason }`.
       - `warm-pi-resume.aborted-mid-tool-sessions-remain-resumable` — a sidecar whose recorded transcript ended mid-tool still validates `{ warm: true }` (dangling tool call is NOT a gate trigger, D6 — **confirmed by T0.2**).
  2. **Run** the unit tests → **expect FAIL** (gate absent).
  3. **Minimal impl** — pure gate helper consumed by the bridge: inputs = sidecar + pi history hashes + current `claude` version; output = `{ warm, reason }`. No staleness logic (the fork guarantees a live result). No real `claude-p` in the seam.
  4. **Run** the tests → **expect PASS**.
  5. **Commit:** `feat(warm-resume): pure pre-spawn validation gate (prefix + version)`.
- **Verification:** `npm run typecheck` + `npm run test:unit` green; gate is a pure function (no I/O, no spawn) → deterministic.
- **Rollback:** `git revert` the commit; the gate is unreferenced by the turn loop until step 4 → safe.
- **Observed Failure:** RED from step 2 — gate helper absent / assertions on warm-vs-cold decisions fail.
- **Debugging Trail:** simplified after the source-level spike — the stale-result race is fixed in the `claude-p` fork (transcript-growth gate, step 0.3/D5), so the bridge no longer needs to detect/plumb `staleSuspected`. This gate is now purely the pre-spawn warm/cold decision (history prefix + version).

## Plan step 4: Bridge wiring (D1, D2, D4, D5, D6, D7) — integration

- **Covers:** T4.1 (persist+invalidate), T4.2 (warm path on resume), T4.3 (confirm NO bridge stale guard — fork handles it)
- **Pre-conditions:** Steps 2–3 merged (store + gate exist and are green).
- **Action (ordered; each sub-step is a single commit — wiring is integration-shaped, covered end-to-end in step 5, with unit seams reused from 2–3):**
  1. **T4.1 — persist on success / invalidate on error:** in `finalizeClaudePFrame` (`index.ts:1371`), on a non-error finalize call `writeSidecar(...)` **wrapped in a NEW `top() === frame` check** (the cache-set `else if (res.sessionId)` branch at `index.ts:1402` is itself UNguarded — it runs for every frame; the `top()===frame` block at `1429` is separate, so add the guard around the new call, never persist a subagent frame), beside the `.ready`-sentinel cleanup at `index.ts:1378`; on a turn error call `invalidate(...)` **unconditionally by key** (the in-memory clear at `index.ts:1397` is session-id-guarded, but the sidecar must drop regardless; error branch `index.ts:1388` already covers `McpNotReady`). Satisfies `warm-pi-resume.resume-sidecar-persisted-on-successful-turn` + `warm-pi-resume.sidecar-invalidated-on-turn-error`. Commit: `feat(bridge): persist/invalidate resume sidecar on turn finalize`.
  2. **T4.2 — validated warm path at the first post-resume turn:** the `session_start:resume` handler (`index.ts:1698-1704`) keeps its frame-drain + cache-clear side-effects and sets a one-shot "warm-resume pending" flag (NO keyed read — it has no cwd). At the first turn in `startFreshQuery` (where literal `frame.cwd` exists) with that flag + empty cache: `readSidecar(frame.cwd, fullSessionId)` → gate (`sha256` prefix-match over pi's loaded history + version match) → on pass set `cachedSessionId`/`cachedSessionCwd` and set the in-memory baseline by recomputing `computeMessageHashes(context.messages)` **locally** (R6 — NOT from the sidecar's sha256 chain) so `useResume` (`index.ts:1495`) takes the warm branch; on fail cold-start (`warm-pi-resume.cold-start-when-validation-does-not-pass` + `…cold-start-on-unreadable-or-malformed-sidecar`). A deleted transcript surfaces as a `--resume` error → cold via D7 (T0.1; no existence pre-check). Satisfies `…divergence-baseline-rehydrated-on-warm-resume` (R6) + `claude-p-driver.cached-driver-session-is-a-hint-only`. Commit: `feat(bridge): validated warm-resume at first post-resume turn; cold fallback`.
  3. **T4.3 — NO bridge stale guard:** the fork's transcript-growth gate (step 0.3 / D5) guarantees a live `--resume` result, so the bridge adds no staleness logic. It treats a driver `result` as authoritative and a driver error (the gate's refusal) as an ordinary turn error — surfaces (Principle VII) + invalidates the sidecar (D7) → next turn cold-starts; no in-turn cold-retry. Satisfies `warm-pi-resume.driver-guarantees-a-live-resume-result`. (No commit — this is the absence of code; verified by review + the step-5 no-stale-under-load scenario.)
- **Verification:**
  - `npm run typecheck` + `npm run build` + `npm run test:unit` green after each sub-step.
  - Existing turn-lifecycle unit tests (driver-error, watchdog, killwedged) still pass → no regression in the cold path.
  - With the sidecar removed/cleared, a resume reproduces today's cold-start log shape (feeds step 5's RED check).
- **Rollback:** no runtime toggle (owner: no kill-switch) — `git revert` the three commits for a code rollback; delete `~/.pi/agent/resume/` to drop persisted state. Cold-start is the invariant floor, so a revert is always safe.
- **Observed Failure (the latch this step must not reintroduce):**
  - Verbatim: warm `--resume` returns the prior turn's answer (stale replay) — now prevented at the SOURCE by the fork transcript-growth gate (step 0.3/D5), asserted live in step 5's no-stale-under-load scenario.
- **Debugging Trail:** cold-start is the invariant floor (D4): every failure path here must land on the existing `buildColdStartPrompt` route, which is already proven. The wiring adds *only* a validated short-circuit in front of it — so a wiring bug degrades to cold, never to wrong-answer; staleness is impossible because the fork never emits a stale result.

## Plan step 5: End-to-end validation + verify

- **Covers:** T5.1 (pi-TUI resume scenarios), T5.2 (full green build), T5.3 (`verify.md`)
- **Pre-conditions:** Step 4 merged; pi-TUI scenario harness (`scripts/scenario-lib.sh`) available; clone repinned to the built bridge (warm path requires a pi restart to load).
- **Action (ordered):**
  1. **T5.1 positive scenario** `scripts/run-scenario-s30-warm-resume.sh`: multi-turn session → restart/resume pi → assert first post-resume turn is **WARM** — bridge log shows `resume=<id>` (not a cold full-history re-pack) — **and** a coherence probe: the model answers a question that requires context from a pre-restart turn (paired positive + negative regex per the harness rule). Pin to opus in `scenario-overrides.conf`.
  2. **T5.1 negative scenario** `scripts/run-scenario-s31-compact-forces-cold.sh`: `/compact` between sessions → assert first post-resume turn is **COLD** (divergence → fallback), proving the gate rejects a diverged chain.
  3. **T5.1 no-stale + abort + subagent scenarios** `s32` (no-stale-under-load — several `--resume` turns with unique tokens under CPU load, every one returns its OWN live answer; the fork gate; adapt `resume-staleness-gate-e2e.mjs`), `s33` (aborted-mid-tool prior turn then warm-resumes cleanly, R7), and `s34` (a prior turn that ran a subagent then resumes to the MAIN session — subagent-no-sidecar guard).
  4. **T5.2:** `npm run typecheck` && `npm run build` && `npm run test:unit` green; ALSO run `tests/int-cache.sh` + `tests/int-session-resume.mjs` + `tests/int-claude-dir-audit.mjs` (lifecycle + Constitution-III regression); run s30–s34.
  5. **T5.3:** author `verify.md` (Verification Mode = retained-required): record the spike outcomes (T0.1 missing-resume errors, T0.2 R7 confirmed, the source-level resume-staleness gate — zig tests + under-load e2e), the fork-land + repin (T0.3), unit results, and all scenario results; Completion Decision RED→GREEN.
  6. **Commit:** `test(bridge): warm-resume pi-TUI scenarios (warm/cold/stale/abort)` and `docs(openspec): verify.md for enable-warm-pi-resume`.
- **Verification:**
  - s30 = WARM + coherence pass; s31 = COLD; s32 = no-stale-under-load (all live answers); s33 = abort→warm (R7). All green.
  - `openspec validate --strict` passes with `verify.md` present.
- **Rollback:** scenarios are additive; `git revert` the test/doc commits. Runtime rollback = `git revert` + delete `~/.pi/agent/resume/` (no kill-switch).
- **Observed Failure:** s30 must fail RED first if the sidecar is removed (forcing cold) — confirming the scenario actually probes the warm code, not a false pass on cold.
- **Debugging Trail:** the harness's negative-regex rule guards the classic false-pass ("I don't recall X" satisfying a positive check for X); the sidecar-removed RED check guards the other false-pass (scenario green without exercising warm).

## Completion Verification

- `openspec validate --strict enable-warm-pi-resume` → valid.
- `npm run typecheck && npm run build && npm run test:unit` → all existing unit tests green (no count regression); new resume-store + pre-spawn-gate tests pass.
- The `claude-p` fork gate (D5): `zig build test` green + the under-load e2e (0 stale emits) — landed on claude-p `main` + repinned (0.3).
- `scripts/run-scenario-s30..s34` → WARM+coherence / COLD / no-stale-under-load / abort→warm / subagent-no-sidecar, all PASS.
- With the sidecar removed, a resume cold-starts (the s30 RED check) — and `git revert` restores today's behavior (rollback proven; no kill-switch).

## Manual Adjustments

- **Step 0 precedes all code.** All three spikes are DONE (2026-06-06): C4/T0.1 — `claude --resume <missing>` errors, not silent-fresh (so the fail-closed existence check was DROPPED — no III(b) amendment); D6/T0.2 — R7 CONFIRMED; **source-level resume-staleness gate** — proven in the fork (zig tests + under-load e2e). The only Step-0 work left is landing the fork gate + repin (0.3); no owner sequencing decision remains.
- **Steps 2–3 are strict TDD** (tdd-preferred + cleanly unit-testable pure logic); **steps 1, 4, 5 are ordered lists** — doc edit (1), integration wiring proven end-to-end in step 5 (4), and the scenario/verify pass itself (5). This matches review.md: "Resume end-to-end is spike/integration-gated."
- **Debug Mode = systematic-debugging** → every code step carries Observed Failure + Debugging Trail; for greenfield steps the RED test is the observed failure. The stale-result latch is now fixed at the source (fork) and proven by the spike, so there is no bridge-side latch step.
- **Scale = L** (set in review.md, mandated by the constitution's Governance clause for a Principle-I amendment): mandates ADR promotion of D1/D2/D5/D8 at archive and the adversarial-review-cycle (run). This plan reflects three adversarial rounds + the spike outcomes: R1 (discriminator; subagent-frame persist gated; full-sessionId; sidecar-invalidation AC; pruning; Scale M→L), R2 (literal-cwd keying — no realpath; Domain invariant 3 amendment; R4 EARS split; atomic writes), R3 (opaque `sha256` digest; turn-start keyed validation; `--resume`-error fallback granularity). **Post-spike (T0.1/T0.2 + source-level spike):** the fail-closed existence check was DROPPED (T0.1 → error→cold suffices), shrinking the constitution amendment to Principle I + Domain invariant 3; and the `--resume` **stale-result race was moved to a SOURCE-LEVEL fix in the `claude-p` fork** (D5 transcript-growth gate, spiked + proven) — dissolving the bridge stale-guard, the signal plumbing, the abort special-case, "Thread B", and the C5 sequencing question. R7 confirmed (T0.2).
