# Capability: claude-p-driver (delta)

This delta tightens the driver's prompt-delivery guarantee now that the bridge
runs the patched (`claude-p-fork`) binary: a turn must not advance to awaiting
`Stop` until the prompt is confirmed delivered, and an unconfirmable prompt must
surface as a fast, retriable error rather than a `--timeout`-bounded silent
wedge. Only the "Prompt injection via claude-p input" requirement changes; all
other claude-p-driver requirements are unchanged and are not restated here.

## ADDED Requirements

### Requirement: Driver runs the patched claude-p binary

THE driver SHALL resolve and run the patched (`claude-p-fork`) binary for every spawn (main-provider and capture paths), and the bridge SHALL be able to confirm the resolved binary carries the patch. IF the resolved binary is the unpatched upstream build, THEN the bridge SHALL emit a warn-level log naming the mismatch rather than silently proceeding. The binary swap SHALL NOT introduce any write under `~/.claude/` (constitution III) and SHALL keep the native-tool disallow flags forwarded unchanged (constitution IV).

#### Scenario: Patched binary is used and verified
- **WHEN** the driver spawns claude-p on the main-provider or capture path
- **THEN** the executable run is the patched fork binary
- **AND** the bridge's identity check confirms the patch is present

#### Scenario: Stock-binary fallback is flagged
- **IF** the resolved binary is the unpatched upstream build
- **THEN** the bridge emits a warn-level log naming the mismatch (it does not silently proceed as if patched)

## MODIFIED Requirements

### Requirement: Prompt injection via claude-p input

WHEN a fresh claude-p subprocess is spawned for a pi user turn, THE driver SHALL deliver the pi user prompt to claude-p via its positional argument, `--input-file`, or stdin (text content). On cold-start (no cached driver session id), the delivered prompt carries the flattened pi history per the bridge's existing `buildColdStartPrompt` conversion contract. On warm-resume (cached driver session id valid), it carries only the new user message. For large or multiline prompts THE driver SHALL use `--input-file <path>` (a temp file under `os.tmpdir()`, cleaned up on subprocess exit) rather than the positional argument, to avoid argv limits and shell-escaping fragility.

WHEN claude-p injects the delivered prompt into the interactive `claude` session, THE driver SHALL confirm the prompt was accepted into the session before the turn advances to awaiting the `Stop` hook (per `claude-p-fork.echo-confirmed-prompt-commit`). IF the prompt cannot be confirmed accepted within the patched binary's bounded retype budget, THEN the driver SHALL surface a prompt-not-accepted error promptly (well before `--timeout`), and that error SHALL be retriable by the resilience layer (design D33) when no `tools/call` has been routed for the turn — i.e. a dropped prompt under concurrent-boot contention SHALL NOT manifest as a silent wedge bounded only by `--timeout`.

#### Scenario: Cold-start replay
- **WHEN** the driver starts a turn with no cached driver session id
- **THEN** claude-p receives the full pi history flattened to text per the bridge's existing conversion contract
- **AND** when that text exceeds the implementation-defined size threshold (default **50 KB**, conservative vs the ~256 KB macOS argv ceiling at which the historical spike saw the prompt silently dropped) it is delivered via `--input-file <tempfile>` rather than the positional argument
- **AND** that claude-p actually accepts `--input-file` (and `--system-prompt-file` if used) is gate **G-resume-flags** — verified through claude-p, not assumed from raw `claude`

#### Scenario: Warm-resume injection
- **WHEN** the driver starts a turn with a cached driver session id matching the current pi cwd and message-hash chain
- **THEN** claude-p is spawned with `--resume <cached-session-id>` (without `--session-id`)
- **AND** the delivered prompt contains only the new user message
- **AND** no historical pi messages are re-sent

#### Scenario: Prompt confirmed delivered before the turn proceeds
- **WHEN** the prompt is injected and accepted into the interactive session
- **THEN** the turn advances to await the `Stop` hook
- **AND** the bridge observes the normal turn lifecycle (stream events, then a terminal `result`)

#### Scenario: Dropped prompt surfaces fast, not as a wedge
- **IF** the injected prompt is not confirmed accepted within the patched binary's retype budget
- **THEN** the driver surfaces a prompt-not-accepted error well before `--timeout`
- **AND** when no `tools/call` has been routed, the resilience layer (D33) retries the spawn rather than the bridge waiting out the full `--timeout`

---

## Acceptance criterion quality checklist

| AC ID | Testable | Solution-free | Unambiguous | Consistent | Complete |
|---|---|---|---|---|---|
| claude-p-driver.driver-runs-the-patched-claude-p-binary | [x] | [x] | [x] | [x] | [x] |
| claude-p-driver.prompt-injection-via-claude-p-input | [x] | [x] | [x] | [x] | [x] |
