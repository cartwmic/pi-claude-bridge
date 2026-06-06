# Clarify Findings

Three passes over the EARS ACs in this change's `specs/**/spec.md` (delta only:
8 ACs in `warm-pi-resume`, 1 modified in `claude-p-driver`). Findings resolved
inline by the change author; two genuine unknowns are `deferred` and echoed into
`analyze.md` outstanding-risks.

## Pass 1 — Ambiguity (semantic-entropy lite)

| # | AC ref | Question | Option A (keep) | Option B (change) | Status | Resolution |
|---|---|---|---|---|---|---|
| A1 | warm-pi-resume:R1 | "history fingerprint chain" — a per-message hash list, or one rolling digest? | Single digest of the whole history | Per-message hash chain | answered (**persisted form corrected in Round 3**) | **B (per-position chain)** — the prefix-match in R3/R4 needs per-position hashes. **Round-3 P0 correction:** the *persisted* chain must be an opaque per-position `sha256(role+len+content)`, NOT the in-memory `hashMessage` (which embeds up to 128 chars of verbatim plaintext → would make the sidecar content-bearing). Divergence semantics are preserved by recomputing the sha256 chain over pi's loaded history and prefix-comparing; the in-process baseline (R6) is recomputed locally in the `hashMessage` format. See design D1/D2. |
| A2 | warm-pi-resume:R3 | "prefix-extension" — must resumed history EXACTLY equal the sidecar chain (nothing ran while down), or is forward-extension allowed? | Exact equality required | Prefix-extension allowed (forward progress OK) | answered | **B** — matches the in-process divergence rule (`detectHistoryDivergence`); harmless if pi appended a message before the first turn. |
| A3 | warm-pi-resume:R3 | Trigger is the `session_start:resume` event specifically, or any first turn where in-memory cache is empty but a sidecar exists? | Only the `session_start:resume` event | Any first turn with empty in-memory cache + a present sidecar | answered | **B** — covers a bare process restart (no resume event), and is strictly safer (still validates). |
| A4 | warm-pi-resume:R5 | What is the stale discriminator, and WHERE does it live? | A bridge-side signal (`num_turns` delta, or `staleSuspected`) | A SOURCE-level gate in the `claude-p` fork | **superseded by the source-level fix (2026-06-06)** | The whole question is moot at the bridge: the fork's transcript-growth gate (the live turn must append a new assistant turn past a pre-submit baseline) guarantees a live result, so the bridge has NO stale discriminator at all. Replaces the earlier bridge-side `staleSuspected` plan. See design D5. |

## Pass 2 — Inconsistency (pairwise antecedent overlap)

| # | AC pair | Shared antecedent | Conflict on output | Option A (keep both) | Option B (resolve) | Status | Resolution |
|---|---|---|---|---|---|---|---|
| I1 | R3, R4 | a sidecar exists on resume | warm vs cold | Mutually exclusive by validation outcome | n/a | answered | **A** — complementary, not conflicting: R3 = validation passes, R4 = validation fails. No shared output conflict. |
| I2 | R3, R7 | resume with a present sidecar | does a dangling tool call block resume? | R7 narrows R3 (dangling is NOT a fallback trigger) | n/a | answered | **A** — consistent; R7 is a `WHERE` refinement (spike-proven the driver self-repairs). |
| I3 | R4, claude-p-driver:R9 | `claude` version skew | both say cold-start | identical consequent | n/a | answered | **A** — consistent; R9 references the same version-skew drop. |

## Pass 3 — Completeness (event/state combination enumeration)

Declared events: resume/restart-first-turn, turn-success, turn-error, abort-mid-tool, cwd-change, version-skew, history-divergence, sidecar-write-fail, sidecar-read/corrupt, stale-replay. Declared states: sidecar present/absent, history match/diverge, version match/skew, transcript clean/dangling.

| # | Combination | Question | Option A (intentional silence) | Option B (add new AC) | Status | Resolution |
|---|---|---|---|---|---|---|
| C1 | resume + sidecar present + cwd differs only by symlink | Should the key normalize symlinks so the same repo doesn't fragment? | Exact-string (literal) cwd match (symlink alias → cache miss → cold) | Key on `realpath(cwd)` both at write and read | **A (re-corrected in Round 2; reverses the Round-1 B)** | Verified: `claude` fragments transcripts by the LITERAL cwd (both `~/.claude/projects/-Users-…` and `-Volumes-…` exist for one repo) and `claude --resume` resolves within the *current* cwd's project dir — so a resume from a symlink alias genuinely cannot find the session and MUST cold-start. Keying on the literal `frame.cwd` (option A) achieves exactly that, needs no `realpathSync`, and makes the R4 existence check encode the right dir. The Round-1 "key on realpath" answer was wrong. See design D3. |
| C3b | sidecar key uses the pi sessionId | Use the full id or the existing helper's value? | The existing `getPiSessionId()` value | The full untruncated `sessionId` | **answered (adversarial review)** | **B** — `getPiSessionId()` truncates to `id.slice(0,8)` (log-binding only, `index.ts:280`); an 8-char prefix raises collision risk and breaks the C3 no-collision guarantee. The store must key on the full id (`sessionManager.getSessionId()`). See design D3. |
| C2 | turn-error on a (non-first) warm turn | Should an errored turn invalidate the persisted sidecar, not just the in-memory cache? | Leave the stale sidecar (next resume validation catches it) | Invalidate/refresh the sidecar on error too | answered | **B** — on error, delete or mark the sidecar stale so a later resume cold-starts cleanly. Add to tasks. |
| C3 | two pi sessions, same cwd, concurrently | Sidecar key collision? | Keyed by literal cwd + full `sessionId` → distinct keys; invariant 1 holds | — | answered | **A** — distinct pi sessionIds → distinct sidecars; no collision. Same-session double-process: tolerated via atomic (temp+rename) writes — last writer wins; a torn read falls back to cold (R4 corrupt-sidecar). |
| C4 | resume + sidecar valid BUT claude transcript file deleted/cleaned | Pre-check transcript existence, or rely on `--resume` failing → cold? | Rely on `--resume` failure → error surfaces → next turn cold-starts (no extra `~/.claude` read) | Pre-stat the deterministic-path transcript (Principle III(b)-bounded) | **resolved; T0.1 spike DONE 2026-06-06** | **T0.1 result: `claude --resume <missing>` ERRORS, not silent-fresh** (direct exit 1 "No conversation found"; via claude-p exit 2 SessionStartTimeout) → the silent-fresh hole is **refuted**, so option A (rely on error→cold) is safe. **Final: the fail-closed existence check was DROPPED** (owner: no defense-in-depth complexity) — this also removed the Principle III(b)/Enforcement/CI-audit amendment + the OS-cwd encoding. A deleted transcript = one errored turn → next cold (D7). |
| C5 | warm-resume implemented before stale-result enforcement lands | Can R5's guard stand alone, or must the dependency land first? | — | — | **DISSOLVED (source-level fix, 2026-06-06)** | There is no separate "stale-result enforcement" change to sequence against: the `claude-p` fork transcript-growth gate (D5) fixes the race at the source for EVERY `--resume` turn. Only trivial sequencing remains (land the fork gate + repin before warm-resuming). |

**Status summary:** 0 unanswered, 0 deferred. C4 resolved by spike T0.1 (rely on error→cold; fail-closed check dropped). C5 DISSOLVED by the source-level fix (fork transcript-growth gate, spiked). A4 superseded (staleness handled in the fork, not the bridge); C3b added (full sessionId).
