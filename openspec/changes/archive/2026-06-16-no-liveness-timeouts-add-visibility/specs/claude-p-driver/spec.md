# Capability: claude-p-driver

Delta for the `no-liveness-timeouts-add-visibility` change. Removes the
wall-clock `--timeout` requirement and the bridge-side idle-watchdog liveness
mechanism; premature-exit-as-error plus caller-driven abort become the sole
recovery contract. Domain invariant 1 (one in-flight main turn) and the abort
contract (constitution VII; "no orphan subprocesses" S8) are preserved.

## MODIFIED Requirements

### Requirement: Unexpected driver exit surfaces as error

THE driver SHALL classify an unexpected claude-p exit as a retriable error: IF the claude-p subprocess exits with a non-success code while a turn is in flight and no terminal `result` line has been emitted on its stdout, OR IF claude-p emits an unrecoverable error (including `SessionStartTimeout`/`StopTimeout` reported by claude-p itself), THEN the driver SHALL — per the resilience layer (design D33) — bounded-retry by respawning (default ≤2
retries, short backoff, each logged at warn) since nothing was streamed to pi
yet; and ONLY after retries are exhausted SHALL it push an `error` event on the
active pi stream whose `errorMessage` names the exit cause and emit a structured
log entry. THE driver SHALL NOT retry SILENTLY (every retry logs) and SHALL NOT
retry once a `tools/call` has been routed to pi for this turn — because a
side-effecting tool may have already executed, a respawn+cold-replay would
re-run it; a failure after the first routed tool call falls through to the
abort/late-tool-result path (D15), not the retry path. (Streaming assistant text
alone does not block retry; routing a tool call does.) THE driver SHALL NOT
impose any bridge-side liveness timer or wall-clock cap on a spawn: a spawn that
produces no output is recovered ONLY by a real subprocess exit (classified
`error`) or by a caller-driven abort — never by a watchdog that guesses the
spawn is wedged.

#### Scenario: Transient claude-p hook-timeout is retried, not surfaced
- **WHEN** a claude-p spawn exits with `SessionStartTimeout`/`StopTimeout` (or non-zero without a terminal `result`) before any output reached pi
- **THEN** the driver respawns (bounded retries) and logs each attempt at warn
- **AND** pi sees a normal turn if a retry succeeds; only on exhausted retries does pi receive `stopReason: "error"`

#### Scenario: Driver binary missing
- **IF** `claude-p` (or the `claude` binary it requires) is not available at spawn time
- **THEN** the driver pushes an `error` event whose `errorMessage` references the missing binary
- **AND** `complete()` resolves with `stopReason === "error"`

#### Scenario: claude-p exits non-zero mid-turn
- **IF** the claude-p subprocess exits with a non-success, non-130 code while a turn is in flight and no terminal `result` line has been emitted
- **THEN** the driver pushes an `error` event whose `errorMessage` includes the exit code (e.g. 2 wrapper failure)
- **AND** any cached driver session id is cleared so the next turn cold-starts

#### Scenario: Silent spawn is not killed by a bridge timer
- **WHILE** a claude-p spawn has produced no stdout and no tool call has been routed
- **THEN** the bridge SHALL NOT terminate the spawn on any elapsed-time threshold
- **AND** the spawn remains recoverable only by a genuine subprocess exit or by pi's `AbortSignal`

### Requirement: Prompt injection via claude-p input

WHEN a fresh claude-p subprocess is spawned for a pi user turn, THE driver SHALL deliver the pi user prompt to claude-p via its positional argument, `--input-file`, or stdin (text content). On cold-start (no cached driver session id), the delivered prompt carries the flattened pi history per the bridge's existing `buildColdStartPrompt` conversion contract. On warm-resume (cached driver session id valid), it carries only the new user message. For large or multiline prompts THE driver SHALL use `--input-file <path>` (a temp file under `os.tmpdir()`, cleaned up on subprocess exit) rather than the positional argument, to avoid argv limits and shell-escaping fragility.

WHEN claude-p injects the delivered prompt into the interactive `claude` session, THE driver SHALL confirm the prompt was accepted into the session before the turn advances to awaiting the `Stop` hook (per `claude-p-fork.echo-confirmed-prompt-commit`). IF the prompt cannot be confirmed accepted within the patched binary's bounded retype budget, THEN the driver SHALL surface a prompt-not-accepted error promptly, and that error SHALL be retriable by the resilience layer (design D33) when no `tools/call` has been routed for the turn — i.e. a dropped prompt under concurrent-boot contention surfaces as a real claude-p exit classified `error`, never as a silent wedge that some bridge timer must guess at.

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

#### Scenario: Dropped prompt surfaces fast as a real exit, not a wedge
- **IF** the injected prompt is not confirmed accepted within the patched binary's retype budget
- **THEN** the driver surfaces a prompt-not-accepted error when claude-p exits
- **AND** when no `tools/call` has been routed, the resilience layer (D33) retries the spawn

## REMOVED Requirements

### Requirement: `--timeout` must not trip on a held tool round

**Reason**: The bridge no longer emits claude-p's `--timeout` flag at all. Per
the owner's no-liveness-timeouts principle, a wall-clock cap is a liveness
heuristic that can kill a healthy held tool round (a parked subagent or
human-in-the-loop tool can legitimately idle for hours). claude-p runs with no
wall cap; recovery is caller-driven abort plus the premature-exit-as-error
classification.

**Migration**: Consumers relying on `CLAUDE_BRIDGE_CLAUDE_P_TIMEOUT_SECONDS` to
bound a spawn must instead drive cancellation through pi's `AbortSignal` (the
existing SIGINT→grace→SIGKILL process-group abort). No bridge-side wall-clock
ceiling exists; an unattended-batch supervisor must enforce its own ceiling
externally by aborting the pi turn. The `--timeout` MODIFIED requirement's
held-round-safety guarantee is now vacuous (no flag → nothing to trip).

---

## Acceptance criterion quality checklist

| AC ID | Testable | Solution-free | Unambiguous | Consistent | Complete |
|---|---|---|---|---|---|
| claude-p-driver.unexpected-driver-exit-surfaces-as-error | [x] | [x] | [x] | [x] | [x] |
| claude-p-driver.prompt-injection-via-claude-p-input | [x] | [x] | [x] | [x] | [x] |
