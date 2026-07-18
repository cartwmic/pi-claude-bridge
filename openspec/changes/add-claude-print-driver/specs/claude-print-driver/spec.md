# Capability: claude-print-driver

<!-- authored: in-session -->

## ADDED Requirements

### Requirement: Direct Print Invocation Uses Bidirectional Stream Protocol

WHEN `claude-print` starts an invocation, THE driver SHALL run authenticated Claude Code in print mode with stream-json input/output, verbose partial messages, selected model and system prompt, strict explicit MCP configuration, isolated settings sources, permission bypass, and fresh or resumed session identity.

#### Scenario: Fresh direct invocation
- **WHEN** a fresh direct turn starts
- **THEN** one `claude` process is invoked with `-p`, `--input-format stream-json`, `--output-format stream-json`, `--verbose`, `--include-partial-messages`, selected model, explicit system prompt, strict MCP config, empty setting sources, and `--session-id <uuid>`
- **AND** its user prompt is delivered as one user NDJSON frame on stdin

#### Scenario: Warm direct invocation
- **WHEN** a validated direct session hint starts a later turn
- **THEN** the invocation uses `--resume <direct-session-id>` without `--session-id`
- **AND** the NDJSON user frame contains only newly appended user material

### Requirement: Prompt Submission Waits For Exact MCP Readiness

WHEN a direct subprocess starts, THE driver SHALL submit its user frame only after the owning shim proves `tools/list` has served the exact declared bridged tool set.

#### Scenario: Readiness precedes prompt
- **WHEN** direct startup has launched its shim but readiness has not been proven
- **THEN** no user NDJSON frame is written
- **AND** after readiness is proven exactly one user frame is written

#### Scenario: Readiness fails before submission
- **IF** the pre-submit MCP startup gate fails or the process exits before readiness
- **THEN** the invocation returns an explicit pre-submit error without model generation against a missing tool surface

### Requirement: Direct Native Tool Surface Is Closed

THE direct driver SHALL expose exactly the declared `mcp__custom-tools__*` tools and SHALL prevent native or user-configured Claude tools from routing, executing, or surfacing to pi.

#### Scenario: MCP tools survive native closure
- **WHEN** a direct invocation declares bridged tools and starts with native built-ins disabled
- **THEN** `system/init.tools` equals the declared `mcp__custom-tools__*` roster
- **AND** held bridged tool calls remain callable

#### Scenario: User configuration cannot widen surface
- **WHEN** user Claude settings contain allowed native tools or foreign MCP servers
- **THEN** neither native tools nor foreign MCP tools appear in the invocation's callable roster

### Requirement: Partial Stream Is Normalized Without Duplication

WHEN direct stream-json output contains partial stream events followed by complete assistant records, THE driver SHALL emit each top-level text, thinking, and bridged tool block to pi exactly once while retaining final metadata needed for usage and completion.

#### Scenario: Text and thinking deltas
- **WHEN** top-level `text_delta` and `thinking_delta` records arrive
- **THEN** pi receives matching ordered deltas and complete block boundaries
- **AND** later complete assistant records do not duplicate their content

#### Scenario: Subagent or observational records arrive
- **WHEN** a record is not a top-level user-facing content delta, including nested `parent_tool_use_id` records and observational tool-input deltas
- **THEN** it is not emitted as duplicate pi assistant content or used for tool-result routing

### Requirement: One Direct Process Spans Held Tool Rounds

WHILE a direct invocation is active, THE driver SHALL keep one Claude process alive across arbitrary sequential or parallel MCP tool calls until the terminal turn result, caller abort, or real process failure.

#### Scenario: Three sequential held calls
- **WHEN** Claude requests three tools sequentially and each router promise resolves from a later pi `streamSimple()` delivery
- **THEN** all three results return to the same Claude process and the process emits the final response

#### Scenario: Parallel held calls
- **WHEN** one assistant turn requests multiple bridged tools in parallel
- **THEN** each router-minted id resolves only its matching call and one process continues after all required results

### Requirement: Direct Usage And Session Metadata Are Authoritative

WHEN a successful direct turn emits complete assistant and terminal result records, THE driver SHALL map final-call context usage, cumulative billing usage/cost, stop reason, and session id into the same pi message semantics as `claude-p`.

#### Scenario: Multi-round terminal accounting
- **WHEN** a direct turn completes after multiple tool rounds
- **THEN** final message context usage comes from the final assistant call
- **AND** cumulative turn billing and session identity come from the terminal result without double counting

#### Scenario: Terminal result missing
- **IF** a non-aborted direct process closes without a complete terminal result
- **THEN** the driver returns an explicit premature-termination error and invalidates its resume hint

### Requirement: Direct Abort Preserves Partial And Reaps Process Group

WHEN pi aborts a direct invocation, THE driver SHALL classify the turn as aborted from local state, preserve already-streamed partial assistant content, stop further stream mutation, signal and reap the process group, and ignore any later terminal error record.

#### Scenario: Claude reports error after SIGINT
- **WHEN** caller abort triggers SIGINT and Claude emits `result.subtype = error_during_execution` before exiting zero
- **THEN** pi receives `done` with reason `aborted`, not an inference error
- **AND** partial text emitted before abort remains in the returned assistant message

#### Scenario: Process ignores graceful signal
- **IF** the direct process group remains alive after the grace period
- **THEN** the driver escalates termination and leaves no Claude or shim descendant alive

### Requirement: Direct Failure And Retry Preserve Side-Effect Safety

IF a direct invocation fails before any bridged tool call was routed, THEN THE driver SHALL apply the bridge's bounded logged retry policy; IF any tool call was routed, THEN THE driver SHALL surface the error without respawning.

#### Scenario: Pre-tool transient exit
- **IF** direct process exits prematurely before any tool call was routed
- **THEN** bounded retries may run and every retry is logged

#### Scenario: Failure after routed tool
- **IF** direct process fails after a bridged tool call was routed
- **THEN** no respawn occurs because repeating the call could duplicate side effects

### Requirement: Direct Driver Has No Inference Liveness Timeout

WHILE a submitted direct turn remains alive, THE bridge SHALL NOT terminate it because of elapsed idle or wall-clock time, and held MCP calls SHALL not inherit an upstream idle cutoff.

#### Scenario: Long healthy held tool
- **WHEN** a pi tool remains held without MCP progress for longer than the upstream default idle interval
- **THEN** the driver continues waiting until pi returns the result or caller aborts

### Requirement: Direct Driver Avoids Mutable Claude Filesystem Coupling

THE direct driver SHALL configure and observe Claude only through process arguments, stdin/stdout/stderr, explicit MCP IPC, and bridge-owned diagnostics, and SHALL NOT read or write paths under `~/.claude/`.

#### Scenario: Direct warm resume
- **WHEN** the driver warm-resumes a direct session
- **THEN** it passes `--resume` and never opens Claude transcript or config paths itself

---

## Acceptance criterion quality checklist

| AC ID | Testable | Solution-free | Unambiguous | Consistent | Complete |
|---|---|---|---|---|---|
| claude-print-driver.direct-print-invocation-uses-bidirectional-stream-protocol | [x] | [x] | [x] | [x] | [x] |
| claude-print-driver.prompt-submission-waits-for-exact-mcp-readiness | [x] | [x] | [x] | [x] | [x] |
| claude-print-driver.direct-native-tool-surface-is-closed | [x] | [x] | [x] | [x] | [x] |
| claude-print-driver.partial-stream-is-normalized-without-duplication | [x] | [x] | [x] | [x] | [x] |
| claude-print-driver.one-direct-process-spans-held-tool-rounds | [x] | [x] | [x] | [x] | [x] |
| claude-print-driver.direct-usage-and-session-metadata-are-authoritative | [x] | [x] | [x] | [x] | [x] |
| claude-print-driver.direct-abort-preserves-partial-and-reaps-process-group | [x] | [x] | [x] | [x] | [x] |
| claude-print-driver.direct-failure-and-retry-preserve-side-effect-safety | [x] | [x] | [x] | [x] | [x] |
| claude-print-driver.direct-driver-has-no-inference-liveness-timeout | [x] | [x] | [x] | [x] | [x] |
| claude-print-driver.direct-driver-avoids-mutable-claude-filesystem-coupling | [x] | [x] | [x] | [x] | [x] |
