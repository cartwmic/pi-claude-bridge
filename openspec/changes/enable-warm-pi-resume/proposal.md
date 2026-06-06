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
- Add a **post-spawn stale-result guard** (the driver's `staleSuspected`
  live-turn-ran signal — replay boundary seen but no live prompt after it) before
  trusting the resumed turn; on stale → discard → cold-retry.
- **Cold-start remains the always-safe fallback** on any missing/invalid sidecar,
  history divergence, version skew, or stale detection. Net: warm resume never
  produces a worse-than-cold *result*. (One honest caveat: a failed warm attempt
  does extra spawn+detect work before cold-retrying, so it is *slower* than a
  direct cold-start; correctness, not latency, is the floor. A deleted transcript
  is a rare exception — it surfaces as one errored turn before the next cold turn,
  since `claude --resume <missing>` errors (T0.1).)
- **CONSTITUTION + DOMAIN (BREAKING):** (1) amends Principle I ("MUST NOT persist
  conversation history of its own") to permit content-free resume *metadata*;
  (2) amends Domain invariant 3 — `domain.md:40-43` today makes `restart` an
  unconditional cold-start trigger, which this change reverses for the validated
  case ("restart **without a validated resume sidecar** → cold"). **Principle III
  is UNCHANGED** — the warm path adds no new `~/.claude` access (`--resume`
  delegates the transcript read to `claude-p`); the fail-closed existence `stat`
  was dropped after T0.1 showed `claude --resume <missing>` already errors.
- **Depends on** the separate stale-result enforcement work — warm resume rides
  the same `--resume` replay mechanism that the stale-result bug affects. Land it
  first or together (default). Proceeding standalone on only the per-resume guard
  is permissible ONLY after that guard is made load-bearing — i.e. the D5
  discriminator is corrected to `staleSuspected` AND the signal is plumbed onto
  `ClaudePDoneResult` (today it is detection-only). This reconciles the proposal's
  "hard dependency" with Clarify C5 option (c): standalone is conditional, not a
  free escape hatch. Owner decision at apply (C5).
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
- `src/driver/claudeP.ts` + `src/driver/stream.ts`: surface the `staleSuspected`
  stale-turn signal onto `ClaudePDoneResult` (today detection-only via
  `onResumeDiag`) so the bridge can enforce the D5 guard.
- `openspec/constitution.md`: amend Principle I (Principle III unchanged).
- `openspec/domain.md`: amend Domain invariant 3 (restart no longer unconditional cold).

**Dependencies / systems**
- Dependency: stale-result enforcement change — land first/together by default;
  standalone only after the per-resume guard is corrected + plumbed (see What
  Changes; Clarify C5).
- `claude` upgrade transcript-format skew → version-gated invalidation.
- Out of scope: the capture path (always single-shot, never resumes) and the
  persistent-process driver (orthogonal; composable later).
