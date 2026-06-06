## Context

Today the bridge holds the driver session id in-memory only
(`cachedSessionId`, `index.ts:290`) and unconditionally clears it on
`session_start:resume` (the `clearSession` dispatch at `index.ts:1701`), so every
pi resume/restart cold-starts: `buildColdStartPrompt` re-packs the whole
conversation into one typed prompt. This is slow, lossy, expensive (full
re-cache), and — pre-paste-fix — a hard failure. The underlying `claude` session
persists on disk; reattaching to it is the win.

**Relevant prior art (commit `275dde9`, MCP-readiness gate).** Warm `--resume`
already had a known poison-perpetuation failure: when claude-p lost the
MCP-attach race it submitted the prompt before `mcp__custom-tools__*` was
registered, the model emitted tool calls as raw text, and a warm `--resume` retry
*replayed* that leaked text — "coldstart perpetuation," so every retry failed
identically. That is now fixed at source: claude-p holds the submit `Enter` until
the shim raises a `${socketPath}.ready` sentinel (created on its first
`tools/list`) and fails fast with `McpNotReady` otherwise, so a gated attempt
never submits and never poisons the transcript; `finalizeClaudePFrame` cleans up
the sentinel (`index.ts:1378`). This de-risks warm resume (one major poison
vector is closed at source) and establishes a property this design must preserve
across restarts — a gated/failed attempt is an error, so it persists no sidecar
and invalidates any existing one (see D7 and Risk R2).

This design is constrained by:
- **Constitution Principle I** — "the bridge MUST NOT persist conversation
  history of its own" (enforcement: design review of any new persistent state).
- **Constitution Principle III** — no writes under `~/.claude/`; reads only via a
  hook payload or a bridge-generated deterministic path (III(b)). (Unchanged by
  this design — the fail-closed transcript-existence stat that would have used
  III(b) was dropped; the warm path adds no new `~/.claude` access.)
- **Domain invariant 3** — a driver session id is a cache hint only.

**Note on `~/.pi/agent/`:** this is not the bridge's first write there — claude-p
stale diagnostics already land under `~/.pi/agent/` (`writeStaleDiag`,
`claudeP.ts`). The novelty D1/D8 introduce is *conversation-fingerprint* metadata,
not the directory; the Principle-I framing is about content, not location.

## Goals / Non-Goals

**Goals:**
- The first turn after a pi resume/restart warm-resumes the prior `claude`
  session when it is provably safe to do so.
- Cold-start remains the always-safe floor; the change can never do worse.
- Persist only content-free fingerprints; pi stays the source of truth.

**Non-Goals:**
- The capture path (always single-shot; never resumes).
- The persistent-process driver (orthogonal; composable later).
- Reading/parsing `~/.claude/` transcripts from the bridge (Principle III).
- Resilience to a `claude` upgrade that reformats transcripts (version-gated → cold).

## Requirement-ID legend (canonical IDs are the slugs)

The artifacts use informal `R#` shorthand for `warm-pi-resume` requirements; the **canonical** IDs are the spec slugs. After the Round-2 split of the old R4, the mapping is:

| Shorthand | Canonical slug |
|---|---|
| R1 | resume-sidecar-persisted-on-successful-turn |
| R2 | sidecar-stores-no-conversation-content |
| R3 | validated-warm-resume-on-pi-resume |
| R4a | cold-start-when-validation-does-not-pass |
| R4b | cold-start-on-unreadable-or-malformed-sidecar |
| R5 | post-spawn-stale-result-guard |
| R-err | sidecar-invalidated-on-turn-error |
| R6 | divergence-baseline-rehydrated-on-warm-resume |
| R7 | aborted-mid-tool-sessions-remain-resumable (confirmed by T0.2) |
| R8 | warm-path-performs-no-new-claude-config-access |
| R9 | claude-p-driver.cached-driver-session-is-a-hint-only (delta) |

**Note:** the **Risks** table below also uses `R1`–`R6` tokens, for a *different* namespace (risk rows). Risk rows are ALWAYS written with the word "Risk" (e.g. "Risk R2"); a bare `R#`/`R4a`/`R4b` always means a requirement. Prefer canonical slugs when in doubt.

## Decisions

### D1: Persist a content-free resume sidecar under `~/.pi/agent/`

**Choice:** On each non-error main-turn finalize (this **intentionally includes the abort path** — abort is non-error and reaches the cache-set branch `index.ts:1402-1407` — so an aborted-mid-tool session stays resumable, which is what makes R7 work; do NOT gate persist on a clean-stop-only condition), write `{ claudeSessionId, piSessionId, historyHashChain, claudeVersion }` to `~/.pi/agent/resume/<key>.json`, where `<key>` encodes the literal cwd + full pi `sessionId` (D3). No message content, and no `lastNumTurns` — the D5 stale guard uses the self-contained `staleSuspected`, which needs no persisted counter baseline. (No `spawnCwd` field: the cwd lives in the key; the dropped transcript-existence check was its only other consumer.)

**Chain snapshot timing + write-side provenance:** `lastSentMessageHashes` is set at turn-start (`index.ts:1493`), so a sidecar written at finalize records the chain the turn was *built on* (pre-this-turn). That is harmless — pi's resumed history is a forward-extension, so the prefix-match still passes. Concretely: compute the persisted `sha256` chain at turn-start over `context.messages` (a `computeSha256Chain` helper in the resume-store) and **stash it on the frame** (e.g. `frame.sha256Chain`), since `finalizeClaudePFrame(frame, res)` does not receive the messages. Do not recompute post-turn (that would fail the next prefix-match). The `piSessionId` argument at finalize comes from the module-global `piExtCtx.sessionManager.getSessionId()` (full id, not the truncating helper).

**`historyHashChain` MUST be an opaque one-way digest — NOT the in-memory `hashMessage` (Round-3 P0):** the in-memory divergence helper `hashMessage` (`index.ts:305-310`) returns `` `${role}:${len}:${slice(0,96)}|${slice(-32)}` `` — i.e. up to 128 chars of **verbatim** message plaintext. That is fine in-memory (transient) but **persisting it would make the sidecar content-bearing**, violating Principle I, R2, and this whole amendment's premise. So the persisted chain MUST be a per-position `sha256(role + ":" + len + ":" + content)` (or equivalent one-way hash) — preserving prefix-match semantics while storing no recoverable plaintext. (This corrects Clarify A1, which chose to "reuse `computeMessageHashes`" for persistence.) The content-free test MUST assert the persisted chain contains no substring of any input message (sentinel fixture), not merely "no obvious bodies."

**Alternatives considered:**
- **In-memory only (status quo):** zero new state, but no cross-restart resume. Doesn't meet the goal.
- **Persist under `~/.claude/`:** violates Principle III outright.
- **Stash the mapping in pi's own session store:** cross-repo coupling into pi; the bridge doesn't own pi's store. Out of scope.

**Rationale:** the sidecar is a *cache-validation fingerprint*, not conversation authority — pi still owns history, and any mismatch falls back to re-deriving from pi (cold). This requires **amending Principle I** to permit content-free resume *metadata* (see D8).

**Persist only on the main-turn finalize:** `finalizeClaudePFrame` (`index.ts:1371`) runs for **every** frame on the stack — including subagent frames, which carry their own `sessionId` and reach the cache-set branch (`index.ts:1402`). The cache-set branch (1402-1408) is itself **unguarded** — it runs for every frame. (Note: the `if (top() === frame)` block at `index.ts:1429` is a *separate, later* block handling stack-pop/router-stop; it does NOT enclose 1402.) So the fix is to add a **new** `top() === frame` check **around the `writeSidecar` call** (reusing the same condition the 1429 block uses), not to assume 1402 is already main-turn-gated. Without it a subagent finalize would record a subagent's session and a later `--resume` would reattach the wrong transcript.

**4-point test:** multiple approaches ✓, lasting ✓, disagreement ✓, constrains future ✓ → **ADR candidate: YES.**

### D2: Validate with the pi-side fingerprint chain + version only — do NOT hash claude's transcript

**Choice:** Validate a resume by (a) pi's loaded history is a prefix-extension of `historyHashChain` (reuse `detectHistoryDivergence`), and (b) `claudeVersion` matches. Do **not** read or hash claude's on-disk transcript.

**Alternatives considered:**
- **Dual-hash (also hash claude's transcript each turn):** detects out-of-band tampering of the cache, but requires the bridge to *read* `~/.claude/` transcripts every turn — an expansion of Principle III reads we don't want. Deferred.

**Rationale:** pi's history is legitimate bridge input (Principle I-clean); the version gate covers the main cache-invalidating drift (transcript-format skew). Reattachment passes `--resume` to `claude-p`, which does the transcript read — the bridge adds no `~/.claude` access.

**Implementation reuse:** the version reader already exists — `claudeP.ts:332` (`claude --version` → `"2.1.159"`); the sidecar's `claudeVersion` field reuses it, no new code path.

**Where the two gates live (R3 resume-validation vs. the in-process baseline) — refined for the opaque digest:** there are two distinct hash uses, and the opaque-digest fix (D1) means they CANNOT share one representation:
- **Resume-time validation (R3/R4):** compute the `sha256` chain over pi's freshly-loaded history and prefix-compare it to the sidecar's persisted `sha256` chain. This is a small new helper (`detectHistoryDivergence` is parameterized by, or duplicated for, the digest fn — it operates on string arrays already; just feed it the sha256 chains). Plus the `claudeVersion` match. Version-gating MUST happen at resume time (when the sidecar is read). (No transcript-existence check — dropped per the owner decision; a deleted transcript surfaces as a `--resume` error → cold, see Risk R1.)
- **In-process baseline (R6):** set `lastSentMessageHashes = computeMessageHashes(context.messages)` — recomputed **locally** from pi's loaded history in the **in-memory `hashMessage` format** (NOT rehydrated from the sidecar, which is sha256). This is content-clean (in-memory) and keeps the existing turn-start `detectHistoryDivergence` (`index.ts:1484`) working for subsequent in-process turns.

So the warm decision is made by the sha256 resume-validation (where `frame.cwd` is known, see D4), which then sets `cachedSessionId`/`cachedSessionCwd` so `useResume` (`index.ts:1495`) takes the warm branch; the in-process baseline is recomputed locally. Do not conflate the two hash formats.

**4-point test:** multiple approaches ✓, lasting ✓, disagreement ✓, constrains future ✓ → **ADR candidate: YES.**

### D3: Key the sidecar on the LITERAL spawn cwd + the FULL pi `sessionId`

**Choice:** Key on the literal cwd the bridge spawns claude-p with (`frame.cwd`) plus the **full** pi `sessionId`. Do NOT use `realpath(cwd)`.

**Rationale (REVERSED in adversarial Round 2 — the Round-1 realpath decision was wrong):** verified against the live filesystem — `claude` stores transcripts under a project dir encoded from the **literal** cwd: `~/.claude/projects/-Users-cartwmic-git-pi-claude-bridge` AND `-Volumes-Workshop-git-pi-claude-bridge` both exist for the same repo via the `/Users/cartwmic/git -> /Volumes/Workshop/git` symlink. `claude --resume <id>` resolves the session within the **current** cwd's project dir, so a resume from a different literal path (e.g. the symlink alias) cannot find a session created under the other path. Consequences:
- Keying on `realpath` would let warm-resume be attempted across a literal-cwd change where `--resume` cannot succeed → error/cold. Wrong.
- Keying on the **literal** cwd is correct: a resume from a different literal path simply misses the sidecar → cold-start (the only correct outcome, since `--resume` would fail there anyway). The C1 "fragmentation" the original spike feared is claude's own reality, not a bug to mask.
- Bonus: this **removes** the net-new `realpathSync` work — the bridge already has the literal `frame.cwd`.

**Full sessionId required:** the C3 "no collision for two pi sessions in the same cwd" guarantee depends on distinct sessionIds → distinct keys. The existing `getPiSessionId()` helper returns `id.slice(0, 8)` (log-binding only, `index.ts:280`); an 8-char prefix materially raises collision risk. The store must key on the untruncated id (`piExtCtx.sessionManager.getSessionId()`), not the truncating helper.

**The sidecar key only needs intra-session stability** (persist and resume both use the same `frame.cwd`), so the literal `frame.cwd` is fine. NOTE (from T0.2): `claude` records the *OS-resolved* cwd for its own transcript dir (`/tmp`→`/private/tmp` firmlink), which is why the realpath-vs-literal distinction mattered for the now-dropped existence check — but it does NOT affect the sidecar key (the bridge never reads claude's transcript dir).

**4-point test:** multiple approaches ✓ (literal-vs-realpath was a real, consequential fork the review surfaced), lasting ✓, disagreement ✓ → **ADR candidate: borderline** — record as a constraint with the Round-2 correction.

### D4: Cold-start is the invariant floor; warm is a strict optimization

**Choice:** Any failure falls back to cold-start — but the *granularity* differs by failure type (corrected Round 3):
- **Pre-spawn validation failure** (missing/corrupt sidecar, divergence, version skew): cold-start **this turn**, transparently (no `--resume` is passed).
- **Result-only stale guard** (`staleSuspected` on a clean `result`): discard + cold-retry **this turn** (D5).
- **`--resume` *runtime* error** (incl. a deleted/cleaned transcript — T0.1: `claude` reports "No conversation found"): the resilience wrapper retries with the SAME `--resume` id (`buildRetryConfig` keeps the id, `claudeP.ts:~997`) up to its cap, then resolves `stopReason:"error"`; `finalizeClaudePFrame` invalidates the cache + sidecar (D7) so the **next** turn cold-starts. The current turn surfaces an error (Principle VII) — it is NOT transparently re-run cold in-turn. (If an in-turn cold-retry-on-resume-error is later wanted — to make the rare deleted-transcript case transparent without an existence pre-check — it's a small, separate step.)

**Keyed validation runs at turn-start, where `frame.cwd` exists (Round 3):** the sidecar key needs the literal spawn cwd (`frame.cwd` = `options.cwd ?? process.cwd()`, `index.ts:1451`), which is turn-scoped — the `session_start` event carries no cwd. So the keyed sidecar read + validation is performed at the first post-resume turn in `startFreshQuery` (before `useResume` is computed), NOT in the `session_start` handler. `session_start:resume` only sets a one-shot "warm-resume pending" flag (and still performs its frame-drain side effects); it does NOT do the keyed read. This makes Clarify A3's "first turn with empty cache + present sidecar" the canonical, and only, trigger mechanism.

**Rationale:** the session id is still "a cache hint," now validated + persisted; cold-start guarantees no regression vs. today. **NOTE (Round 2):** Domain invariant 3 currently lists `restart` as an unconditional cold-start trigger (`domain.md:40-43`) — this change directly reverses that for the *validated* case, so invariant 3 MUST be amended (D8.3 + tasks), not merely "spirit-preserved." After the amendment, invariant 3 reads "restart **without a validated resume sidecar** → cold-start."

**4-point test:** lasting ✓, constrains future ✓; low disagreement → record as a constraint (not a full ADR).

### D5: Post-spawn stale-result guard via the driver's `staleSuspected` signal; depends on stale-result enforcement

**Choice:** After a warm spawn, gate on the driver's stale-turn signal `staleSuspected = sawReplayBoundary && !livePromptAfterBoundary` (claude-p replayed the prior terminal state but no live prompt followed the final replay boundary → the live turn never ran), **but only when `stopReason === "result"`** (a clean turn-end). On stale: discard the result, drop the cache + sidecar, and cold-retry. `num_turns` (frozen-vs-advanced) is at most a corroborating cross-check, **not** the primary gate.

**Abort false-positive guard (Round 2):** `emitResumeDiag` fires at end-of-stream whenever `suppressResumeReplay` (= `useResume`) is true — *including on a user-aborted warm turn* (`stream.ts:334`). On an abort during/just-after replay, `sawReplayBoundary` can be true with no live prompt yet → `staleSuspected: true` spuriously. So the bridge MUST only honor `staleSuspected` on `stopReason === "result"`, never on `aborted`/`error` — otherwise it would discard a legitimate aborted partial and force an unwanted cold-retry. (Spec R5 + the abort scenario.)

**Retry-layer interaction (Round 2):** a `staleSuspected` turn returns `stopReason: "result"` (not an error), so the resilience wrapper's internal retry (gated by `shouldRetry: !router.everRoutedToolCall`, `index.ts:1659` — it retries only an un-routed spawn, never a clean `result`) does NOT fire on it — the bridge-level guard is the sole stale cold-retry. State this so the guard is wired at the bridge layer, not duplicated in the wrapper.

**Why not `num_turns` as primary (corrected):** the in-tree detection code (commit `404c76c`, `src/driver/stream.ts:57-80`) already designates `livePromptAfterBoundary`/`staleSuspected` as "the **primary** stale discriminator — self-contained, no text/count heuristic," and ranks `num_turns` as a weaker signal. `num_turns` semantics are also less robust across multi-round turns. Use the signal the driver author already proved out for exactly this bug.

**Plumbing required (net-new — was overstated as "already plumbed"):** today these signals exist ONLY in the parser's detection-only `onResumeDiag` callback (`src/driver/claudeP.ts:653`, which logs + writes a diag file). They are NOT on `ClaudePDoneResult` (`claudeP.ts:473-486`) — the value `finalizeClaudePFrame` and the turn loop actually consume (it carries only `stopReason`/`sessionId`/`exitCode`/`signal`). So this decision requires surfacing the stale signal from the parser onto `ClaudePDoneResult` (and through the resilience wrapper at `claudeP.ts:896`) so the bridge can enforce on it. Tracked as an explicit task; without it the guard is unbuildable.

**Rationale:** warm resume rides the same `--resume` replay path as the known warm-resume stale-result bug. This per-resume guard is implementable here once plumbed; the broader in-process stale-result enforcement is a **named dependency** (Thread B). (Clarify C5 — deferred for owner triage; note the per-resume guard is only load-bearing AFTER the plumbing + correct discriminator land, so "proceed standalone" is conditional on this decision being implemented faithfully.)

**4-point test:** multiple approaches ✓, lasting ✓, disagreement ✓, constrains future ✓ → **ADR candidate: YES.**

### D6: A dangling tool call is NOT a fallback trigger (spike-proven)

**Choice:** Warm-resume proceeds even when the prior transcript ends in an unclosed tool call (aborted mid-tool).

**Rationale:** Live spike — `claude --resume` of a transcript ending in a dangling `mcp__custom-tools__bash` tool_use returned cleanly (exit 0, answered the new prompt); claude repairs the dangling call at request-construction time (no synthetic result persisted). So the feared abort edge is handled by the driver, not the bridge. *Limit:* tested via `claude` directly, not the full `claude-p` + suppression path → see Open Questions.

**T0.2 RESULT (2026-06-06) — R7 CONFIRMED, no longer provisional.** Ran the dangling-tool_use resume through the full `claude-p` + `suppressResumeReplay` path (`.spike-notes/claude-p-gate/d6-dangling-claudep-claude-haiku-4-5-2026-06-06T19-21-34Z/`):
- **Finding B (R7's literal precondition):** a crafted transcript ending in an unclosed `tool_use` resumed cleanly — exit 0, terminal `result`, live prompt answered, `danglingErrorSeen:false`, and `staleSuspected:false` / `livePromptAfterBoundary:true` (the guard does NOT misfire). The driver repairs the dangling call at request-construction. **R7 holds; it does not invert.**
- **Finding A (production path):** the bridge's own abort/kill path does NOT even produce a dangling transcript — killing claude-p kills the MCP shim, and `claude` writes a synthetic `is_error` tool_result ("MCP error -32000: Connection closed") for the pending call before exiting. So the abort case leaves a *closed* round; the dangling case only arises from a crash mid-write, which Finding B also covers.

**4-point test:** disagreement ✓ (it was the scariest edge), lasting ✓ → ADR candidate: borderline; record the spike as the decisive evidence.

### D7: Invalidate the sidecar on a turn error

**Choice:** When a turn errors (the in-memory cache is already cleared in the error branch at `index.ts:1388`), also delete/mark the sidecar stale so a later resume cold-starts cleanly. (Clarify C2.)

**Rationale:** keeps the persisted hint consistent with the in-memory invariant. The error set now explicitly includes `McpNotReady` (the readiness-gate fail-fast from `275dde9`) — so a gated attempt that never submitted persists no sidecar, structurally preventing the cross-restart form of coldstart perpetuation (Context, Risk R2).

**Guard condition:** the in-memory error-branch clear is *guarded* (`if (cachedSessionId === res.sessionId || cachedSessionCwd === cwd)`, `index.ts:1397`) — so an error from a spawn whose session never became the cached one skips the clear. Sidecar invalidation must be **unconditional** on a main-turn error (delete by key regardless of which session id errored), because the persisted sidecar can outlive the in-memory cache and a stale key left on disk would warm-resume on the next restart. (Spec AC: "Sidecar Invalidated On Turn Error".)

### D8: Amend Constitution Principle I; amend Domain invariant 3 (Principle III UNCHANGED)

**Choice:** Two normative edits (the III(b) widening was DROPPED with the existence check — owner decision: no defense-in-depth complexity):
1. **Principle I** — permit a *content-free* resume-metadata sidecar (fingerprints + ids + version; never message content), stored outside `~/.claude/`.
2. **Domain invariant 3** — remove the unconditional "restart → cold-start" rule; carve out the validated-warm-resume exception (see D4).

**Principle III is UNCHANGED.** Since the fail-closed transcript-existence `stat` was dropped (T0.1 proved `claude --resume <missing>` errors → the error→cold path suffices), the warm path introduces **no new `~/.claude` access at all** (`--resume` delegates the transcript read to claude-p). No III(b) body change, no III Enforcement change, no `int-claude-dir-audit.mjs` change. This is the main simplification from dropping the check.

**Version bump: MAJOR (owner-ratified).** The Principle I relaxation is a partial reversal of "MUST NOT persist conversation history" → per the constitution's Versioning rule ("principle removed or reversed" = MAJOR). The owner ratified MAJOR over the MINOR alternative (the 2026-05-21 III(b)-exemption precedent), on the basis that relaxing a "MUST NOT" is a reversal, not a pure addition. Pin the exact version + changelog text in task 1.1.

**Rationale:** the change is meaningless without one persisted bit of state; the amendment scopes it tightly (content-free fingerprints only) so Principle I's anti-divergence intent is preserved, and Principle III is untouched.

**4-point test:** lasting ✓, disagreement ✓, constrains future ✓ → **ADR candidate: YES** (constitutional).

## Risks / Trade-offs

| # | Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|---|
| R1 | `claude --resume` of a deleted/cleaned transcript | Low | Low | **T0.1 (DONE): `claude --resume <missing>` ERRORS** (exit 1 direct / exit 2 via claude-p) — it does NOT silently start fresh. So a deleted transcript → `--resume` error → D7 invalidates the sidecar → next turn cold-starts (one errored turn in this rare case). No existence pre-check needed (dropped per owner). Residual: a future claude version that changes this behavior — covered by the `claudeVersion` gate. |
| R2 | Stale-result replay-latch returns a wrong (previous) answer | Medium | High | D5 `staleSuspected` guard (`num_turns` is at most a corroborator) + the named stale-enforcement dependency; cold-retry on detect. The MCP-attach-race instance of this ("coldstart perpetuation") is already fixed at source by the `275dde9` readiness gate; a gated/failed attempt persists no sidecar (D7), so a sidecar can never point at a poisoned transcript. Residual risk is the genuine replay-latch only. |
| R3 | `claude` upgrade reformats transcripts; old session unresumable | Medium | Low | D2 version gate → cold-start on skew |
| R4 | Principle-I "content-free" creeps toward storing content | Low | High | D8 amendment scoped to fingerprints; analyze check 3 + design review of the sidecar schema |
| R5 | Sidecar grows unbounded (one file per session) | Low | Low | TTL/size cap + prune on read; keyed cleanup |
| R6 | Warm resume masks a real divergence the hash-chain misses | Low | Medium | Prefix-match is the same primitive used in-process today; cold floor on any miss |

## Migration Plan

- Additive + behind validation: cold-start path is unchanged and remains the
  fallback, so no data migration. **No feature flag / kill-switch** (owner
  decision: "no conditional logic; we can always revert") — cold-start being the
  invariant floor (D4) is what makes this safe without a runtime toggle.
- Rollback: `git revert` the change and/or delete `~/.pi/agent/resume/`. No
  durable state in pi or `~/.claude/` is touched.
- Sequencing: land the stale-result enforcement dependency first or together
  (D5 / Clarify C5).

## Open Questions

- **C4 (resolved → fail-closed; T0.1 SPIKE DONE 2026-06-06):** Spike result —
  `claude --resume <missing>` **ERRORS, it does not silently start fresh**
  (direct: exit 1 "No conversation found"; via `claude-p`: exit 2
  `SessionStartTimeout`). See `.spike-notes/claude-p-gate/c4-missing-transcript-claude-2.1.159-2026-06-06T19-17-24Z/`.
  So the silent-fresh correctness hole is **refuted** for 2.1.159 — the
  `--resume`-error → cold path is the real safety. **RESOLVED: the fail-closed
  existence check was DROPPED** (owner: no defense-in-depth complexity). This
  removed the entire Principle III(b)/Enforcement/CI-audit amendment and the
  OS-cwd encoding work; the warm path now adds no `~/.claude` access at all.
- **C5:** Sequencing — does this change wait on the broader stale-result
  enforcement, or ship with only the per-resume `staleSuspected` guard
  (corrected + plumbed per D5)? *Owner
  decision.*
- **D6 limit — RESOLVED (T0.2 spike DONE 2026-06-06):** ran the dangling-tool_use
  resume through the full `claude-p` + `suppressResumeReplay` path
  (`.spike-notes/claude-p-gate/d6-dangling-claudep-claude-haiku-4-5-2026-06-06T19-21-34Z/`
  + harness `d6-dangling-*.mjs`). A crafted dangling tool_use resumed clean
  (exit 0, result, live prompt answered, `staleSuspected:false`). **R7 holds, no
  invert.** Bonus: the abort/kill path self-closes the round (claude writes an
  `is_error` tool_result on MCP disconnect), so the dangling case only arises
  from a crash mid-write — also covered.
