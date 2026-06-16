# Capability: driver-diagnostics

Observability surface for a `claude-p` spawn. With liveness timeouts removed,
a real hang is handled reactively — so the bridge MUST make a hang
self-diagnosing: capture the child's stderr, dump in-flight turn state on
abnormal termination, and forward `claude --debug-file` to a bridge-owned path.
Constitution VII (failures surface; degradation is explicit) is the governing
principle; constitution III (no writes under `~/.claude/`) bounds where
diagnostics may be written.

## ADDED Requirements

### Requirement: Child stderr is captured to a per-spawn debug file

THE driver SHALL capture the `claude-p` child process's stderr stream and
persist it to a dedicated per-spawn debug file under the bridge's own debug
directory (the directory of the rotating `claude-bridge.log`, NOT under
`~/.claude/`). THE driver SHALL NOT route the child's stderr onto the child's
stdout, which is parsed as NDJSON (domain: events arrive on claude-p stdout).
THE per-spawn debug file SHALL be identifiable by the spawn (e.g. by session id
and pid).

#### Scenario: Upstream stderr is persisted for a spawn
- **WHEN** the child claude-p process writes to stderr during a turn
- **THEN** the bytes are appended to a per-spawn debug file under the bridge debug directory
- **AND** the bytes are NOT written to the child's stdout NDJSON stream

#### Scenario: stderr capture never crashes the turn
- **IF** the per-spawn debug file cannot be opened or written (e.g. permission or disk error)
- **THEN** the driver SHALL continue the turn without throwing
- **AND** SHALL emit a structured log entry noting the diagnostics-write failure

### Requirement: Premature-exit error surfaces the last stderr lines

THE driver SHALL surface upstream stderr on a premature exit: WHEN a claude-p spawn exits without a terminal `result` line and the turn was not aborted, THE driver SHALL include the last N lines of the child's captured stderr in the `error` event's `errorMessage` (bounded to a fixed maximum), so an
upstream cause (e.g. `PromptNotAccepted`, `StopTimeout`, an Anthropic stream
error) is visible to pi without reading the debug file. WHERE no stderr was
captured, THE driver SHALL emit the existing premature-termination message
unchanged.

#### Scenario: Premature exit with stderr
- **WHEN** the spawn closes with no terminal `result` and the turn was not aborted, and stderr lines were captured
- **THEN** the `error` event `errorMessage` contains the premature-termination summary AND the last N captured stderr lines

#### Scenario: Premature exit without stderr
- **IF** the spawn closes prematurely and no stderr was captured
- **THEN** the `error` event `errorMessage` is the premature-termination summary with no stderr section appended

### Requirement: In-flight state dump on abnormal termination

THE driver or bridge SHALL emit an in-flight state dump on abnormal termination: WHEN a turn terminates abnormally — a caller-driven abort, a forced termination, or a premature exit — it SHALL emit a structured log entry capturing the in-flight state: the age of the last observed stream
delta, whether a tool round was held at termination, and the length of any
buffered partial output. This makes a future hang self-diagnosing from the
bridge log.

#### Scenario: Abort emits a state dump
- **WHEN** pi aborts an in-flight turn
- **THEN** a structured log entry records the last-delta age, the held-round flag, and the partial-buffer length before teardown completes

#### Scenario: Premature exit emits a state dump
- **WHEN** a spawn exits prematurely (classified `error`)
- **THEN** a structured log entry records the same in-flight state fields

### Requirement: claude debug logging is forwarded to a bridge-owned file

THE driver SHALL forward `--debug-file <path>` to the child `claude` process via
claude-p's verbatim unknown-flag passthrough, pointing it at a per-spawn
bridge-owned path (NOT under `~/.claude/`), so the child claude's own debug log
is always captured alongside the spawn. THE driver SHALL keep this behavior
always-on by default and SHALL provide an environment escape hatch to disable
it. THE forwarded path SHALL NOT be under `~/.claude/` (constitution III).

#### Scenario: debug-file flag is emitted on a spawn
- **WHEN** the driver assembles the claude-p argument vector for a spawn and debug forwarding is enabled
- **THEN** the argv includes `--debug-file <bridge-owned-path>` and that path is not under `~/.claude/`

#### Scenario: debug-file forwarding can be disabled
- **WHERE** the operator sets the documented disable env var
- **THEN** the driver omits `--debug-file` from the argv

---

## Acceptance criterion quality checklist

| AC ID | Testable | Solution-free | Unambiguous | Consistent | Complete |
|---|---|---|---|---|---|
| driver-diagnostics.child-stderr-is-captured-to-a-per-spawn-debug-file | [x] | [x] | [x] | [x] | [x] |
| driver-diagnostics.premature-exit-error-surfaces-the-last-stderr-lines | [x] | [x] | [x] | [x] | [x] |
| driver-diagnostics.in-flight-state-dump-on-abnormal-termination | [x] | [x] | [x] | [x] | [x] |
| driver-diagnostics.claude-debug-logging-is-forwarded-to-a-bridge-owned-file | [x] | [x] | [x] | [x] | [x] |
