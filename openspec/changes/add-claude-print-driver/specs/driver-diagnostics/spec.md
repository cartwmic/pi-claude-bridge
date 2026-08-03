# Capability: driver-diagnostics

<!-- authored: in-session -->

## MODIFIED Requirements

### Requirement: Child stderr is captured to a per-spawn debug file

THE selected driver SHALL capture child stderr to dedicated per-spawn file under bridge diagnostics, not `~/.claude/`, SHALL keep stderr separate from parsed NDJSON stdout, and SHALL identify file by driver and spawn. Diagnostic-write failure SHALL not crash turn and SHALL be logged.

#### Scenario: Selected-driver stderr persisted
- **WHEN** either driver writes stderr
- **THEN** bytes append to its bridge-owned per-spawn file and never stdout parser

#### Scenario: stderr capture write fails
- **IF** file cannot open or write
- **THEN** turn continues and diagnostics failure is logged

### Requirement: Premature-exit error surfaces the last stderr lines

IF selected-driver spawn exits without terminal result and was not aborted, THEN THE bridge SHALL append bounded last N stderr lines to surfaced error; with no captured stderr it SHALL preserve base premature-termination message.

#### Scenario: Premature exit with stderr
- **IF** either driver closes without result and stderr exists
- **THEN** error names driver/cause and contains bounded tail

#### Scenario: Premature exit without stderr
- **IF** selected driver closes prematurely with no stderr
- **THEN** error has base summary without stderr section

### Requirement: In-flight state dump on abnormal termination

WHEN either driver aborts, is forced down, or exits prematurely, THE bridge SHALL log driver identity, last-delta age, held-round state, and buffered-partial length before teardown completes.

#### Scenario: Abort emits selected-driver state dump
- **WHEN** pi aborts either driver
- **THEN** structured dump contains required state and driver

#### Scenario: Premature exit emits selected-driver state dump
- **IF** either driver exits prematurely
- **THEN** same fields are logged

### Requirement: claude debug logging is forwarded to a bridge-owned file

WHERE debug forwarding is enabled, THE selected driver SHALL pass `--debug-file <bridge-owned-path>` to Claude directly or through interactive passthrough, SHALL keep it outside `~/.claude/`, and SHALL omit flag when documented disable env is set.

#### Scenario: Debug flag emitted
- **WHEN** either driver starts with forwarding enabled
- **THEN** argv reaches Claude with bridge-owned debug path

#### Scenario: Debug forwarding disabled
- **WHERE** disable env is set
- **THEN** selected driver omits debug-file flag

## ADDED Requirements

### Requirement: Diagnostics Identify Selected Driver

WHEN either inference driver starts or terminates, THE bridge SHALL include driver identity in structured lifecycle logs and associate diagnostic artifacts with that invocation.

#### Scenario: Concurrent driver diagnostics
- **WHEN** interactive and direct invocations overlap
- **THEN** files and lifecycle records remain distinct by driver/spawn

---

## Acceptance criterion quality checklist

| AC ID | Testable | Solution-free | Unambiguous | Consistent | Complete |
|---|---|---|---|---|---|
| driver-diagnostics.child-stderr-is-captured-to-a-per-spawn-debug-file | [x] | [x] | [x] | [x] | [x] |
| driver-diagnostics.premature-exit-error-surfaces-the-last-stderr-lines | [x] | [x] | [x] | [x] | [x] |
| driver-diagnostics.in-flight-state-dump-on-abnormal-termination | [x] | [x] | [x] | [x] | [x] |
| driver-diagnostics.claude-debug-logging-is-forwarded-to-a-bridge-owned-file | [x] | [x] | [x] | [x] | [x] |
| driver-diagnostics.diagnostics-identify-selected-driver | [x] | [x] | [x] | [x] | [x] |
