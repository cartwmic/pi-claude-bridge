# warm-pi-resume Specification

## Purpose
Content-free, driver-typed resume hints that preserve warm Claude sessions across Pi restarts while keeping Pi history canonical and falling back safely to cold replay.
## Requirements
### Requirement: Resume Sidecar Persisted On Successful Turn

WHEN main-provider turn (not nested subagent) completes without error, including abort only after direct turn acceptance is proven by its first top-level model `message_start` (interactive abort behavior unchanged), THE bridge SHALL persist content-free sidecar outside `~/.claude/`, keyed by literal cwd + full pi session id, containing driver identity, driver session id, one-way history fingerprint chain, and Claude version. IF direct invocation aborts before user-frame submission, THEN THE bridge SHALL preserve any prior validated hint unchanged. IF it aborts after submission but before turn acceptance, THEN THE bridge SHALL invalidate the possibly mutated direct session hint/sidecar and force the next turn to canonical cold start. Neither path advances current history boundary or persists a fresh driver session id.

#### Scenario: Successful turn writes typed sidecar
- **WHEN** main-provider turn finalizes non-error with cached session id
- **THEN** sidecar records selected driver, session id, fingerprint chain, and Claude version

#### Scenario: Subagent does not write sidecar
- **WHEN** nested frame finalizes
- **THEN** no main-session sidecar is replaced by child session

#### Scenario: Sidecar write failure does not break turn
- **IF** sidecar write fails
- **THEN** bridge logs failure, completes turn normally, and later resume cold-starts

#### Scenario: Abort before direct prompt submission
- **WHEN** caller aborts while direct invocation still waits for MCP readiness
- **THEN** no new session hint is cached or persisted and current history fingerprint is not marked as seen
- **AND** any prior validated hint remains unchanged

#### Scenario: Abort after write but before direct turn acceptance
- **WHEN** user frame write completes but caller aborts before first top-level model `message_start`
- **THEN** any prior/fresh direct session hint and active sidecar are invalidated and current history fingerprint is not marked as seen
- **AND** next turn uses full canonical cold start

### Requirement: Sidecar Stores No Conversation Content

THE resume sidecar SHALL contain only fingerprints and identifiers and SHALL NOT contain any user, assistant, thinking, or tool message content, per constitution Principle I (the bridge persists no conversation history of its own). The history fingerprint chain SHALL be a one-way digest (e.g. `sha256` per message position) from which no message plaintext can be recovered — NOT the in-memory `hashMessage` value, which embeds verbatim content substrings.

#### Scenario: Sidecar contains no message text
- **WHEN** the sidecar is inspected after any turn (including one whose messages contain a known sentinel string)
- **THEN** it contains opaque digests, ids, and version only — no message bodies, tool arguments, tool results, or counters — and NO substring of any input message (the sentinel does not appear)

### Requirement: Validated Warm Resume On Pi Resume

WHEN first post-resume turn after `session_start:resume` or bare bridge restart with empty in-memory cache has a sidecar for literal cwd + full pi session id whose history chain is a safe prefix-extension, appended material contains only new turn messages, Claude version matches, and sidecar driver matches selected driver, THE bridge SHALL warm-resume that selected driver with recorded session id; validation occurs at turn start, not session-start handler.

#### Scenario: Valid same-driver sidecar
- **WHEN** sidecar validates and driver identity matches current selection
- **THEN** selected driver resumes recorded id and receives only new user material

#### Scenario: Unseen intervening messages
- **IF** loaded history contains messages recorded driver never saw
- **THEN** bridge cold-starts rather than silently omitting them

#### Scenario: Missing external transcript
- **IF** driver reports recorded session absent
- **THEN** error surfaces, hint/sidecar invalidate, and next turn cold-starts without bridge pre-reading `~/.claude/`

### Requirement: Cold Start When Validation Does Not Pass

WHEN no sidecar exists for the key, OR pi's loaded history is not a prefix-extension of the sidecar fingerprint chain, OR the sidecar `claude` version differs from the current version, THE bridge SHALL cold-start the first post-resume turn (the current `buildColdStartPrompt` behavior) as a **normal turn** (not an error) and SHALL NOT pass `--resume`.

#### Scenario: Divergent history falls back to cold
- **WHEN** the resumed pi history differs at any prior position from the sidecar chain (e.g. after `/compact` between sessions)
- **THEN** the bridge cold-starts a normal turn and discards the stale sidecar

#### Scenario: Version skew falls back to cold
- **WHEN** the sidecar records a `claude` version different from the installed one
- **THEN** the bridge cold-starts a normal turn (the on-disk transcript format may be incompatible)

### Requirement: Cold Start On Unreadable Or Malformed Sidecar

IF the sidecar is unreadable or malformed, THEN THE bridge SHALL cold-start the first post-resume turn as a normal turn and SHALL NOT pass `--resume`.

#### Scenario: Corrupt sidecar falls back to cold
- **IF** the sidecar file is present but unreadable or malformed (e.g. a torn concurrent write)
- **THEN** the bridge cold-starts and discards the unusable sidecar

### Requirement: Driver Guarantees A Live-Resume Result (no bridge-side stale guard)

THE warm-resume path SHALL rely on selected driver's live-result guarantee: `claude-p` uses transcript-growth gate and `claude-print` uses the fresh terminal result for the submitted stream-json user turn. THE bridge SHALL not add stale-result heuristic or discard/retry; driver refusal surfaces and invalidates hints.

#### Scenario: Warm turn returns live answer
- **WHEN** selected driver completes resumed turn with authoritative result
- **THEN** bridge delivers it without bridge-side staleness re-check

#### Scenario: Driver refuses live turn
- **IF** selected driver cannot produce authoritative live result
- **THEN** error surfaces, cache/sidecar invalidate, and next turn cold-starts

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

### Requirement: Aborted-Mid-Tool Sessions Remain Resumable

WHERE selected-driver session ends with an unclosed tool call after abort or crash and sidecar otherwise validates, THE bridge SHALL warm-resume the same driver and SHALL not cold-start solely because of dangling call; selected driver SHALL repair or close the dangling call and return the new live turn.

#### Scenario: Interactive dangling call
- **WHEN** interactive session has dangling tool call and sidecar validates
- **THEN** `claude-p` resume proceeds under existing proven repair behavior

#### Scenario: Direct dangling call
- **WHEN** direct session is aborted mid-held-tool and sidecar validates
- **THEN** retained live integration evidence proves direct resume repairs/closes dangling call and produces new live answer

### Requirement: Warm Path Performs No New Claude Config Access

THE warm-resume path SHALL only access bridge-owned sidecar outside `~/.claude/`, pass resume id to selected driver, and SHALL not read, stat, or write Claude config/transcript paths itself.

#### Scenario: Warm resume touches bridge state only
- **WHEN** either driver warm-resumes
- **THEN** bridge accesses only its sidecar and process protocol, never `~/.claude/`

### Requirement: Resume Sidecar Records Driver Identity

WHEN resumable main-provider turn persists a sidecar, THE bridge SHALL record driver identity alongside opaque session id, history fingerprint chain, and Claude version without conversation content.

#### Scenario: Direct turn writes typed sidecar
- **WHEN** resumable direct main turn completes non-error
- **THEN** sidecar records `claude-print` and direct session id

#### Scenario: Legacy sidecar has no driver
- **WHEN** existing sidecar lacks driver field
- **THEN** bridge interprets it as `claude-p`

### Requirement: Cross-Driver Warm Resume Is Forbidden

IF persisted or in-memory hint driver differs from selected driver, THEN THE bridge SHALL invalidate hint and cold-start selected driver normally.

#### Scenario: Interactive to direct
- **IF** `claude-p` hint exists and current selection is `claude-print`
- **THEN** direct does not receive interactive id and cold-starts with pi history

#### Scenario: Direct to interactive
- **IF** direct hint exists and current selection is `claude-p`
- **THEN** interactive does not receive direct id and cold-starts normally

---
