## 0. Pre-apply gates (spikes + sequencing)

- [x] 0.1 DONE 2026-06-06 — Spike (Clarify C4 / Risk R1): `claude --resume <missing>` **ERRORS, not silent-fresh** (direct: exit 1 "No conversation found"; via claude-p: exit 2 `SessionStartTimeout`). Silent-fresh hole refuted → the fail-closed existence check was **DROPPED** (owner: no defense-in-depth complexity); a deleted transcript surfaces as a `--resume` error → cold (D7). Notes: `.spike-notes/claude-p-gate/c4-missing-transcript-claude-2.1.159-2026-06-06T19-17-24Z/`.
  - intent: infra
  - files_allowed:
      - .spike-notes/**
- [x] 0.2 DONE 2026-06-06 — Spike (Design D6-limit / R7): a crafted dangling tool_use resumes cleanly through the full `claude-p` + `suppressResumeReplay` path (exit 0, terminal result, live prompt answered, `staleSuspected:false` — no misfire). **R7 confirmed, NOT inverted.** Also found: the bridge's abort/kill path self-closes the round — killing claude-p drops the MCP shim and `claude` writes an `is_error` tool_result ("MCP error -32000: Connection closed") before exiting — so a dangling transcript only arises from a crash mid-write (also covered). Notes: `.spike-notes/claude-p-gate/d6-dangling-claudep-claude-haiku-4-5-2026-06-06T19-21-34Z/`.
  - intent: infra
  - files_allowed:
      - .spike-notes/**
- [ ] 0.3 PREREQUISITE — land the `claude-p` transcript-growth gate (D5; the source-level stale-result fix, spiked on fork branch `spike/resume-staleness-gate`: state-gate `.stop` + require `num_turns > baseline` before emitting). Merge it onto claude-p `main`, `zig build` + `zig build test` green, then bump the bridge's claude-p pin (`package.json`). This is what lets the bridge trust the driver's `--resume` result; dissolves the old bridge stale-guard + Thread B + C5.
  - intent: infra
  - files_allowed:
      - package.json
      - package-lock.json

## 1. Constitution amendment (D8)

- [ ] 1.1 Amend the constitution (D8): **Principle I only** — permit a content-free resume-metadata sidecar (fingerprints + ids + version; never message content, no counters; the fingerprint chain is a one-way digest) stored outside `~/.claude/`. Bump constitution version — this partial reversal of Principle I is a **MAJOR** bump per the Versioning rule; pin the exact version + changelog text. (Principle III is UNCHANGED — the fail-closed existence `stat` was dropped, so the warm path adds no new `~/.claude` access; no III(b)/Enforcement/CI-audit edits.)
  - intent: infra
  - files_allowed:
      - openspec/constitution.md
- [ ] 1.2 Amend Domain invariant 3 (`domain.md:40-43`): `restart` is no longer an unconditional cold-start trigger — "restart **without a validated resume sidecar** → cold-start." Bump domain.md version. (Round-2 P0: today's invariant 3 literally contradicts this change.)
  - intent: infra
  - files_allowed:
      - openspec/domain.md

## 2. Resume-store module (D1, D3) — tests first

- [ ] 2.1 Write failing unit tests for the resume store: key derivation from the **literal** spawn cwd (`frame.cwd`, NOT realpath — assert a symlink-alias path and its real target map to DISTINCT keys, because `claude` fragments transcripts by literal cwd and `--resume` can't cross it, C1) + the **FULL** pi `sessionId` (NOT the 8-char `getPiSessionId()` truncation — assert two ids sharing an 8-char prefix get DISTINCT keys, C3/C3b); write/read round-trip; **content-free assertion via sentinel** (build the chain over messages containing a known sentinel string; assert the persisted JSON contains NO substring of any message — the chain is an opaque `sha256` per position, NOT the in-memory `hashMessage` which embeds 128 chars of plaintext); corrupt/torn file → null; atomic write (temp+rename) survives a concurrent read; path is under `~/.pi/agent/`, never `~/.claude/`.
  - intent: feature
  - files_allowed:
      - tests/unit-resume-store.mjs
- [ ] 2.2 Implement `src/resume-store.ts`: `readSidecar(cwd, sessionId)`, `writeSidecar(...)`, `invalidate(...)` over `~/.pi/agent/resume/<key>.json`; key = the **literal** `frame.cwd` + the full `sessionId` (from `sessionManager.getSessionId()`, not the truncating helper); schema = `{ claudeSessionId, piSessionId, historyHashChain, claudeVersion }` where `historyHashChain` is a per-position **`sha256(role+":"+len+":"+content)`** one-way digest (NOT the in-memory `hashMessage`, which leaks plaintext) — NO `lastNumTurns` (the D5 guard uses the self-contained `staleSuspected`), and NO `spawnCwd` (the cwd lives in the key; the dropped existence check was its only other consumer). Atomic writes (`<key>.json.tmp` + rename), best-effort (log + continue on failure). Make 2.1 pass.
  - intent: feature
  - files_allowed:
      - src/resume-store.ts
      - tests/unit-resume-store.mjs
- [ ] 2.3 Add prune-on-read (Risk R5): on `readSidecar`/store init, drop sidecars beyond a TTL or count cap so `~/.pi/agent/resume/` does not grow unbounded; unit-test the prune. (Owner alternative at Step 6: accept unbounded growth and drop the R5 mitigation instead.)
  - intent: feature
  - files_allowed:
      - src/resume-store.ts
      - tests/unit-resume-store.mjs

## 3. Validation gate (D2, D4, D5, D6) — tests first

- [ ] 3.1 Write failing unit tests for the **pre-spawn** validation gate: prefix-extension match (reuse `detectHistoryDivergence`) → warm; divergence / version-skew / missing-or-corrupt-sidecar → cold. NO staleness logic — the fork's transcript-growth gate (0.3) guarantees a live result, so the bridge has no `staleSuspected` input. Pure-function seam, no real claude-p.
  - intent: feature
  - files_allowed:
      - tests/unit-warm-resume-gate.mjs
- [ ] 3.2 Implement the pre-spawn validation gate (pure helper consumed by the bridge): inputs = sidecar + pi history hashes + current claude version; output = `{ warm: boolean, reason }`. Make 3.1 pass.
  - intent: feature
  - files_allowed:
      - index.ts
      - src/resume-store.ts
      - tests/unit-warm-resume-gate.mjs

## 4. Bridge wiring (D1, D2, D4, D5, D6, D7)

- [ ] 4.1 Persist the sidecar on a successful turn (in `finalizeClaudePFrame` at `index.ts:1371`, alongside the in-memory cache set at the `else if (res.sessionId)` branch `index.ts:1402`, beside the existing `.ready`-sentinel cleanup at `index.ts:1378`). **Gate `writeSidecar` on the main-turn finalize only — `top() === frame` (`index.ts:1429`); a subagent frame MUST NOT write a sidecar** (else `--resume` reattaches a subagent session). Invalidate the sidecar on a turn error (D7, alongside the cache clear in the error branch at `index.ts:1388`): the in-memory clear at `index.ts:1397` is *guarded* by session-id match, but the sidecar invalidation MUST be **unconditional by key** (drop it regardless of which session id errored). The error branch already covers `McpNotReady` (the `275dde9` readiness-gate fail-fast), so a gated attempt persists no sidecar.
  - intent: feature
  - files_allowed:
      - index.ts
- [ ] 4.2 Perform validated warm-resume at the **first post-resume turn in `startFreshQuery`** (where the literal `frame.cwd` exists) — NOT in the `session_start` handler, which carries no cwd. The `session_start:resume` handler (`index.ts:1698-1704`) keeps its existing side-effects (frame-drain + abort of leftover frames at `index.ts:1691-1696`, in-memory cache clear) and additionally sets a one-shot "warm-resume pending" flag; it does NOT read the sidecar. At the first turn with that flag + empty in-memory cache: read the sidecar by literal `frame.cwd` + full sessionId; run the gate (`sha256` prefix-match over pi's loaded history + `claude` version match; on any fail → cold, no `--resume`); on pass set `cachedSessionId`/`cachedSessionCwd` and set the in-memory divergence baseline by recomputing `computeMessageHashes(context.messages)` **locally** (R6 — NOT from the sidecar's sha256 chain) so `useResume` (`index.ts:1495`) takes the warm branch. (No transcript-existence pre-check — a deleted transcript surfaces as a `--resume` error → cold via D7, per T0.1.) Satisfies `claude-p-driver.cached-driver-session-is-a-hint-only`.
  - intent: feature
  - files_allowed:
      - index.ts
- [ ] 4.3 (NO bridge stale guard — D5 is fixed in the fork, task 0.3.) The bridge treats a driver `result` as authoritative and a driver error as an ordinary turn error: it surfaces (Principle VII) and invalidates the sidecar (D7) so the next turn cold-starts — no in-turn cold-retry. Just confirm no bridge-side stale detection exists/is added.
  - intent: feature
  - files_allowed:
      - index.ts
## 5. End-to-end validation + verify

- [ ] 5.1 Add pi-TUI scenarios (pi-tui-scenario-tests): (a) WARM — multi-turn session, restart/resume pi, assert the first post-resume turn is warm (bridge log shows `resume=<id>`, not a cold full-history re-pack) and the model retains context (coherence probe, paired positive+negative regex); (b) `/compact`-between-sessions forces COLD; (c) **no-stale-under-load** — drive several `--resume` turns with unique tokens under CPU load and assert every turn returns its OWN live answer (the fork transcript-growth gate; adapt `.spike-notes/claude-p-gate/resume-staleness-gate-e2e.mjs`); (d) an aborted-mid-tool prior turn then warm-resumes cleanly (R7); (e) a session whose last turn ran a SUBAGENT then resumes to the MAIN session (subagent-no-sidecar guard — `--resume` reattaches the main session). RED check (no kill-switch to toggle): with the sidecar removed/cleared, the SAME WARM scenario must cold-start — proving the sidecar drove the warm path.
  - intent: feature
  - files_allowed:
      - scripts/run-scenario-s*.sh
      - scripts/scenario-overrides.conf
      - SCENARIOS.md
- [ ] 5.2 Run `npm run typecheck` + `npm run build` + `npm run test:unit` green; ALSO run the lifecycle integration tests this change rewires — `tests/int-cache.sh` (session-resume vs rebuild), `tests/int-session-resume.mjs` (cross-provider context continuity), and `tests/int-claude-dir-audit.mjs` (Constitution III) — plus the new resume scenarios.
  - intent: infra
  - files_allowed:
      - "**/*"
- [ ] 5.3 Author `verify.md` (Verification Mode = retained-required): record the spike outcomes (T0.1 missing-resume errors; T0.2 R7 confirmed; the **source-level resume-staleness gate** spike — `zig build test` + the under-load e2e), the fork-land + repin (0.3), unit results, and the scenario results (5.1 a–e incl. the sidecar-removed RED check); Completion Decision RED→GREEN.
  - intent: infra
  - files_allowed:
      - openspec/changes/enable-warm-pi-resume/verify.md
