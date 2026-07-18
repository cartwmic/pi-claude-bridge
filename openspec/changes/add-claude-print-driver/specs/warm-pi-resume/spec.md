# Capability: warm-pi-resume

<!-- authored: in-session -->

## MODIFIED Requirements

### Requirement: Resume Sidecar Persisted On Successful Turn

WHEN main-provider turn (not nested subagent) completes without error, including abort, THE bridge SHALL persist content-free sidecar outside `~/.claude/`, keyed by literal cwd + full pi session id, containing driver identity, driver session id, one-way history fingerprint chain, and Claude version.

#### Scenario: Successful turn writes typed sidecar
- **WHEN** main-provider turn finalizes non-error with cached session id
- **THEN** sidecar records selected driver, session id, fingerprint chain, and Claude version

#### Scenario: Subagent does not write sidecar
- **WHEN** nested frame finalizes
- **THEN** no main-session sidecar is replaced by child session

#### Scenario: Sidecar write failure does not break turn
- **IF** sidecar write fails
- **THEN** bridge logs failure, completes turn normally, and later resume cold-starts

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

### Requirement: Driver Guarantees A Live-Resume Result (no bridge-side stale guard)

THE warm-resume path SHALL rely on selected driver's live-result guarantee: `claude-p` uses transcript-growth gate and `claude-print` uses the fresh terminal result for the submitted stream-json user turn. THE bridge SHALL not add stale-result heuristic or discard/retry; driver refusal surfaces and invalidates hints.

#### Scenario: Warm turn returns live answer
- **WHEN** selected driver completes resumed turn with authoritative result
- **THEN** bridge delivers it without bridge-side staleness re-check

#### Scenario: Driver refuses live turn
- **IF** selected driver cannot produce authoritative live result
- **THEN** error surfaces, cache/sidecar invalidate, and next turn cold-starts

### Requirement: Warm Path Performs No New Claude Config Access

THE warm-resume path SHALL only access bridge-owned sidecar outside `~/.claude/`, pass resume id to selected driver, and SHALL not read, stat, or write Claude config/transcript paths itself.

#### Scenario: Warm resume touches bridge state only
- **WHEN** either driver warm-resumes
- **THEN** bridge accesses only its sidecar and process protocol, never `~/.claude/`

### Requirement: Aborted-Mid-Tool Sessions Remain Resumable

WHERE selected-driver session ends with an unclosed tool call after abort or crash and sidecar otherwise validates, THE bridge SHALL warm-resume the same driver and SHALL not cold-start solely because of dangling call; selected driver SHALL repair or close the dangling call and return the new live turn.

#### Scenario: Interactive dangling call
- **WHEN** interactive session has dangling tool call and sidecar validates
- **THEN** `claude-p` resume proceeds under existing proven repair behavior

#### Scenario: Direct dangling call
- **WHEN** direct session is aborted mid-held-tool and sidecar validates
- **THEN** retained live integration evidence proves direct resume repairs/closes dangling call and produces new live answer

## ADDED Requirements

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

## Acceptance criterion quality checklist

| AC ID | Testable | Solution-free | Unambiguous | Consistent | Complete |
|---|---|---|---|---|---|
| warm-pi-resume.resume-sidecar-persisted-on-successful-turn | [x] | [x] | [x] | [x] | [x] |
| warm-pi-resume.validated-warm-resume-on-pi-resume | [x] | [x] | [x] | [x] | [x] |
| warm-pi-resume.driver-guarantees-a-live-resume-result-no-bridge-side-stale-guard | [x] | [x] | [x] | [x] | [x] |
| warm-pi-resume.warm-path-performs-no-new-claude-config-access | [x] | [x] | [x] | [x] | [x] |
| warm-pi-resume.aborted-mid-tool-sessions-remain-resumable | [x] | [x] | [x] | [x] | [x] |
| warm-pi-resume.resume-sidecar-records-driver-identity | [x] | [x] | [x] | [x] | [x] |
| warm-pi-resume.cross-driver-warm-resume-is-forbidden | [x] | [x] | [x] | [x] | [x] |
