# Capability: bridge-driver-selection

<!-- authored: in-session -->

## ADDED Requirements

### Requirement: Driver Selection Uses Layered Bridge Configuration

THE bridge SHALL select exactly one inference driver from `claude-p` or `claude-print` using key-wise precedence `CLAUDE_BRIDGE_DRIVER` compatibility override, project `<project>/.pi/claude-bridge.json`, global `~/.pi/agent/claude-bridge.json`, then default `claude-p`; an absent `driver` key falls through while malformed JSON, a non-string driver, or an unsupported driver value fails explicitly before spawn.

#### Scenario: Project config selects direct driver
- **WHEN** project config contains `{ "driver": "claude-print" }` and no environment override exists
- **THEN** fresh bridge invocations for that project use `claude-print`

#### Scenario: Project config omits driver
- **WHEN** project config exists without a `driver` key and global config selects `claude-print`
- **THEN** fresh bridge invocations use the global `claude-print` value

#### Scenario: Existing default remains interactive
- **WHEN** no driver value exists in environment, project config, or global config
- **THEN** fresh bridge invocations use `claude-p`

#### Scenario: Malformed or invalid configuration fails loud
- **IF** a participating config file is malformed or the highest-precedence present driver value is non-string or unsupported
- **THEN** the bridge returns an explicit configuration error before spawning an inference process

### Requirement: Selected Driver Is Pinned To Invocation Lifecycle

WHEN an invocation creates a frame, THE bridge SHALL pin its selected driver until that frame and any parked tool-result delivery, capture, or nested invocation owned by that frame complete.

#### Scenario: Config changes during held tool call
- **WHEN** a frame is parked on a tool call and configuration changes before pi delivers the tool result
- **THEN** the result returns to the frame's original driver without cross-driver dispatch

#### Scenario: Capture follows owning selection
- **WHEN** capture runs from an invocation whose project selection is `claude-print` while its subprocess cwd is an isolated temporary directory
- **THEN** capture uses `claude-print` rather than resolving config from the temporary directory

#### Scenario: Nested invocation follows owner
- **WHEN** a nested same-provider invocation starts while its parent frame is parked
- **THEN** the child uses the parent invocation's pinned driver despite child cwd or mid-flight config changes

### Requirement: In-Memory Session Hints Are Driver Typed

THE bridge SHALL record driver identity with every in-memory session hint and SHALL cold-start if the selected driver differs from the hint's driver.

#### Scenario: Same-process driver switch
- **WHEN** a completed `claude-p` turn leaves an in-memory hint and a later fresh turn selects `claude-print`
- **THEN** the interactive hint is dropped and the direct turn cold-starts

### Requirement: Driver Failures Never Trigger Cross-Driver Fallback

IF a selected driver fails during an invocation, THEN THE bridge SHALL surface that driver's error and SHALL NOT retry the invocation through the other driver.

#### Scenario: Direct driver exits before result
- **IF** a `claude-print` invocation exits prematurely
- **THEN** the bridge reports a `claude-print` error and does not spawn `claude-p` for that invocation

### Requirement: Direct Driver Enforces Independent Version Floor

WHERE `claude-print` is selected, THE bridge SHALL require installed Claude Code version 2.1.208 or newer before submitting a billed turn; this check SHALL NOT restrict `claude-p`.

#### Scenario: Unsupported direct version
- **IF** `claude-print` is selected and installed Claude Code is older than 2.1.208
- **THEN** the bridge returns an explicit unsupported-version error before prompt submission

#### Scenario: Interactive path remains independently supported
- **WHEN** `claude-p` is selected on a version supported by that driver but older than the direct-driver floor
- **THEN** the bridge does not reject the invocation because of the `claude-print` floor

---

## Acceptance criterion quality checklist

| AC ID | Testable | Solution-free | Unambiguous | Consistent | Complete |
|---|---|---|---|---|---|
| bridge-driver-selection.driver-selection-uses-layered-bridge-configuration | [x] | [x] | [x] | [x] | [x] |
| bridge-driver-selection.selected-driver-is-pinned-to-invocation-lifecycle | [x] | [x] | [x] | [x] | [x] |
| bridge-driver-selection.in-memory-session-hints-are-driver-typed | [x] | [x] | [x] | [x] | [x] |
| bridge-driver-selection.driver-failures-never-trigger-cross-driver-fallback | [x] | [x] | [x] | [x] | [x] |
| bridge-driver-selection.direct-driver-enforces-independent-version-floor | [x] | [x] | [x] | [x] | [x] |
