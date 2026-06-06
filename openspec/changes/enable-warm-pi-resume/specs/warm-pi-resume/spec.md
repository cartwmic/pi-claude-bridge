# Capability: warm-pi-resume

Validated reattachment of the prior `claude` driver session across a pi
restart/resume, replacing the unconditional cold-start. Cold-start (re-packing
pi's full history per `buildColdStartPrompt`) remains the guaranteed fallback.
Constrained by Domain invariant 1 (one in-flight main turn), invariant 3 (driver
session id is a cache hint), and constitution Principle I (pi owns history) and
Principle III (no `~/.claude/` writes).

## ADDED Requirements

### Requirement: Resume Sidecar Persisted On Successful Turn

WHEN the main-provider turn (not a subagent turn) completes without error — including the abort path, so an aborted-mid-tool session stays resumable per R7 — THE bridge SHALL persist a resume sidecar — driver session id, the literal cwd claude-p was spawned with (`spawnCwd`), the full pi `sessionId`, the pi message-history fingerprint chain, and the `claude` version — to a bridge-owned location outside `~/.claude/`, keyed by the literal spawn cwd + the full pi `sessionId`.

#### Scenario: Successful turn writes the sidecar
- **WHEN** the main-provider turn finalizes with a non-error stop reason and a cached driver session id
- **THEN** a sidecar file outside `~/.claude/` records that driver session id, the literal spawn cwd, the full pi session id, the history fingerprint chain, and the claude version

#### Scenario: A subagent turn does not write the sidecar
- **WHEN** a subagent frame (not the top-of-stack main-provider turn) finalizes
- **THEN** no resume sidecar is written for it — only the main-provider turn's session is recorded, so a later resume reattaches the main session and not a subagent's

#### Scenario: Sidecar write failure does not break the turn
- **IF** writing the sidecar fails (I/O error, permissions)
- **THEN** the bridge SHALL log the failure and complete the turn normally, leaving the next resume to cold-start

### Requirement: Sidecar Stores No Conversation Content

THE resume sidecar SHALL contain only fingerprints and identifiers and SHALL NOT contain any user, assistant, thinking, or tool message content, per constitution Principle I (the bridge persists no conversation history of its own). The history fingerprint chain SHALL be a one-way digest (e.g. `sha256` per message position) from which no message plaintext can be recovered — NOT the in-memory `hashMessage` value, which embeds verbatim content substrings.

#### Scenario: Sidecar contains no message text
- **WHEN** the sidecar is inspected after any turn (including one whose messages contain a known sentinel string)
- **THEN** it contains opaque digests, ids, cwd, and version only — no message bodies, tool arguments, tool results, or counters — and NO substring of any input message (the sentinel does not appear)

### Requirement: Validated Warm Resume On Pi Resume

WHEN the first post-resume turn runs (the first turn after a `session_start:resume` or a bare bridge restart whose in-memory cache is empty but a sidecar is present) AND a sidecar exists for the current literal cwd + full pi `sessionId` AND pi's loaded history is a prefix-extension of the sidecar's fingerprint chain AND the sidecar's `claude` version equals the current `claude` version AND the recorded transcript is confirmed present, THE bridge SHALL warm-resume the recorded driver session (`--resume <persisted-id>`) for that turn instead of cold-starting. The keyed validation is performed at turn-start (where the literal spawn cwd is known), NOT in the `session_start` handler (which carries no cwd).

#### Scenario: Valid sidecar drives a warm first turn
- **WHEN** the first post-resume turn runs and the sidecar validates (history prefix-match, version match, transcript present)
- **THEN** that turn spawns `claude-p` with `--resume <persisted-id>` and types only the new user message (not the full history)

### Requirement: Cold Start When Validation Does Not Pass

WHEN no sidecar exists for the key, OR pi's loaded history is not a prefix-extension of the sidecar fingerprint chain, OR the sidecar `claude` version differs from the current version, THE bridge SHALL cold-start the first post-resume turn (the current `buildColdStartPrompt` behavior) as a **normal turn** (not an error) and SHALL NOT pass `--resume`.

#### Scenario: Divergent history falls back to cold
- **WHEN** the resumed pi history differs at any prior position from the sidecar chain (e.g. after `/compact` between sessions)
- **THEN** the bridge cold-starts a normal turn and discards the stale sidecar

#### Scenario: Version skew falls back to cold
- **WHEN** the sidecar records a `claude` version different from the installed one
- **THEN** the bridge cold-starts a normal turn (the on-disk transcript format may be incompatible)

### Requirement: Cold Start On Unreadable Or Unconfirmable Sidecar State

IF the sidecar is unreadable or malformed, OR the recorded `claude` transcript cannot be confirmed present (the existence check encodes the sidecar's literal `spawnCwd`, matching how `claude` names the project dir), THEN THE bridge SHALL cold-start the first post-resume turn as a normal turn and SHALL NOT pass `--resume`.

#### Scenario: Unconfirmable transcript falls back to cold (fail-closed)
- **IF** the sidecar otherwise validates but the recorded `claude` session transcript cannot be confirmed to exist (encoded from `spawnCwd`)
- **THEN** the bridge cold-starts and does NOT pass `--resume` — preventing a silent context-free fresh session (the case where `claude --resume <missing>` would start clean rather than error, which the post-spawn stale guard cannot catch because the live turn does run)

#### Scenario: Corrupt sidecar falls back to cold
- **IF** the sidecar file is present but unreadable or malformed (e.g. a torn concurrent write)
- **THEN** the bridge cold-starts and discards the unusable sidecar

### Requirement: Post-Spawn Stale-Result Guard

WHILE serving a warm-resume turn that ends cleanly (stop reason `result`), IF the driver reports the live turn did not run — a replay boundary was seen but no live user prompt followed it (the driver's `staleSuspected` condition) — THEN THE bridge SHALL discard the resumed output, drop the cached session AND the persisted sidecar, and cold-start a retry. THE bridge SHALL NOT apply this guard to a turn whose stop reason is `aborted` or `error` (the diagnostic also fires at end-of-stream on a user-abort and would otherwise false-positive).

#### Scenario: Stale replay is caught and retried
- **IF** a warm-resume spawn ends with stop reason `result` having replayed the prior terminal state with no live prompt after the final replay boundary (the prior turn's result was latched)
- **THEN** the bridge discards that result, clears the cache, and re-runs the turn as a cold-start

#### Scenario: A healthy warm turn is delivered, not discarded
- **WHEN** a warm-resume turn ends with stop reason `result` and a live prompt followed the replay boundary (`staleSuspected` is false)
- **THEN** the bridge delivers the warm result and does NOT cold-retry (pinning the no-false-positive direction — an implementation that cold-retries every warm turn must fail this)

#### Scenario: An aborted warm turn is NOT treated as stale
- **WHEN** a warm-resume turn is user-aborted (stop reason `aborted`) and the end-of-stream diagnostic reports `staleSuspected` true
- **THEN** the bridge does NOT treat it as a stale replay — it commits the aborted partial as today and does not force a cold-retry

### Requirement: Sidecar Invalidated On Turn Error

IF a turn errors — including a gated `McpNotReady` attempt that never submitted the prompt — THEN THE bridge SHALL invalidate the persisted sidecar for the current key so a later resume cold-starts cleanly, keeping the persisted hint consistent with the in-memory cache (which is cleared on error).

#### Scenario: Errored turn drops the sidecar
- **IF** a turn finalizes with an error stop reason
- **THEN** the sidecar for the current literal spawn cwd + full pi `sessionId` is deleted or marked stale, and the next resume cold-starts

#### Scenario: A gated (never-submitted) attempt leaves no resumable sidecar
- **WHEN** an attempt fails fast with `McpNotReady` before submitting the prompt (the readiness-gate path)
- **THEN** no sidecar is persisted for that turn (the error path invalidates), so a later warm resume cannot replay a poisoned or empty transcript

### Requirement: Divergence Baseline Rehydrated On Warm Resume

WHEN the bridge warm-resumes from a sidecar, THE bridge SHALL set its in-memory divergence baseline by recomputing the in-memory message-hash chain over pi's loaded history (NOT from the persisted sidecar chain, which is a one-way digest in a different format) so that subsequent in-process turns detect history divergence correctly.

#### Scenario: Next in-process turn detects a fork after warm resume
- **WHEN** a warm resume succeeds and the user then `/fork`s within the same process
- **THEN** the bridge detects divergence against the recomputed in-memory baseline and cold-starts that turn

### Requirement: Aborted-Mid-Tool Sessions Remain Resumable (provisional pending spike T0.2)

WHERE the recorded driver transcript ends with an unclosed tool call from a turn that was aborted mid-tool, THE bridge SHALL still warm-resume it and SHALL NOT cold-start solely because of the unclosed tool call, relying on the driver's request-construction repair of the dangling tool call. NOTE: this requirement is **provisional** — it is proven only via `claude` direct, not the full `claude-p` + `suppressResumeReplay` path. If spike T0.2 shows the driver does NOT self-repair through that path, this requirement INVERTS: a dangling tool call becomes a cold-start trigger (moved into "Cold Start On Unreadable Or Unconfirmable Sidecar State"). It MUST NOT be treated as settled before T0.2.

#### Scenario: Dangling tool call does not block warm resume (subject to T0.2)
- **WHEN** the prior turn was aborted while a bridged tool was held (leaving a dangling tool call in the driver transcript) and the sidecar otherwise validates
- **THEN** the bridge warm-resumes and the driver proceeds with the new turn without error (if T0.2 falsifies this, the bridge cold-starts instead)

### Requirement: Warm Path Performs No New Claude Config Access

THE warm-resume path SHALL NOT write any path under `~/.claude/` and SHALL NOT read the CONTENT of any `~/.claude/` transcript; its only `~/.claude/` access is an existence `stat` of the bridge-derived deterministic transcript path, permitted by the amended Principle III(b) (which this change widens to cover a session id the bridge recorded in its own prior-session sidecar, and to permit existence-only stats). Reattachment is effected by passing `--resume` to the driver, which performs any transcript read itself.

#### Scenario: Warm resume touches only the bridge's own state
- **WHEN** a warm resume runs
- **THEN** the only files the bridge reads or writes are its own sidecar (outside `~/.claude/`) plus, for the fail-closed transcript check (R4), an existence `stat` (no content read) of the deterministic transcript path encoded from the sidecar's `spawnCwd` — permitted by the amended Principle III(b); it passes `--resume` to `claude-p` for the driver-side transcript read

---

## Acceptance criterion quality checklist

| AC ID | Testable | Solution-free | Unambiguous | Consistent | Complete |
|---|---|---|---|---|---|
| warm-pi-resume.resume-sidecar-persisted-on-successful-turn | [x] | [x] | [x] | [x] | [x] |
| warm-pi-resume.sidecar-stores-no-conversation-content | [x] | [x] | [x] | [x] | [x] |
| warm-pi-resume.validated-warm-resume-on-pi-resume | [x] | [x] | [x] | [x] | [x] |
| warm-pi-resume.cold-start-when-validation-does-not-pass | [x] | [x] | [x] | [x] | [x] |
| warm-pi-resume.cold-start-on-unreadable-or-unconfirmable-sidecar-state | [x] | [x] | [x] | [x] | [x] |
| warm-pi-resume.post-spawn-stale-result-guard | [x] | [x] | [x] | [x] | [x] |
| warm-pi-resume.sidecar-invalidated-on-turn-error | [x] | [x] | [x] | [x] | [x] |
| warm-pi-resume.divergence-baseline-rehydrated-on-warm-resume | [x] | [x] | [x] | [x] | [x] |
| warm-pi-resume.aborted-mid-tool-sessions-remain-resumable | [x] | [x] | [x] | [x] | [~] provisional pending spike T0.2 (may invert to a cold trigger) |
| warm-pi-resume.warm-path-performs-no-new-claude-config-access | [x] | [x] | [x] | [x] | [x] |
