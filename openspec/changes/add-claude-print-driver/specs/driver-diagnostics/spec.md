# Capability: driver-diagnostics

<!-- authored: in-session -->

## ADDED Requirements

### Requirement: Diagnostics Identify Selected Driver

WHEN either inference driver starts or terminates, THE bridge SHALL include driver identity in structured lifecycle logs and associate stderr, Claude debug output, and state dumps with that invocation.

#### Scenario: Direct premature exit
- **WHEN** `claude-print` exits before a terminal result and captured stderr exists
- **THEN** the surfaced error names `claude-print` and includes the bounded stderr tail
- **AND** its state dump reports last-delta age, held-round state, and partial-buffer length

#### Scenario: Interactive diagnostics remain distinct
- **WHEN** `claude-p` and `claude-print` invocations run concurrently
- **THEN** each invocation writes to distinct bridge-owned diagnostic files carrying its driver identity

### Requirement: Claude Debug File Is Driver Independent

WHERE Claude debug forwarding is enabled, THE selected driver SHALL direct Claude's own debug output to a per-spawn bridge-owned file and SHALL never interleave debug bytes with parsed NDJSON stdout.

#### Scenario: Direct debug forwarding
- **WHEN** `claude-print` starts with debug forwarding enabled
- **THEN** its Claude argv includes a bridge-owned debug-file path outside `~/.claude/`

#### Scenario: Diagnostics write fails
- **IF** either driver cannot open a diagnostic file
- **THEN** the inference turn continues and a structured diagnostics-write failure is logged

---

## Acceptance criterion quality checklist

| AC ID | Testable | Solution-free | Unambiguous | Consistent | Complete |
|---|---|---|---|---|---|
| driver-diagnostics.diagnostics-identify-selected-driver | [x] | [x] | [x] | [x] | [x] |
| driver-diagnostics.claude-debug-file-is-driver-independent | [x] | [x] | [x] | [x] | [x] |
