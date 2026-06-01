# Capability: transcript-stream

Parses claude-p's `--output-format stream-json` **stdout** during an in-flight
turn and emits structured events to the bridge's stream layer. Replaces the SDK
iterator's per-event interface. The bridge does NOT tail transcript JSONL files
and does NOT read `~/.claude/` — claude-p emits the (raw interactive) transcript
lines live on its stdout as `claude` flushes them (per design D27).

**claude-p's emitted schema (verified Phase-0):** the lines are the raw
interactive transcript, noisier than `claude -p`'s clean stream-json. Besides the
`user`/`assistant`/`result` lines, the stream includes leading
`mode`/`permission-mode`/`file-history-snapshot`/`attachment`/`ai-title` lines, a
built-in `WaitForMcpServers` tool_use, and trailing `system/stop_hook_summary` +
`system/turn_duration` lines. The terminal `result` envelope carries `usage` but
**NO `stop_reason`** (unlike `-p`). The parser filters the noise/built-in lines
and detects turn-end from the `result` line.

## ADDED Requirements

### Requirement: Parse claude-p stdout while the turn is in flight

WHEN the driver spawns claude-p with `--output-format stream-json --verbose`, THE transcript stream SHALL read claude-p's stdout incrementally, parse each complete newline-delimited JSON line, emit a structured event for each recognized content-bearing line, and continue until claude-p emits the terminal `result` line (turn complete) or the subprocess exits.

#### Scenario: New stream-json lines drive stream events
- **WHEN** claude-p has been spawned with `--output-format stream-json --verbose`
- **AND** claude-p flushes a complete JSON line representing an assistant text block
- **THEN** the transcript stream emits a corresponding event to the bridge stream layer with no buffering beyond the line boundary

#### Scenario: Turn ends on the terminal `result` line
- **WHEN** claude-p flushes the terminal `result` line (`type: "result"`)
- **THEN** the transcript stream emits the final `usage` event from `result.usage`
- **AND** marks the turn complete (the `result` line — not a `stop_reason` field, which claude-p does not emit — is the terminal marker)
- **AND** no further events are emitted for that turn

### Requirement: Emit text-delta, tool-use, thinking, and usage events

THE transcript stream SHALL map recognized JSON lines to four structured event kinds: `text-delta` for assistant text-content additions, `tool-use` for tool-call blocks with the model's full argument object, `thinking-delta` for thinking-content additions when present, and `usage` for the terminal `result` line's token-accounting fields.

#### Scenario: Tool-use entry carries full arguments
- **WHEN** claude-p flushes an assistant line containing a tool-use block for `mcp__custom-tools__read` with arguments `{ path: "/tmp/x" }`
- **THEN** the transcript stream emits a `tool-use` event whose payload includes the tool name and the full arguments object

#### Scenario: Usage event sourced from result line
- **WHEN** claude-p flushes the terminal `result` line containing `usage.input_tokens`, `usage.output_tokens`, `usage.cache_read_input_tokens`, and `usage.cache_creation_input_tokens`
- **THEN** the transcript stream emits a `usage` event mapping these fields into the bridge's usage shape (`input`, `output`, `cacheRead`, `cacheWrite`)

### Requirement: Filter claude-p noise and built-in lines

THE transcript stream SHALL ignore claude-p's non-content interactive-schema lines — `mode`, `permission-mode`, `file-history-snapshot`, `attachment`, `ai-title`, `system/stop_hook_summary`, `system/turn_duration` — emitting no pi-facing event for them. THE transcript stream SHALL also ignore the model's built-in `WaitForMcpServers` tool_use (and any other built-in tool the disallow set did not prevent from being emitted), surfacing it neither as a `tool-use` event nor as a pi tool execution.

#### Scenario: Noise lines produce no events
- **WHEN** claude-p flushes a `file-history-snapshot` line followed by an `attachment` line
- **THEN** the transcript stream emits no pi-facing event for either line
- **AND** continues parsing subsequent lines normally

#### Scenario: WaitForMcpServers is not surfaced
- **WHEN** claude-p flushes an assistant line whose tool-use block has `name: "WaitForMcpServers"`
- **THEN** the transcript stream emits no `tool-use` event for it
- **AND** no pi tool execution is triggered

### Requirement: Partial lines are buffered until newline

THE transcript stream SHALL buffer any bytes read before a newline boundary and SHALL NOT attempt to parse partial JSON content. THE transcript stream SHALL parse and emit only on complete-line boundaries.

#### Scenario: Mid-write boundary read
- **WHEN** a stdout read ends mid-line
- **THEN** the trailing partial content is buffered for the next read
- **AND** no event is emitted for that partial content until a newline arrives

### Requirement: Malformed lines surface as warnings, not stream errors

IF the transcript stream encounters a complete stdout line that is not valid JSON, THEN the transcript stream SHALL emit a structured warning log entry naming the offending content prefix, SHALL skip the line, and SHALL continue parsing; THE stream SHALL NOT terminate the active turn on a single malformed line.

#### Scenario: Junk line in the middle of the stream
- **IF** claude-p's stdout contains a non-JSON line between two valid lines
- **THEN** the transcript stream logs a warning naming the line content prefix
- **AND** emits events for the valid lines before and after the bad line
- **AND** the active turn proceeds to completion

### Requirement: Unknown line types surface as warnings (drift detection)

IF the transcript stream encounters a valid-JSON line whose top-level `type` field is neither a recognized content type (`user`, `assistant`, `result`) nor a known-ignored noise type, THEN the transcript stream SHALL emit a structured warning log entry naming the unknown type and SHALL continue parsing without emitting a typed event for that line. THE stream SHALL NOT terminate the active turn on an unknown-but-valid-JSON line. This drift-detection path is distinct from the malformed-JSON path above and from the known-noise-filtering requirement.

#### Scenario: Future claude / claude-p release emits a new top-level type
- **IF** the stdout contains a line `{"type": "session_id_rotated", ...}` and `session_id_rotated` is in neither the recognized-content set nor the known-noise set
- **THEN** the transcript stream logs a warn-level entry naming `session_id_rotated`
- **AND** emits no structured event for the line
- **AND** the active turn continues processing subsequent lines normally

### Requirement: Driver exit without terminal result surfaces as error

IF the claude-p subprocess exits (or its stdout closes) before a terminal `result` line is observed AND the turn was not aborted, THEN the transcript stream SHALL emit an `error` event whose `errorMessage` references the premature termination, and SHALL NOT silently substitute a placeholder result; the active turn SHALL resolve with `stopReason === "error"`.

#### Scenario: claude-p stdout closes before result
- **IF** claude-p's stdout closes (subprocess died) with no terminal `result` line emitted and the turn was not aborted
- **THEN** the transcript stream emits an `error` event whose `errorMessage` includes the premature-termination reason (exit code / signal where available)
- **AND** the active turn's `AssistantMessage.stopReason === "error"`

---

## Acceptance criterion quality checklist

| AC ID | Testable | Solution-free | Unambiguous | Consistent | Complete |
|---|---|---|---|---|---|
| transcript-stream.parse-claude-p-stdout-while-the-turn-is-in-flight | [ ] | [ ] | [ ] | [ ] | [ ] |
| transcript-stream.emit-text-delta-tool-use-thinking-and-usage-events | [ ] | [ ] | [ ] | [ ] | [ ] |
| transcript-stream.filter-claude-p-noise-and-built-in-lines | [ ] | [ ] | [ ] | [ ] | [ ] |
| transcript-stream.partial-lines-are-buffered-until-newline | [ ] | [ ] | [ ] | [ ] | [ ] |
| transcript-stream.malformed-lines-surface-as-warnings-not-stream-errors | [ ] | [ ] | [ ] | [ ] | [ ] |
| transcript-stream.unknown-line-types-surface-as-warnings-drift-detection | [ ] | [ ] | [ ] | [ ] | [ ] |
| transcript-stream.driver-exit-without-terminal-result-surfaces-as-error | [ ] | [ ] | [ ] | [ ] | [ ] |
