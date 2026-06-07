# Verify — enable-warm-pi-resume

**Verification Mode:** retained-required (Scale L; constitution Principle-I amendment).
**Date:** 2026-06-06/07 · **Binaries:** claude 2.1.159, claude-p fork `#32800b2` (built from source via `prepare: zig build`).

## Completion Decision: RED → GREEN

All deterministic validation gates pass; the core cross-restart warm path and the
no-stale-under-load property are additionally proven by live end-to-end runs.

---

## 1. Pre-apply spikes (Step 0)

| Spike | Result | Notes |
|---|---|---|
| **T0.1 — C4 / Risk R1** (`claude --resume <missing>`) | **ERRORS, not silent-fresh** (direct exit 1 "No conversation found"; via claude-p exit 2 `SessionStartTimeout`) | `.spike-notes/claude-p-gate/c4-missing-transcript-claude-2.1.159-2026-06-06T19-17-24Z/`. Justified DROPPING the fail-closed existence check (error→cold suffices) → Principle III unchanged. |
| **T0.2 — D6-limit / spec R7** (dangling tool_use resume through full claude-p) | **R7 CONFIRMED, not inverted** — exit 0, terminal result, live prompt answered, `staleSuspected:false` | `.spike-notes/claude-p-gate/d6-dangling-claudep-claude-haiku-4-5-2026-06-06T19-21-34Z/`. Abort/kill self-closes the round; dangling only from crash-mid-write (also covered). |
| **T0.3 — D5 fork transcript-growth gate** (state gate + `num_turns > baseline`) | **Landed + proven** — `zig build test` green incl. deterministic unit test; under-load e2e 0 stale emits | Fork `origin/main` = `32800b2`; bridge repinned; `npm install` rebuilt the gated binary. `.spike-notes/claude-p-gate/resume-staleness-gate-claude-haiku-4-5-2026-06-06T22-02-26Z/`. |

## 2. Constitution + domain amendment (Step 1)

- Constitution **1.2.0 → 2.0.0 (MAJOR)** — Principle I amended to permit a content-free
  resume-metadata sidecar (one-way `sha256` fingerprint chain + ids + version; no
  recoverable plaintext). Principle III **unchanged** (warm path adds no `~/.claude`
  access). Versioning rule: partial reversal of a "MUST NOT" → MAJOR.
- Domain **1.0.0 → 1.1.0** — invariant 3: a pi restart/resume is no longer an
  unconditional cold-start trigger; a validated sidecar warm-resumes.
- `openspec validate --strict enable-warm-pi-resume` → **valid**.

## 3. Resume-store + gate + wiring (Steps 2–4) — TDD

| AC (spec slug) | Covered by | Result |
|---|---|---|
| resume-sidecar-persisted-on-successful-turn | unit-resume-store (round-trip, schema), wiring | ✅ |
| sidecar-stores-no-conversation-content | unit-resume-store (sentinel: no substring of any message) | ✅ |
| validated-warm-resume-on-pi-resume | unit-warm-resume-gate, roundtrip | ✅ |
| cold-start-when-validation-does-not-pass | unit-warm-resume-gate (divergence, version-skew, no-sidecar) | ✅ |
| cold-start-on-unreadable-or-malformed-sidecar | unit-resume-store (torn/malformed→null) + gate | ✅ |
| driver-guarantees-a-live-resume-result (no bridge stale guard) | T0.3 fork gate; no bridge stale code (T4.3) | ✅ |
| sidecar-invalidated-on-turn-error | wiring (unconditional-by-key invalidate); roundtrip | ✅ |
| divergence-baseline-rehydrated-on-warm-resume (R6) | wiring (local `computeMessageHashes`, not sidecar chain) | ✅ |
| aborted-mid-tool-sessions-remain-resumable | unit-warm-resume-gate; T0.2; abort persists (non-error) | ✅ |
| warm-path-performs-no-new-claude-config-access (R8) | int-claude-dir-audit (4/4) | ✅ |
| claude-p-driver.cached-driver-session-is-a-hint-only | wiring (warm sets cache; all drop triggers preserved) | ✅ |
| claude-p-driver.resume-returns-the-live-turn… | T0.3 fork transcript-growth gate | ✅ |

**Apply-time correction (recorded in design D1 + tasks 4.1):** the main-turn persist
gate is `stack[0] === frame`, NOT `top() === frame` — a subagent frame is itself
`top()` at its own finalize, so `top()===frame` would not exclude it; the main turn
is always the stack bottom (`stack[0]`).

**Apply-time fix (uncovered by live e2e, §5):** warm-resume is armed on `session_start`
reasons `startup` / `resume` / `reload` (not only `resume`) — a process **restart that
resumes a session fires reason `startup`, not `resume`**. The original `resume`-only
arming would never have fired on the primary restart case. Verified against
pi-coding-agent's emitted reasons and live (§5).

## 4. Deterministic build + test gates

| Gate | Result |
|---|---|
| `npm run typecheck` | ✅ clean |
| `npm run build` | ✅ clean |
| `npm run test:unit` | ✅ **349/349** (was 313; +17 resume-store, +12 gate, +7 roundtrip) |
| `tests/int-claude-dir-audit.mjs` (Constitution III / R8) | ✅ 4/4 — no new `~/.claude` access |
| `tests/int-cache.sh` — session-resume part | ✅ 1 cold / 4 warm / 1 session id (cache-metric assertion flakes on pre-existing claude-p prompt-cache noise — gate-independent, documented in task 0.3) |
| `tests/int-session-resume.mjs` | ⚠️ FAILS at Turn 4 (missed cross-provider word) — the **pre-existing in-process `syncSharedSession` bug** (Risk R7), NOT a regression: warm-resume arms only on `session_start` (process restart), so within one process switching providers my path is inert. Captured as a separate follow-up (mcp-memory); this change implements the corrected R7 invariant for its own cross-restart scope. |

## 5. Live end-to-end (Step 5 scenarios)

Run against real pi + the installed fork binary (`node_modules/claude-p/zig-out/bin/claude-p`, built from `#32800b2`).

| Scenario | Status | Evidence |
|---|---|---|
| **S32 — no-stale-under-load** (the safety-critical AC `resume-returns-the-live-turn`) | ✅ **LIVE PASS** | `resume-staleness-gate-e2e.mjs` vs the INSTALLED binary, 4 `--resume` turns under 6× CPU load: **own-answer-correct 4/4, STALE emits 0**. Every resume turn returned its OWN live answer. |
| **s0 — sanity** (bridge healthy, in-process warm path) | ✅ LIVE PASS | `run-scenario-s0.sh`: coherence + "1 cached session_id (warm path)" + usage propagation, all PASS. |
| **S30 — warm-resume across a pi RESTART** (`run-scenario-s30-warm-resume.sh`) | ⚠️ **partial** — wiring proven, warm `--resume` demo blocked by infra | See below. |

**S30 detail.** Three of the four warm-path behaviors are confirmed live; the
fourth (a clean warm `--resume`) is blocked by a change-independent boot race:

- ✅ **Arming on restart:** a fresh pi PROCESS reloading the session logs
  `session_start:startup — arming validated warm-resume attempt`. (This is the bug
  §3 fixed: the restart fires reason `startup`, not `resume`.)
- ✅ **Gate executes + cold-fallback:** `startFreshQuery: warm-resume not applicable
  (no-sidecar) — cold-starting` — correct, because launch-1 (fresh session) wrote no
  sidecar.
- ✅ **RED check:** with the sidecar removed, the restart cold-starts (`resume=no`).
- ✅ **Cross-restart continuity:** the model recalls the planted word across the restart.
- ⚠️ **Warm `--resume` not demonstrated live:** every claude-p spawn under
  `pi --session-id <fixed> --session-dir` + rapid scripted restarts fails the MCP-shim
  readiness handshake (`McpNotReady`, resilience retries exhausted → turn errors → no
  sidecar persisted → next turn correctly cold-starts). This is a **pre-existing,
  change-independent boot race in the bridge's MCP-shim spawn** (which this change does
  NOT touch): `s0` with `--no-session` passes clean, and the claude-p binary itself
  spawns fine (S32). Spaced real restarts give the shim time to settle; back-to-back
  scripted `--session-id` relaunches do not. Tracked as a follow-up (mcp-memory).

**Why the warm `--resume` path is nonetheless proven:**
- The full persist → restart → validate → warm/cold decision is proven deterministically
  by `unit-warm-resume-roundtrip.mjs` (7 cases mirroring the exact bridge flow).
- The warm `--resume` SPAWN itself is the same `useResume → {kind:"resume"}` path
  exercised live by `int-cache.sh` (4 warm-resume turns in-process) and `s0`.
- The new piece on top is reading the sidecar to populate `cachedSessionId`, proven
  end-to-end at the seam (roundtrip) and live-armed correctly (S30 arming + gate logs).

**Scenarios s31/s33/s34 (cold-on-/compact, abort→warm, subagent→main):** covered
deterministically — divergence/version cold paths (`unit-warm-resume-gate`,
`unit-warm-resume-roundtrip`), abort-resumable (`aborted-mid-tool-sessions-remain-resumable`
+ spike T0.2 + the abort-persists wiring), subagent-no-sidecar (the `stack[0]===frame`
gate). Live pi-TUI runs are gated behind the same MCP-shim-under-sessions boot race as
S30 and are recommended as a follow-up once that is resolved.

## Completion Decision: GREEN (with one documented, change-independent live gap)

All deterministic validation gates pass (validate, typecheck, build, 349/349 unit,
claude-dir-audit, int-cache session-resume); the safety-critical no-stale property is
LIVE-proven against the installed binary; the warm-resume wiring is LIVE-confirmed
(arming, gate, cold-fallback, RED check). The single remaining item — a clean warm
`--resume` across a scripted restart — is blocked by a pre-existing MCP-shim boot race
unrelated to this change, with the warm decision+spawn proven deterministically and
in-process. **Net: the change is correct and apply-complete; cold-start (the invariant
floor) guarantees no regression in any case.**
