# Capability: output-capture

<!-- authored: in-session -->

## MODIFIED Requirements

### Requirement: Output-capture classification of `ctx.tools`

The bridge SHALL classify tools only at fresh user-turn dispatch, partitioning active pi tools as executable and all others as capture tools. Executable tools remain on main provider. A valid capture tool is exposed as sole MCP tool for a dedicated invocation through the owning invocation's selected driver; all native tools and foreign MCP tools remain unavailable.

#### Scenario: All tools are pi-registered
- **WHEN** `ctx.tools` contains only active pi tools
- **THEN** tools are exposed on main-provider shim and no capture invocation starts

#### Scenario: One unregistered tool, no others
- **WHEN** `ctx.tools` contains one unregistered capture tool
- **THEN** a dedicated selected-driver capture process starts with only that tool

#### Scenario: Registered-but-inactive tool
- **WHEN** a tool is registered but not active
- **THEN** it is classified as capture-side

#### Scenario: Tool-result delivery
- **WHEN** last message is a tool result and active main frame exists
- **THEN** classification does not run and existing delivery path continues

#### Scenario: Empty tools
- **WHEN** tools are absent or empty
- **THEN** main-provider path runs with no capture invocation

### Requirement: Strict call-shape — capture mode mutually exclusive with executable tools, root must be object

THE bridge SHALL accept capture only for exactly one capture tool, zero executable tools, and object-root schema; any other capture-bearing shape SHALL invoke no driver, emit `start` then `error` naming offending tools or root type, and resolve an assistant with `stopReason === "error"`.

#### Scenario: Two capture tools rejected
- **IF** classification yields two capture tools
- **THEN** no driver starts and stream resolves error naming both tools and one-tool limit

#### Scenario: Capture plus executable rejected
- **IF** classification yields capture and executable tools together
- **THEN** no driver starts and error names mutual-exclusion violation

#### Scenario: Non-object root rejected
- **IF** sole capture tool has non-object root
- **THEN** no driver starts and error names root type requirement

#### Scenario: Object-root capture accepted
- **WHEN** sole capture tool has object root and no executable tools
- **THEN** selected driver starts dedicated capture process with sole MCP tool

### Requirement: Capture path isolation

THE capture path SHALL not interact with user-session state: no main frame push, no supersede/interrupt, no main cache/hash mutation. It SHALL default process cwd to `os.tmpdir()` while retaining driver selected from owning project invocation, and SHALL own a disjoint selected-driver process, shim, router, socket, queues, and correlation domain.

#### Scenario: Capture concurrent with active main turn
- **WHEN** capture runs while main frame is in flight
- **THEN** main frame remains unmodified and receives no capture error

#### Scenario: Capture session does not pollute cache
- **WHEN** capture emits a session id
- **THEN** main cached session id, driver identity, and cwd remain unchanged

#### Scenario: Capture does not pollute message hashes
- **WHEN** capture runs
- **THEN** main history baseline remains unchanged

### Requirement: Synthesized `toolCall` content block on success

WHEN selected-driver capture receives schema-validated IPC-stashed arguments and selected driver completes successfully with required terminal result, THE bridge SHALL synthesize exactly one provider-compatible pi `toolCall`; IPC stash is authoritative for arguments, observed tool-use is only cross-check, normalized terminal usage maps `input_tokens`→`usage.input`, `output_tokens`→`usage.output`, `cache_read_input_tokens`→`usage.cacheRead`, `cache_creation_input_tokens`→`usage.cacheWrite`, then model cost calculation runs exactly once for pi-visible cost while driver-reported billing remains diagnostics/accounting metadata.

#### Scenario: Successful capture
- **WHEN** stash contains valid arguments and terminal usage exists
- **THEN** returned assistant has one matching `toolCall`, `toolUse` stop reason, mapped usage, and calculated cost

#### Scenario: Stash present but observed stream divergent
- **WHEN** valid stash exists, selected driver terminates successfully, but stream lacks matching tool observation
- **THEN** bridge warns, trusts stash, and uses terminal usage

#### Scenario: Stash present but terminal result missing
- **IF** valid stash exists but selected driver closes without required successful terminal result
- **THEN** bridge surfaces selected-driver error and does not synthesize capture success

#### Scenario: Caller receives direct-provider shape
- **WHEN** caller uses same capture tool shape across providers
- **THEN** returned `toolCall` shape needs no claude-bridge special case

### Requirement: Surface absent capture-tool call as error

IF selected driver completes without valid IPC stash, THEN capture SHALL emit `start` then `error`, resolve `stopReason === "error"`, distinguish no call from schema-validation failure with field path when available, retain terminal usage/cost, and SHALL not retry through the other driver.

#### Scenario: Text only
- **IF** selected driver completes with no capture stash or matching valid call
- **THEN** error names model did not call capture tool and maps terminal usage

#### Scenario: Invalid arguments only
- **IF** all capture attempts fail schema validation
- **THEN** error names validation failure and at least one field path

### Requirement: Capture path honors `AbortSignal`

WHEN capture abort signal fires, THE capture path SHALL abort and reap its selected-driver process and resolve aborted.

#### Scenario: Abort during capture
- **WHEN** capture is in flight and signal fires
- **THEN** selected process is aborted, stream emits `done(aborted)`, and result stop reason is aborted

### Requirement: Capture path forwards `systemPrompt` and replays message history (text-only, lossy)

THE capture path SHALL forward caller system prompt verbatim to selected driver and replay all messages through the existing cold-start text conversion, dropping images with warning at every position, truncating assistant tool-call arguments to 200 characters and tool-result content to 500 characters, while pi-UI prompt blending SHALL not apply.

#### Scenario: Caller system prompt reaches selected driver
- **WHEN** capture caller supplies system prompt
- **THEN** selected driver's static system prompt equals it with no pi-UI append blocks

#### Scenario: Multi-message capture preserves prior turns
- **WHEN** capture context has multiple prior messages
- **THEN** text replay represents all messages and result may use prior content

### Requirement: Capture path does not leak resources

ON capture completion, THE bridge SHALL tear down selected-driver process, shim, and IPC so no zombie, handler, resolver, synthetic user-facing interruption text, or main-frame resolver-drain log remains.

#### Scenario: No user-stack drain text
- **WHEN** capture completes
- **THEN** no supersede drain text or `drainPendingResolversAsAborted` log is produced for capture

#### Scenario: Capture resources cleaned
- **WHEN** capture completes
- **THEN** selected process and shim stop and no tracked frame entry remains

### Requirement: Empty-prompt handling

THE capture path SHALL accept a non-empty system prompt with empty message replay and SHALL reject both empty system prompt and empty message replay before selected-driver spawn.

#### Scenario: System-prompt-only call accepted
- **WHEN** system prompt is non-empty, messages are empty, and one object-root capture tool exists
- **THEN** selected-driver capture process starts with that system prompt

#### Scenario: Both empty rejected
- **IF** system prompt and replayed message text are both empty
- **THEN** no driver starts, stream emits `start` then `error` naming empty prompt, and result stop reason is error

### Requirement: Capture path emits no intermediate stream events

THE capture path through either driver SHALL emit exactly one `start` followed by one terminal `done(toolUse)` or `error` and SHALL not emit text, thinking, or tool-call partial lifecycle events.

#### Scenario: Direct partial records suppressed
- **WHEN** direct capture emits thinking, text, tool-use, or input-json partial records
- **THEN** capture pi stream still contains only initial start and terminal event

## ADDED Requirements

### Requirement: Capture Uses Owning Invocation Driver

WHEN a valid capture call starts, THE bridge SHALL use the owning invocation's pinned driver and SHALL preserve existing forced-MCP, isolation, prompt-fidelity, text-only replay, stash-authority, usage, and terminal-stream contracts.

#### Scenario: Direct-driver capture succeeds
- **WHEN** owner selects `claude-print` and sole tool receives valid args
- **THEN** direct process uses capture shim and stash becomes exactly one pi `toolCall`

#### Scenario: Interactive capture remains unchanged
- **WHEN** owner selects `claude-p`
- **THEN** existing interactive capture result shape remains

#### Scenario: Capture driver fails
- **IF** selected capture driver fails without valid stash
- **THEN** its error surfaces and other driver is not used

---

## Acceptance criterion quality checklist

| AC ID | Testable | Solution-free | Unambiguous | Consistent | Complete |
|---|---|---|---|---|---|
| output-capture.output-capture-classification-of-ctx-tools | [x] | [x] | [x] | [x] | [x] |
| output-capture.strict-call-shape-capture-mode-mutually-exclusive-with-executable-tools-root-must-be-object | [x] | [x] | [x] | [x] | [x] |
| output-capture.capture-path-isolation | [x] | [x] | [x] | [x] | [x] |
| output-capture.synthesized-toolcall-content-block-on-success | [x] | [x] | [x] | [x] | [x] |
| output-capture.surface-absent-capture-tool-call-as-error | [x] | [x] | [x] | [x] | [x] |
| output-capture.capture-path-honors-abortsignal | [x] | [x] | [x] | [x] | [x] |
| output-capture.capture-path-forwards-systemprompt-and-replays-message-history-text-only-lossy | [x] | [x] | [x] | [x] | [x] |
| output-capture.capture-path-does-not-leak-resources | [x] | [x] | [x] | [x] | [x] |
| output-capture.empty-prompt-handling | [x] | [x] | [x] | [x] | [x] |
| output-capture.capture-path-emits-no-intermediate-stream-events | [x] | [x] | [x] | [x] | [x] |
| output-capture.capture-uses-owning-invocation-driver | [x] | [x] | [x] | [x] | [x] |
