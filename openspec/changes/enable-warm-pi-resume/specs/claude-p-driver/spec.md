# Capability: claude-p-driver (delta)

Delta for `enable-warm-pi-resume`: the cached driver session is no longer a
purely in-memory hint that is unconditionally dropped on restart. It MAY be
persisted as a content-free fingerprint and validated for cross-restart warm
resume (see the `warm-pi-resume` capability). All other drop triggers are
preserved.

## MODIFIED Requirements

### Requirement: Cached driver session is a hint only

THE driver SHALL treat the cached driver session id as a cache hint. The hint MAY
be persisted across a process restart ONLY as a content-free fingerprint sidecar
per the `warm-pi-resume` capability (never as conversation content; constitution
Principle I). THE driver SHALL drop the cache and cold-start on cwd change, pi
history divergence (per the bridge's existing hash-chain check), `/fork`,
`/compact`, `claude` version skew, or any pi lifecycle event pi exposes as a
divergence signal. WHERE a validated resume sidecar exists on a pi
restart/resume (per `warm-pi-resume`), THE driver SHALL pass `--resume
<persisted-id>` for the first post-resume turn; otherwise (no sidecar, or
validation fails) THE driver SHALL cold-start.

#### Scenario: Cwd change drops cache
- **WHEN** a new turn arrives with `context.cwd` different from the cached cwd
- **THEN** the cached driver session id is cleared
- **AND** the next claude-p spawn does not pass `--resume`

#### Scenario: History divergence drops cache
- **WHEN** the bridge detects pi history-hash divergence at the start of a turn
- **THEN** the cached driver session id is cleared and a structured log entry records the drop

#### Scenario: Validated restart warm-resumes instead of cold-starting
- **WHEN** pi resumes a session for which a sidecar exists and validates (history prefix-match and matching `claude` version)
- **THEN** the first post-resume claude-p spawn passes `--resume <persisted-id>` and does NOT re-pack the full history

#### Scenario: Version skew on restart drops cache
- **IF** a sidecar exists on restart but its recorded `claude` version differs from the installed version
- **THEN** the cached session is dropped and the first post-resume turn cold-starts

## ADDED Requirements

### Requirement: Resume Returns The Live Turn, Never A Replayed Prior Turn

WHEN the driver serves a `--resume` turn, THE driver SHALL emit a result that reflects the LIVE turn only: it SHALL gate result emission on the transcript growing past a baseline captured before the live prompt is submitted (a new assistant turn must be appended), and SHALL ignore any Stop signal received before the live prompt is submitted. IF the transcript does not grow past the baseline (no live assistant turn appears), THEN THE driver SHALL return an error rather than a replayed prior-turn result, so the bridge cold-retries. (Source-level fix in the `claude-p` fork; this is why the bridge needs no stale-result detection of its own.)

#### Scenario: A replayed prior turn is never emitted as the resume result
- **WHEN** a `--resume` turn's transcript still ends at the prior turn (the live turn has not appended an assistant message) at the moment a Stop is observed
- **THEN** the driver does NOT emit the prior turn's answer — it waits for the live turn (transcript-growth gate), and if the live turn never appears it errors (the bridge then cold-retries)

#### Scenario: A Stop before submit is ignored
- **WHEN** a Stop hook signal arrives before the driver has submitted the live prompt (state is not awaiting-stop)
- **THEN** the driver ignores it (records only the transcript path) and does not treat it as the turn's completion

---

## Acceptance criterion quality checklist

| AC ID | Testable | Solution-free | Unambiguous | Consistent | Complete |
|---|---|---|---|---|---|
| claude-p-driver.cached-driver-session-is-a-hint-only | [x] | [x] | [x] | [x] | [x] |
| claude-p-driver.resume-returns-the-live-turn-never-a-replayed-prior-turn | [x] | [x] | [x] | [x] | [x] |
