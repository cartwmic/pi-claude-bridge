# Capability: output-capture

<!-- authored: in-session -->

## ADDED Requirements

### Requirement: Capture Uses Owning Invocation Driver

WHEN a valid capture call starts, THE bridge SHALL run forced-MCP capture through the driver selected for its owning invocation while preserving the existing isolated process/router/shim, verbatim system prompt, text-only replay, IPC-authoritative stash, usage mapping, and terminal stream contract.

#### Scenario: Direct-driver capture succeeds
- **WHEN** owning configuration selects `claude-print` and the model calls the sole capture tool with valid arguments
- **THEN** the direct process uses the capture-only shim
- **AND** the IPC-stashed arguments become exactly one synthesized pi `toolCall`
- **AND** no main-provider frame or session cache is mutated

#### Scenario: Interactive capture remains unchanged
- **WHEN** owning configuration selects `claude-p`
- **THEN** capture retains its existing forced-MCP behavior and external result shape

#### Scenario: Capture driver fails
- **IF** the selected capture driver exits without a valid IPC stash
- **THEN** capture surfaces the selected driver's error and does not retry through the other driver

### Requirement: Capture Suppresses Driver Partial Content

WHILE capture runs through either driver, THE capture pi stream SHALL emit only its initial start and one terminal done or error event.

#### Scenario: Direct partial events arrive during capture
- **WHEN** `claude-print` emits thinking, text, or tool-input partial events before capture finalization
- **THEN** none are emitted as intermediate capture pi events
- **AND** successful finalization still trusts the validated IPC stash

---

## Acceptance criterion quality checklist

| AC ID | Testable | Solution-free | Unambiguous | Consistent | Complete |
|---|---|---|---|---|---|
| output-capture.capture-uses-owning-invocation-driver | [x] | [x] | [x] | [x] | [x] |
| output-capture.capture-suppresses-driver-partial-content | [x] | [x] | [x] | [x] | [x] |
