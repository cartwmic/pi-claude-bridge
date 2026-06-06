# Analyze Findings

**Mode:** adversarial-review-cycle (Scale = L) — initial pass was single-model (Scale M); upgraded after the governance correction (a Principle-I amendment mandates Scale ≥ L + adversarial review).
**Generated:** 2026-06-05 by claude-opus-4-8; revised 2026-06-06 after adversarial Round 1 (2 reviewers, claude-opus-4-8).

Read-only remediation report over proposal/specs/clarify/design. No blockers →
tasks generation may proceed. One major (constitutional) with an in-change
remediation; the rest minor. See Check 9 for the adversarial Round 1 disposition
(2 P0 + 7 P1, all applied).

## Check 1 — Constitution compliance

| Principle | Status | Rationale | Severity |
|---|---|---|---|
| I. Pi owns conversation state | violated → remediated | The resume sidecar is new persistent state (Principle I: "MUST NOT persist conversation history of its own"). It stores fingerprints only, never content, and design **D8** amends Principle I to permit content-free resume metadata. | major (resolved by D8 / tasks amendment) |
| II. Bridge is inference-only | compliant | No new tool execution, domain logic, or pi-UI mutation; sidecar is bridge-internal cache metadata. | — |
| III. No `~/.claude/` filesystem coupling | compliant (UNCHANGED) | Sidecar lives under `~/.pi/agent/`, never `~/.claude/`. The warm path adds **no new `~/.claude` access at all** — the fail-closed existence `stat` was DROPPED after T0.1 showed `claude --resume <missing>` errors (error→cold suffices). `--resume` delegates the transcript read to `claude-p`. No III(b)/Enforcement/CI-audit change. | — |
| IV. Native Claude tools disallowed | inapplicable | No change to the tool surface / `--disallowedTools`. | — |
| V. System-prompt fidelity per path | compliant | Warm vs cold only changes *which* prompt is assembled; system-prompt delivery (`--system-prompt`) is unchanged. | — |
| VI. Concurrent paths share no state | compliant | Sidecar keyed by the literal cwd + full `sessionId`; atomic (temp+rename) writes so a concurrent reader never sees a torn file; capture path excluded; Domain invariant 1 preserved (clarify C3). | — |
| VII. Failures surface; degradation is explicit | compliant (strengthens) | Sidecar write-fail logged; a `--resume`/gate error SURFACES (Principle VII) + is WARN-logged on each resilience retry (`claudeP.ts:965`) → visible/actionable, never silently absorbed; warm-not-applicable → logged cold-start (expected control flow, not an error). | — |

## Check 2 — EARS pattern check (major, human-triage)

| # | File:line | AC | True positive? | Suggested rewrite | Status |
|---|---|---|---|---|---|
| E1 | warm-pi-resume:R1 (l.14) | "WHEN a main-provider turn completes **without error**, THE bridge SHALL persist…" | **no** (false positive) | n/a — "without error" is the nominal-success condition, not an error path. All true error conditions (R1 error scenario, R4, R5) correctly use IF…THEN. | not-a-finding |

## Check 3 — AC↔design coverage

| AC ID | Design section | Status |
|---|---|---|
| warm-pi-resume.resume-sidecar-persisted-on-successful-turn | D1, D7 | covered |
| warm-pi-resume.sidecar-stores-no-conversation-content | D1, D8 | covered |
| warm-pi-resume.validated-warm-resume-on-pi-resume | D2, D3, D4 | covered |
| warm-pi-resume.cold-start-when-validation-does-not-pass | D4 | covered |
| warm-pi-resume.cold-start-on-unreadable-or-malformed-sidecar | D4 | covered |
| warm-pi-resume.driver-guarantees-a-live-resume-result | D5 (source-level fork transcript-growth gate; bridge trusts the driver) | covered |
| claude-p-driver.resume-returns-the-live-turn-never-a-replayed-prior-turn | D5 | covered |
| warm-pi-resume.sidecar-invalidated-on-turn-error | D7 | covered |
| warm-pi-resume.divergence-baseline-rehydrated-on-warm-resume | D2, D4 | covered |
| warm-pi-resume.aborted-mid-tool-sessions-remain-resumable | D6 | covered |
| warm-pi-resume.warm-path-performs-no-new-claude-config-access | D2, D8 | covered |
| claude-p-driver.cached-driver-session-is-a-hint-only | D1, D4 | covered |

## Check 4 — design→ADR promotion candidates

| Decision | 4-point | Promote at archive? |
|---|---|---|
| D1 (persist content-free sidecar) | 4/4 | YES |
| D2 (pi-side validation, no claude-transcript hash) | 4/4 | YES |
| D5 (source-level fork transcript-growth gate — was "bridge stale guard + dependency") | 4/4 | YES |
| D8 (amend Principle I; reaffirm III) | 4/4 — constitutional | YES (mandatory) |
| D6 (dangling tool call not a fallback) | 2/4 | optional; spike is the record |
| D3, D4, D7 | <3/4 | recorded as constraints, no ADR |

## Check 5 — Duplicate detection

| # | Items | Verdict |
|---|---|---|
| Dup1 | warm-pi-resume R4 (cold on version-skew/divergence) vs claude-p-driver delta scenarios (version-skew/divergence drop) | **Intentional cross-reference**, not a duplicate: the `claude-p-driver` delta defers to `warm-pi-resume` for the validated path; the delta restates the drop triggers it already owned. Minor. |

## Check 6 — Implementation language in specs (Solution-free property)

| # | Token | AC | Verdict | Severity |
|---|---|---|---|---|
| L1 | `--resume`, `claude-p`, `--system-prompt` | R3, claude-p-driver delta | **Accepted** — the `claude-p-driver` capability's contract *is* the claude-p flag surface; existing spec names flags extensively. Consistent convention. | minor (accepted) |
| L2 | `~/.pi/agent/` (exact path) | R1, R8 | The *behavioral* requirement is "outside `~/.claude/`, in bridge-owned state" (Principle III). The exact path is implementation; acceptable as a concrete anchor but could be softened to "a bridge-owned location outside `~/.claude/`". | minor |
| L3 | `staleSuspected`, `buildColdStartPrompt` | R5, fallback refs | Named driver/bridge artifacts; behaviorally anchored (the stale discriminator / the cold-start contract). Accept. (R5's discriminator corrected from `num_turns` to `staleSuspected` in adversarial Round 1.) | minor (accepted) |

## Check 7 — Unresolved clarify findings (outstanding risks)

| # | Finding | Status | Carried as |
|---|---|---|---|
| C4 | Does `claude --resume <missing-transcript>` error or silently start fresh? | **RESOLVED — T0.1 spike DONE 2026-06-06** | `claude --resume <missing>` ERRORS (exit 1 direct / exit 2 via claude-p) — NOT silent-fresh. The hole is refuted; the committed fail-closed check (R4b) is belt-and-suspenders. |
| C5 | Sequencing vs. broader stale-result enforcement (dependency) | **DISSOLVED 2026-06-06** | Source-level fix: the `claude-p` fork transcript-growth gate (D5, spiked) fixes the `--resume` stale race for every turn → no separate enforcement change, no sequencing. Trivial prerequisite only (land fork gate + repin, task 0.3). |
| D6-limit | Re-run the dangling-tool_use resume through the full `claude-p` + suppression path | **RESOLVED — T0.2 spike DONE 2026-06-06** | R7 CONFIRMED through the full claude-p + suppression path (exit 0, result, live prompt answered, `staleSuspected:false`); the abort path self-closes the round anyway. R7 de-provisionalized. |

## Check 8 — Repo drift since proposal (re-validation 2026-06-06)

Re-checked against `main` HEAD `275dde9` (was `ca7937d` at proposal time). One new commit, materially relevant:

| Item | Effect on this change | Action |
|---|---|---|
| `275dde9` MCP-readiness gate (`.ready` sentinel + `McpNotReady` fail-fast) | Closes the "coldstart perpetuation" warm-`--resume`-replays-poison vector **at source**; narrows Risk R2 to the genuine stale-result-latch; the error set D7 invalidates on now includes `McpNotReady`. Strengthens, does not block. | Recorded in Context, D7, R2; D6-limit harness note. |
| Turn-lifecycle line shifts | `finalizeClaudePFrame` now `index.ts:1371` (cache set `1402`, error clear `1388`, sentinel cleanup `1378`); `clearSession` dispatch `index.ts:1701`. | Anchors re-resolved in proposal/design/tasks/plan. |
| Impl reuse — partly true, corrected in Round 1 (then D3 re-corrected in Round 2) | `claude --version` reader at `claudeP.ts:332` is real reuse (D2 `claudeVersion`). The stale signal was overstated: `staleSuspected` lives ONLY in the detection-only `onResumeDiag` (`stream.ts:615` constructs it; `claudeP.ts:653` is the driver callback), NOT on `ClaudePDoneResult` (`claudeP.ts:473-486`) — so D5 needs **net-new plumbing** (task 3.3). Round 1 said D3 needed net-new `realpathSync`; **Round 2 reversed D3 to the literal `frame.cwd`** (claude keys transcripts by literal cwd), so no realpath work at all. | Corrected in D3/D5; tasks 2.x/3.3. |

No EARS AC or constitution-amendment scope changed at Check 8; adversarial Round 1 (Check 9) then corrected several decisions.

## Check 9 — Adversarial review Round 1 disposition (2026-06-06)

Two blind reviewers (claude-opus-4-8) via review-plans. 2 P0 + 7 P1 + several P2/P3; all verified against source and applied this round.

| # | Finding | Severity | Disposition |
|---|---|---|---|
| 1 | Stale discriminator was `num_turns` (wrong) and unplumbed; in-tree primary is `staleSuspected` | P0 | Applied — D5 rewritten to `staleSuspected`; task 3.3 added to plumb it onto `ClaudePDoneResult`; spec R5 + clarify A4 updated |
| 2 | Constitution Governance mandates Scale ≥ L for a principle amendment; was M | P0 | Applied — review.md Scale = L, Review Status = requested; analyze mode = adversarial |
| 3 | `finalizeClaudePFrame` runs per-frame; unguarded persist records a subagent session | P1 | Applied — persist gated on `top()===frame` (D1, tasks/plan 4.1, spec R1 scenario) |
| 4 | "bridge already computes realpath(cwd)" false (`realpathSync` absent; D18 dead) | P1 | Applied in R1 (D3 marked realpath net-new) — then **superseded by Round 2 P0**: D3 reversed to literal `frame.cwd` (no realpath at all) |
| 5 | Sidecar key used truncated 8-char `getPiSessionId()` → collision risk | P1 | Applied — full sessionId (D3, clarify C3b, tasks 2.1/2.2) |
| 6 | C4 silent-fresh not caught by stale guard → safety hole | P1 | Applied — fail-closed transcript existence check committed (R4 AC, D2/R1, clarify C4) |
| 7 | No AC for sidecar-invalidation-on-error (D7/C2 coded but untraceable) | P1 | Applied — new "Sidecar Invalidated On Turn Error" requirement + scenarios |
| 8 | R3 duplicates the existing in-process divergence check | P1 | Applied — D2 reconciles (rehydrate `lastSentMessageHashes` → reuse `detectHistoryDivergence`; version-gate at resume time) |
| 9 | Aborted-turn baseline ambiguity (R7↔R5 coupling) | P1 | Applied — R5 abort scenario; dissolved by the `staleSuspected` switch (no counter baseline) |
| 10–13 | "can never do worse" overclaim; R7/D6 provisional; kill-switch default; C5 contradiction | P2 | Applied (proposal soften; D6 provisional note; **kill-switch default deferred to owner**, task 0.4; C5 reconciled) |
| 14 | Sidecar pruning/TTL had no task | P2 | Applied — task 2.3 (prune-on-read; owner may opt to drop) |
| 15–18 | R5 observability; L2 path-in-spec; 308 magic number; `~/.pi/agent/` framing | P2/P3 | Applied (R5 re-tied; spec path softened; plan count; design framing note) |

One owner decision deferred at the time (not auto-applied): kill-switch default — **resolved at Step 6: no kill-switch at all** (ship flag-free; revert via git + delete the sidecar dir).

## Check 10 — Adversarial review Round 2 disposition (2026-06-06)

Two blind reviewers (claude-opus-4-8) over the Round-1-revised artifacts. The fixes held; Round 2 surfaced DEEPER issues (the Round-1 changes exposed them). Both P0s verified against ground truth before applying.

| # | Finding | Severity | Disposition |
|---|---|---|---|
| 1 | Domain invariant 3 (`domain.md:40-43`) literally says "restart → cold-start"; the change reverses it but no task amended it | P0 (verified) | Applied — task 1.2 amends invariant 3; D8.3; proposal quote fixed |
| 2 | `claude` keys transcripts by **literal** cwd (verified: both `-Users-…` and `-Volumes-…` dirs exist for one repo); Round-1 realpath keying breaks the existence check + attempts resume where `--resume` can't succeed | P0 (verified) | Applied — D3 reversed to literal `frame.cwd` + `spawnCwd` field; existence check encodes spawnCwd; removes realpath work |
| 3 | Principle III(b) doesn't cover a prior-PTY session id / a stat; R8 overclaimed | P1 | Applied — D8.2 widens III(b); spec R8 reworded |
| 4 | Stale guard false-positives on aborted warm turns (`emitResumeDiag` fires at end-of-stream incl. abort) | P1 | Applied — R5 + D5 gate on `stopReason==="result"`; abort scenario |
| 5 | No task/test for the load-bearing R4 existence check | P1 | Applied — task 2.4 (helper + tests) |
| 6 | Risk R2 still cited `num_turns` | P1 | Applied — R2 → `staleSuspected` |
| 7 | R4 bundled normal + error conditions under one IF…THEN (EARS) | P1 | Applied — split into "Cold Start When Validation Does Not Pass" (WHEN) + "…Unreadable Or Unconfirmable Sidecar State" (IF…THEN) |
| 8 | "counts" advertised in the sidecar but the schema omits it | P1 | Applied — struck "counts" from spec R2, task 1.1, plan |
| 9 | R7 firm SHALL while provisional pending T0.2 | P1 | Applied — R7 marked provisional (may invert); AC checklist Complete=[~] |
| 10 | A3 "first turn after restart" trigger had no described hook | P1/P2 | Applied — task 4.2 + R3 specify the empty-cache-first-turn-with-sidecar check |
| 11–16 | wrapper-retry interaction; R5 no-false-positive scenario; atomic writes; persist-on-abort intended; kill-switch default vs AC; onResumeDiag anchor | P2 | Applied (D5 note; R5 healthy-warm scenario; task 2.2 atomic; D1 abort note; review/verify; both anchors cited) |
| 17–18 | proposal overclaim; fingerprint-at-finalize note | P3 | Applied |

## Check 11 — Adversarial review Round 3 disposition (2026-06-06)

Two blind reviewers (claude-opus-4-8). Trajectory converged sharply (P0+P1: R1=9, R2=10, R3=5); one reviewer found no P0. Both P0/P1 claims verified against source before applying.

| # | Finding | Severity | Disposition |
|---|---|---|---|
| 1 | Persisted `historyHashChain` would leak plaintext — the in-memory `hashMessage` (`index.ts:305-310`) embeds up to 128 chars verbatim; persisting it defeats the content-free premise of the Principle-I amendment | P0 (verified) | Applied — chain is now an opaque per-position `sha256`; D1/spec R2 + sentinel content-free test (clarify A1 corrected) |
| 2 | Keyed validation can't run at `session_start` (no cwd there); the A3 "first turn after restart" trigger was unwired | P1 | Applied — turn-start keyed validation in `startFreshQuery` is canonical; `session_start` only sets a pending flag + keeps frame-drain (D4, R3, task 4.2) |
| 3 | III(b) widening was incomplete — the III Enforcement clause + the `int-claude-dir-audit.mjs` CI guard would reject the R4 stat | P1 (verified) | Applied — D8.2 amends Enforcement; task 1.3 updates the audit; version bump pinned MAJOR |
| 4 | Transcript-path encoding underspecified — `claude` replaces `.` as well as `/` (verified `.spike-notes`→`--spike-notes`) | P1 (verified) | Applied — task 2.4 specifies the full rule + dotted-path test |
| 5 | D4 overclaimed in-turn cold fallback on a `--resume` runtime error (wrapper retries same id → error turn → next-turn cold) | P1 | Applied — D4 corrected to per-failure-type granularity |
| 6–13 | persist anchor 1429≠1402; clearSession frame-drain; claude-p-driver AC trace; R-number legend; verification omits int tests; subagent-no-sidecar test; kill-switch gating in spec; R5 drop-sidecar | P2 | Applied (D1/4.1 reworded; D4 notes frame-drain; 4.2 cites the delta AC; design legend; 5.2 adds int-cache/int-session-resume/int-claude-dir-audit; 5.1 adds subagent scenario; R3 kill-switch clause; R5 drops sidecar) |
| 14–15 | "net-new realpath" leftover; constitution version-bump magnitude | P3 | Applied (Scale note corrected; MAJOR bump pinned) |

## Summary

- **Blockers:** 0 after Round 3 — apply may proceed once pre-apply gates clear.
- **Majors:** 1 — Principle I violation, remediated in-change by the D8 amendment + Scale L (tracked into tasks).
- **Adversarial Round 1 (Check 9):** 2 P0 + 7 P1, all applied.
- **Adversarial Round 2 (Check 10):** 2 P0 (domain invariant 3; literal-cwd transcript keying) + ~8 P1 — all verified against ground truth and applied. Round 2 dug deeper than Round 1 (the fixes exposed the next layer); it added a Principle III(b) widening + Domain invariant 3 amendment. *(The III(b) widening was later DROPPED post-spike — see Outstanding — leaving only the Domain invariant 3 amendment.)*
- **Adversarial Round 3 (Check 11):** 1 P0 (persisted-chain plaintext leak) + 4 P1 — verified and applied; trajectory converged (P0+P1 9→10→5). The content-free premise is enforced by an opaque `sha256` digest + a sentinel test. *(Round 3 also completed the III(b)/Enforcement/CI-audit amendment end-to-end; that whole branch was later DROPPED post-spike when T0.1 removed the need for the existence check.)*
- **Spikes (all DONE 2026-06-06):** **T0.1** — `claude --resume <missing>` ERRORS (not silent-fresh) → fail-closed existence check DROPPED, shrinking the constitution amendment to Principle I + Domain invariant 3 (Principle III untouched); **T0.2** — R7 CONFIRMED; **source-level resume-staleness gate** — proven in the `claude-p` fork (zig tests + under-load e2e), which moved the stale-result fix to the source (D5) and **dissolved the bridge stale-guard + signal plumbing + Thread B + the C5 sequencing question** (Check 12).
- **Outstanding (pre-apply):** only the trivial prerequisite — land the fork gate on claude-p `main` + bump the pin (task 0.3). Step-6 owner calls resolved: no kill-switch; constitution bump MAJOR.
- **Repo drift (Check 8):** re-validated at HEAD `275dde9`; no scope change from drift.

## Check 12 — Source-level stale-result fix (2026-06-06)

Owner pushed back on the bridge-side stale guard as smelly (detect-emit-bad-then-discard). Spiked a source-level fix in the maintained `claude-p` fork instead: a **transcript-growth gate** (state-gate `.stop` on `awaiting_stop`; require `num_turns > pre-submit baseline` before emitting a `--resume` result; else error → surfaced (the bridge drops the session → next turn cold-starts)). Proven on fork branch `spike/resume-staleness-gate` (`zig build test` green incl. a deterministic unit test; live under-load e2e — 4 resume turns, 0 stale emits). This is deterministic and covers every `--resume` turn, vs. the bridge heuristic's first-turn-only + timing-dependent + abort-special-case. **Dissolved:** the bridge stale-result detection (old D5/`staleSuspected`), the `ClaudePDoneResult` signal plumbing (old task 3.3), the abort false-positive special-case, "Thread B", and the C5 sequencing decision. The bridge keeps `suppressResumeReplay` for stream-replay dedup (a fuller fork change could shed that too — noted as a follow-on, out of scope).
