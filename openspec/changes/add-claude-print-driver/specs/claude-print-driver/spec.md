# Capability: claude-print-driver

<!-- authored: in-session -->

## ADDED Requirements

### Requirement: Direct Print Invocation Uses Bidirectional Stream Protocol

WHEN `claude-print` starts an invocation, THE driver SHALL run authenticated Claude Code with `-p`, `--input-format stream-json`, `--output-format stream-json`, `--verbose`, `--include-partial-messages`, selected model and system prompt, `--mcp-config <bridge-shim-config>`, `--strict-mcp-config`, `--setting-sources ""`, `--permission-mode bypassPermissions`, `--tools ""`, defense-in-depth native filtering, default-on bridge-owned debug output, and fresh or resumed session identity; it SHALL NOT pass `--bare`. Large or multiline system prompts SHALL use `--system-prompt-file <bridge-tempfile>` with cleanup rather than unsafe argv delivery.

#### Scenario: Fresh direct invocation
- **WHEN** a fresh direct turn starts
- **THEN** argv includes `-p`, `--input-format stream-json`, `--output-format stream-json`, `--verbose`, `--include-partial-messages`, `--mcp-config <bridge-shim-config>`, `--strict-mcp-config`, `--setting-sources ""`, `--tools ""`, `--permission-mode bypassPermissions`, selected model, explicit system prompt, default-on bridge-owned debug file unless documented disable env is set, and `--session-id <uuid>`
- **AND** argv does not include `--bare`
- **AND** one user NDJSON frame carries flattened pi history per the cold-start conversion contract
- **AND** stdin remains open until terminal result, abort, or failure

#### Scenario: Warm direct invocation
- **WHEN** a validated direct session hint starts a later turn
- **THEN** argv retains `-p`, selected model/system prompt, `--input-format stream-json`, `--output-format stream-json`, `--verbose`, `--include-partial-messages`, `--tools ""`, `--permission-mode bypassPermissions`, `--strict-mcp-config`, `--setting-sources ""`, native filtering, explicit MCP config, and bridge-owned debug file
- **AND** argv replaces `--session-id` with `--resume <direct-session-id>` and does not include `--bare`
- **AND** one user NDJSON frame contains only newly appended user material
- **AND** stdin remains open until terminal result, abort, or failure so control traffic and held MCP lifecycle cannot be cut short

### Requirement: Prompt Submission Waits For Exact MCP Readiness

WHEN a direct subprocess starts, THE driver SHALL submit its user frame only after the owning shim has accepted `tools/list` and produced the exact declared bridged tool set; startup SHALL have a documented default 30-second pre-submit deadline, overridable only by a documented positive operator environment value, that starts at process spawn and ends at readiness, errors and reaps process/shim, and imposes no post-submit inference timeout.

#### Scenario: Readiness precedes prompt
- **WHEN** direct startup has launched its shim but readiness has not been proven
- **THEN** no user NDJSON frame is written
- **AND** after readiness is proven exactly one user frame is queued for Claude, whose initialization completes before generation

#### Scenario: Readiness never arrives
- **IF** readiness is absent at the startup deadline or the process exits first
- **THEN** the invocation returns an explicit pre-submit error, reaps process/shim, and performs no model generation against a missing tool surface

### Requirement: Direct Native Tool Surface Is Closed

THE direct driver SHALL use `--tools ""` plus defense-in-depth filtering so exactly the declared `mcp__custom-tools__*` tools are callable and native or user-configured Claude tools cannot route, execute, or surface to pi.

#### Scenario: MCP tools survive native closure
- **WHEN** a direct invocation declares bridged tools
- **THEN** `system/init.tools` equals the declared `mcp__custom-tools__*` roster
- **AND** held bridged tool calls remain callable

#### Scenario: User configuration cannot widen surface
- **WHEN** user settings contain allowed native tools or foreign MCP servers
- **THEN** neither native tools nor foreign MCP tools appear in the callable roster or execute

### Requirement: Partial Stream Is Normalized Without Duplication

WHEN direct stream-json output contains partial events followed by complete assistant records, THE driver SHALL emit each top-level text and thinking block to pi exactly once; stream `tool_use` and `input_json_delta` records SHALL remain observational while the shim/router is authoritative for tool execution and pi correlation.

#### Scenario: Text and thinking deltas
- **WHEN** top-level `text_delta` and `thinking_delta` records arrive
- **THEN** pi receives matching ordered deltas and complete block boundaries
- **AND** later complete assistant records do not duplicate their content

#### Scenario: Tool observations arrive
- **WHEN** stream tool-use or input-json records describe a bridged call
- **THEN** they are used only for structured logging and consistency cross-checks
- **AND** router/shim-originated correlation is sole source of pi-visible tool-call lifecycle and execution

#### Scenario: Nested records arrive
- **WHEN** a record carries a non-null `parent_tool_use_id`
- **THEN** it is not emitted as duplicate top-level assistant content

### Requirement: Direct Protocol Drift Surfaces Explicitly

IF direct stdout contains malformed NDJSON, invalid top-level partial block lifecycle, missing final assistant usage, more or fewer than one terminal result, session-id mismatch, or irreconcilable result subtype/stop reason, THEN THE driver SHALL return a structured protocol error and invalidate its resume hint. Recognized non-abort terminal error subtypes SHALL map to pi `stopReason: "error"`, surfaced message, diagnostics, and hint invalidation; explicitly allowlisted well-formed observational record types SHALL be logged and ignored, every genuinely unknown type SHALL be protocol drift, and local abort state takes precedence over all post-abort records.

#### Scenario: Malformed stream line
- **IF** a non-empty stdout line is not valid JSON
- **THEN** the turn ends with an explicit protocol error rather than silently dropping the line

#### Scenario: Allowlisted observational record
- **WHEN** a well-formed record type belongs to the explicit observational allowlist and does not affect completion, usage, or content semantics
- **THEN** the driver logs its type and continues without emitting fabricated pi content

### Requirement: One Direct Process Spans Held Tool Rounds

WHILE a direct invocation is active, THE driver SHALL keep one Claude process alive across arbitrary sequential or parallel MCP tool calls until terminal result, caller abort, or real process failure.

#### Scenario: Three sequential held calls
- **WHEN** Claude requests three tools sequentially and each router promise resolves from a later pi delivery
- **THEN** all results return to the same Claude process and it emits the final response

#### Scenario: Parallel held calls
- **WHEN** one assistant turn requests multiple bridged tools in parallel
- **THEN** each router-minted id resolves only its matching call and one process continues after all results

### Requirement: Direct Usage And Session Metadata Are Authoritative

WHEN a successful direct turn emits complete assistant and terminal result records, THE final assistant SHALL supply final-call context usage while terminal result SHALL supply cumulative billing/cost, session identity, and completion classification; conflicting required metadata SHALL surface as protocol drift.

#### Scenario: Multi-round terminal accounting
- **WHEN** a direct turn completes after multiple tool rounds
- **THEN** final message context usage comes from the final assistant call
- **AND** cumulative billing and session identity come from terminal result without double counting

#### Scenario: Terminal result missing
- **IF** a non-aborted direct process closes without a complete terminal result
- **THEN** the driver returns an explicit premature-termination error and invalidates its resume hint

### Requirement: Direct Abort Preserves Partial And Reaps Process Group

WHEN pi aborts a direct invocation, THE driver SHALL classify from local abort state, preserve streamed partial assistant content, stop further stream mutation, signal and reap the process group, and ignore any later terminal error record.

#### Scenario: Claude reports error after SIGINT
- **WHEN** caller abort triggers SIGINT and Claude emits `error_during_execution` before exiting zero
- **THEN** pi receives `done` with reason `aborted`, not inference error
- **AND** partial text remains in the returned assistant message

#### Scenario: Process ignores graceful signal
- **IF** the direct process group remains alive after grace
- **THEN** termination escalates and no Claude or shim descendant remains

### Requirement: Direct Failure And Retry Preserve Side-Effect Safety

IF a direct invocation fails before any bridged tool call is routed and before the first assistant text/thinking delta is emitted to the pi-ai stream, THEN THE driver MAY apply at most two logged retries with short backoff and fresh process/shim identity; IF any tool call or visible delta was emitted, THEN THE driver SHALL surface failure without respawning.

#### Scenario: Pre-output transient exit
- **IF** direct process exits prematurely before routed tools or visible output
- **THEN** bounded retries may run and every retry is logged

#### Scenario: Failure after visible output or routed tool
- **IF** direct process fails after visible output or a bridged tool call
- **THEN** no respawn occurs, preventing mixed attempts or duplicated side effects

### Requirement: Direct Driver Has No Inference Liveness Timeout

WHILE a submitted direct turn remains alive, THE bridge SHALL NOT terminate it because of elapsed idle or wall time and SHALL set `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0` in the Claude child environment.

#### Scenario: Long healthy held tool
- **WHEN** a pi tool remains held longer than Claude's default stdio-MCP idle interval
- **THEN** driver waits until pi returns result or caller aborts

### Requirement: Direct Concurrent Invocations Are Isolated

WHEN main, capture, or nested direct invocations overlap, THE bridge SHALL give each a disjoint process, shim, router, IPC channel, queues, session state, and correlation domain.

#### Scenario: Nested and capture overlap main
- **WHEN** parent main is parked while nested and capture direct invocations run
- **THEN** no stream, tool result, session hint, or resolver crosses invocation boundaries

### Requirement: Direct Image Behavior Matches Bridge Contract

WHEN main direct history contains images, THE bridge SHALL warn and drop image blocks before text-only replay; WHEN direct capture contains images, THE bridge SHALL follow output-capture's documented warn-and-drop text-only contract.

#### Scenario: Main image input
- **WHEN** a main direct turn contains image blocks
- **THEN** warning names dropped count and text-only turn proceeds

#### Scenario: Capture image input
- **WHEN** a direct capture call contains image blocks
- **THEN** capture warns, drops images, and proceeds with text replay

### Requirement: Direct Steering Uses Abort And Fresh Dispatch

WHEN pi steers an active direct turn, THE bridge SHALL abort the in-flight process, preserve its partial in pi history, then dispatch steering as a fresh direct turn without stream interleaving.

#### Scenario: Mid-stream steer
- **WHEN** a new user message arrives during direct text generation
- **THEN** old stream detaches and completes aborted before replacement starts
- **AND** replacement can reference abandoned partial and redirection

### Requirement: Direct Driver Avoids Mutable Claude Filesystem Coupling

THE direct driver SHALL configure and observe Claude only through process channels, explicit MCP IPC, and bridge-owned diagnostics, and SHALL NOT read or write paths under `~/.claude/`.

#### Scenario: Direct warm resume
- **WHEN** driver warm-resumes a direct session
- **THEN** it passes `--resume` and never opens Claude transcript or config paths itself

---

## Acceptance criterion quality checklist

| AC ID | Testable | Solution-free | Unambiguous | Consistent | Complete |
|---|---|---|---|---|---|
| claude-print-driver.direct-print-invocation-uses-bidirectional-stream-protocol | [x] | [x] | [x] | [x] | [x] |
| claude-print-driver.prompt-submission-waits-for-exact-mcp-readiness | [x] | [x] | [x] | [x] | [x] |
| claude-print-driver.direct-native-tool-surface-is-closed | [x] | [x] | [x] | [x] | [x] |
| claude-print-driver.partial-stream-is-normalized-without-duplication | [x] | [x] | [x] | [x] | [x] |
| claude-print-driver.direct-protocol-drift-surfaces-explicitly | [x] | [x] | [x] | [x] | [x] |
| claude-print-driver.one-direct-process-spans-held-tool-rounds | [x] | [x] | [x] | [x] | [x] |
| claude-print-driver.direct-usage-and-session-metadata-are-authoritative | [x] | [x] | [x] | [x] | [x] |
| claude-print-driver.direct-abort-preserves-partial-and-reaps-process-group | [x] | [x] | [x] | [x] | [x] |
| claude-print-driver.direct-failure-and-retry-preserve-side-effect-safety | [x] | [x] | [x] | [x] | [x] |
| claude-print-driver.direct-driver-has-no-inference-liveness-timeout | [x] | [x] | [x] | [x] | [x] |
| claude-print-driver.direct-concurrent-invocations-are-isolated | [x] | [x] | [x] | [x] | [x] |
| claude-print-driver.direct-image-behavior-matches-bridge-contract | [x] | [x] | [x] | [x] | [x] |
| claude-print-driver.direct-steering-uses-abort-and-fresh-dispatch | [x] | [x] | [x] | [x] | [x] |
| claude-print-driver.direct-driver-avoids-mutable-claude-filesystem-coupling | [x] | [x] | [x] | [x] | [x] |
