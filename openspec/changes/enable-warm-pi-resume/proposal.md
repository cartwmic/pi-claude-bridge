## Why

On every pi resume/restart the bridge cold-starts: it re-packs the *entire*
conversation into one large typed prompt (`buildColdStartPrompt`). That is slow,
lossy (text-only; tool args/results truncated; images dropped), expensive
(re-caches the whole context on a fresh driver session), and — until the recent
claude-p paste-collapse fix — a hard failure on long sessions. The underlying
`claude` session already persists on disk and *could* be reattached. Why now:
the paste-collapse incident exposed cold-start-on-resume as the costly, fragile
path users hit most (every resume; every post-error turn).

## What Changes

- Persist a minimal, **content-free resume sidecar** (driver session id + a pi
  message-history fingerprint chain — a **one-way digest** per message, no
  recoverable plaintext — + the `claude` version), keyed by
  the **literal** spawn cwd + the **full** pi `sessionId`, stored OUTSIDE `~/.claude/`
  (under `~/.pi/agent/`). It stores fingerprints, **never conversation content**.
- On `session_start:resume`, validate the sidecar against pi's freshly-loaded
  history (prefix-match) and the current `claude` version; if valid, **warm-resume**
  the prior `claude` session (`--resume`) instead of cold-starting.
- Fix the `--resume` **stale-result race at the source in the `claude-p` fork**
  (a transcript-growth gate: claude-p emits a result only once the transcript
  shows the live turn appended a new assistant turn past a pre-submit baseline;
  a Stop before submit, or one with no transcript growth, never yields a result).
  The bridge **trusts claude-p's result** — no bridge-side stale detection or
  discard/cold-retry. Spiked + proven (`.spike-notes/claude-p-gate/resume-staleness-gate-*`).
- **Cold-start is the floor** whenever warm isn't applicable (no/invalid sidecar,
  history divergence, version skew) — a normal turn, not a retry. Net: warm resume
  never produces a worse-than-cold *result*. (Honest caveat: a warm attempt that
  ERRORS — e.g. a deleted transcript (`claude --resume <missing>` errors, T0.1) or
  the fork gate refusing — surfaces that error on the current turn (visible) and
  the next turn cold-starts; the failed warm path is NOT silently re-run cold
  in-turn, so it costs one errored turn vs. a clean cold-start. Correctness +
  visibility, not latency, are the floor.)
- **CONSTITUTION + DOMAIN (BREAKING):** (1) amends Principle I ("MUST NOT persist
  conversation history of its own") to permit content-free resume *metadata*;
  (2) amends Domain invariant 3 — `domain.md:40-43` today makes `restart` an
  unconditional cold-start trigger, which this change reverses for the validated
  case ("restart **without a validated resume sidecar** → cold"). **Principle III
  is UNCHANGED** — the warm path adds no new `~/.claude` access (`--resume`
  delegates the transcript read to `claude-p`); the fail-closed existence `stat`
  was dropped after T0.1 showed `claude --resume <missing>` already errors.
- **No external dependency on a separate stale-result enforcement change.** The
  fork-level transcript-growth gate IS the enforcement, and it covers EVERY
  `--resume` turn at the source — so the prior "Thread B" dependency and the C5
  sequencing question are **dissolved**. The only sequencing requirement is
  trivial: land the fork gate + bump the bridge's claude-p pin before the bridge
  starts warm-resuming.
- **Preserves** the no-poison-perpetuation property established by the recent
  MCP-readiness gate (commit `275dde9`): a lost MCP-attach race used to make a
  warm `--resume` retry replay a tool-less, leaked-text transcript ("coldstart
  perpetuation"). That is now fixed at source (a gated attempt fails fast with
  `McpNotReady` and never submits, so it never poisons the transcript). This
  change must keep that guarantee across restarts — a failed/gated turn is an
  error, so it persists no sidecar (and invalidates any existing one), and can
  never warm-resume a poisoned transcript.

## Capabilities

### New Capabilities
- `warm-pi-resume`: persist + validate driver-session reattachment across a pi
  restart/resume, with cold-start as the guaranteed fallback.

### Modified Capabilities
- `claude-p-driver`: the session-cache lifecycle gains a persisted, validated
  warm path on `session_start:resume` (today that event unconditionally clears
  the cache and forces cold-start).

## Impact

**Affected files**
- `index.ts`: `cachedSessionId`/`cachedSessionCwd`/`lastSentMessageHashes`
  lifecycle (decls `index.ts:290`/`291`/`303`), the `session_start` handler
  (`clearSession` dispatch `index.ts:1701`), `finalizeClaudePFrame`
  (`index.ts:1371` — persist sidecar on success alongside the cache set at
  `index.ts:1402`, beside the existing `.ready`-sentinel cleanup), divergence
  baseline rehydration on resume.
- new module (e.g. `src/resume-store.ts`): sidecar read/write under `~/.pi/agent/`,
  keyed by the **literal** spawn cwd + full `sessionId` (no realpath); atomic
  (temp+rename) writes; content-free one-way (`sha256`) fingerprint chain.
- **`claude-p` fork** (`src/driver.zig` + `src/transcript.zig`): the transcript-growth
  gate (state gate on `.stop` + `num_turns > baseline` before emitting a result).
  Spiked on branch `spike/resume-staleness-gate`; land on claude-p `main` + bump
  the bridge's claude-p pin. NO bridge-side stale plumbing is needed.
- `openspec/constitution.md`: amend Principle I (Principle III unchanged).
- `openspec/domain.md`: amend Domain invariant 3 (restart no longer unconditional cold).

**Dependencies / systems**
- Dependency: the `claude-p` fork's transcript-growth gate (spiked) must land on
  claude-p `main` + be repinned before the bridge warm-resumes. No separate
  "stale-result enforcement" change and no C5 sequencing (the fork gate covers
  all `--resume` turns at the source).
- `claude` upgrade transcript-format skew → version-gated invalidation.
- Out of scope: the capture path (always single-shot, never resumes) and the
  persistent-process driver (orthogonal; composable later).
