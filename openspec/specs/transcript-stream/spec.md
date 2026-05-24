# transcript-stream Specification

## Purpose
TBD - created by archiving change normalize-output-capture-spec-post-sdk-removal. Update Purpose after archive.
## Requirements
### Requirement: Tail transcript while turn is in flight

WHEN the driver spawns a PTY with a pre-generated `--session-id <uuid>`, THE transcript stream SHALL compute the expected transcript path from the UUID and the encoded cwd (per D18), establish a parent-directory `fs.watch` (or polling fallback per Phase 0 T0.4 result) to detect file creation, open the path for read-tail as soon as it appears, emit events for each fully-written JSONL line, and continue tailing until the `Stop` hook fires for the same session AND the bounded post-`Stop` settle window (D17) elapses or the terminal `result` is observed.

#### Scenario: New JSONL lines drive stream events
- **WHEN** the driver has spawned with a `--session-id <uuid>` and the transcript file at the computed path has been created
- **AND** the driver appends a complete JSONL line representing an assistant text block
- **THEN** the transcript stream emits a corresponding event to the bridge stream layer within an implementation-defined polling/notify latency

#### Scenario: Tailing stops at end-of-turn after a bounded settle window
- **WHEN** the `Stop` hook fires for the session whose transcript is being tailed
- **THEN** the transcript stream enters a bounded settle window (default 250ms, env-overridable via `CLAUDE_BRIDGE_TRANSCRIPT_SETTLE_MS`) during which it continues reading newly-appended lines
- **AND** the window closes when either the timeout elapses OR a terminal `result` JSONL entry has been observed
- **AND** on window close the transcript stream consumes any remaining buffered bytes, emits final events, and closes the file handle
- **AND** no further events are emitted for that session

#### Scenario: Stop arrives before terminal `result` is written
- **WHEN** the `Stop` hook fires but the terminal `result` JSONL line has not yet been appended
- **AND** the file system writes the `result` line within the settle window
- **THEN** the transcript stream observes and emits the corresponding `usage` event before closing
- **AND** the active turn's `AssistantMessage` carries complete usage / cost data

### Requirement: Emit text-delta, tool-use, thinking, and usage events

THE transcript stream SHALL map JSONL entries to four structured event kinds: `text-delta` for assistant text-content additions, `tool-use` for tool-call blocks with the model's full argument object, `thinking-delta` for thinking-content additions when present, and `usage` for the terminal `result` entry's token-accounting fields.

#### Scenario: Tool-use entry carries full arguments
- **WHEN** the driver writes a JSONL entry containing a tool-use block with arguments `{ path: "/tmp/x" }`
- **THEN** the transcript stream emits a `tool-use` event whose payload includes the tool name and the full arguments object

#### Scenario: Usage event sourced from result entry
- **WHEN** the driver writes the terminal `result` JSONL entry containing `usage.input_tokens`, `usage.output_tokens`, `usage.cache_read_input_tokens`, and `usage.cache_creation_input_tokens`
- **THEN** the transcript stream emits a `usage` event mapping these fields into the bridge's usage shape (`input`, `output`, `cacheRead`, `cacheWrite`)

### Requirement: Partial lines are buffered until newline

THE transcript stream SHALL buffer any bytes read before a newline boundary and SHALL NOT attempt to parse partial JSONL content. THE transcript stream SHALL parse and emit only on complete-line boundaries.

#### Scenario: Mid-write boundary read
- **WHEN** the tailer reads bytes that end mid-line
- **THEN** the trailing partial content is buffered for the next read
- **AND** no event is emitted for that partial content until a newline arrives

### Requirement: Malformed JSONL lines surface as warnings, not stream errors

IF the transcript stream encounters a complete line that is not valid JSON, THEN the transcript stream SHALL emit a structured warning log entry naming the offending line offset and content prefix, SHALL skip the line, and SHALL continue tailing; THE stream SHALL NOT terminate the active turn on a single malformed line.

#### Scenario: Junk line in middle of transcript
- **IF** the JSONL file contains a non-JSON line between two valid entries
- **THEN** the transcript stream logs a warning naming the line offset
- **AND** emits events for the valid lines before and after the bad line
- **AND** the active turn proceeds to completion

### Requirement: Unknown JSONL entry types surface as warnings (drift detection)

IF the transcript stream encounters a valid-JSON line whose top-level `type` field is not in the bridge's known set (e.g. `user`, `assistant`, `result`, `system`, plus any forward-compatible additions explicitly recognized in code), THEN the transcript stream SHALL emit a structured warning log entry naming the unknown type and SHALL continue tailing without emitting a typed event for that line. THE stream SHALL NOT terminate the active turn on an unknown-but-valid-JSON entry. This drift-detection path is distinct from the malformed-JSON path above.

#### Scenario: Future `claude` release emits a new top-level type
- **IF** the JSONL file contains a line with `{"type": "session_id_rotated", ...}` and `session_id_rotated` is not in the bridge's known type set
- **THEN** the transcript stream logs a warn-level entry naming `session_id_rotated`
- **AND** emits no structured event for the line
- **AND** the active turn continues processing subsequent lines normally

### Requirement: Missing or unreadable transcript surfaces as error

IF the `Stop` hook's reported `transcript_path` does not exist or is not readable at hook time, THEN the transcript stream SHALL emit an `error` event whose `errorMessage` references the path and the cause, and SHALL NOT silently substitute a placeholder result; the active turn SHALL resolve with `stopReason === "error"`.

#### Scenario: Transcript path absent at Stop
- **IF** `Stop` reports `transcript_path = "/nonexistent.jsonl"`
- **THEN** the transcript stream emits an `error` event whose `errorMessage` includes the missing-file reason
- **AND** the active turn's `AssistantMessage.stopReason === "error"`

---

