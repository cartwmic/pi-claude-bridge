# output-capture Specification

## Purpose
TBD - created by archiving change bridge-output-capture-via-output-format. Update Purpose after archive.
## Requirements
### Requirement: `piApiRef === null` fallback
When the bridge module is loaded outside an active pi extension runtime (no `piApiRef`, or `piApiRef.getActiveTools()` throws), the classifier SHALL treat the active-tool set as empty. With an empty active-tool set, every entry in `ctx.tools` is classified as a capture tool, and the strict call-shape rules apply. This guarantees the capture path is the only path reachable when pi is not bound, rather than silently routing to MCP for tools pi cannot execute.

#### Scenario: Bridge loaded with `piApiRef === null`
- **WHEN** `complete()` is invoked while `piApiRef === null` (e.g. early module-load probe before the default-export setup runs, or a standalone test)
- **THEN** every tool in `ctx.tools` is classified as a capture tool
- **AND** call-shape validation applies normally (zero tools → fall through; one object-root tool → capture path; otherwise reject)

### Requirement: Output-capture classification of `ctx.tools`
The bridge SHALL inspect each tool in `Context.tools[]` **only at the start of a fresh user turn** (i.e. only when the existing dispatch in `streamClaudeAgentSdk` would enter Case 3, the fresh-turn path). On tool-result delivery calls (lastMsg.role === "toolResult"; Cases 1 and 2 in the existing dispatch), classification SHALL NOT run and the existing tool-result handling SHALL be invoked unchanged. When classification does run, it SHALL partition `Context.tools[]` into **executable tools** (those whose `name` matches an entry returned by `pi.getActiveTools()`) and **capture tools** (the remainder). Using `getActiveTools()` rather than `getAllTools()` ensures registered-but-inactive tool names are correctly classified as capture-side (otherwise pi would not deliver `tool_result` for them and MCP routing would never terminate). Executable tools SHALL continue to be exposed via the bridge's MCP server unchanged. Capture tools SHALL be expressed via the SDK's `outputFormat` option, not via MCP.

#### Scenario: All tools are pi-registered
- **WHEN** `complete()` is invoked with `ctx.tools = [registeredA, registeredB]`
- **THEN** both tools are exposed as MCP tools to the SDK
- **AND** no `outputFormat` is set on the SDK query
- **AND** the existing agent-loop behavior is used unchanged

#### Scenario: One tool is unregistered, no other tools
- **WHEN** `complete()` is invoked with `ctx.tools = [unregisteredCapture]` and `unregisteredCapture.name` is not in `pi.getActiveTools()`
- **THEN** no MCP tool is registered for `unregisteredCapture`
- **AND** the SDK query is configured with `outputFormat: { type: "json_schema", schema: <deep clone of unregisteredCapture.parameters> }`
- **AND** the call runs on the isolated capture path (see "Capture path isolation" requirement)

#### Scenario: Registered-but-inactive tool is treated as capture
- **WHEN** `complete()` is invoked with `ctx.tools = [tool]` where `tool.name` is in `pi.getAllTools()` but NOT in `pi.getActiveTools()` (e.g. a tool the user disabled via `pi.setActiveTools`)
- **THEN** the bridge classifies `tool` as a capture tool
- **AND** if the rest of the call shape is valid, the capture path runs (rather than attempting MCP routing that pi would never terminate)

#### Scenario: Tool-result delivery does not trigger classification
- **WHEN** `streamClaudeAgentSdk` is invoked with `lastMsg.role === "toolResult"` and an active frame is on the stack
- **THEN** the bridge does NOT run capture classification
- **AND** the existing Case 1 (tool-result delivery for the active frame) or Case 2 (orphaned tool-result) path runs unchanged
- **AND** no error event is emitted citing the capture-shape limitation, regardless of what `ctx.tools` contains

#### Scenario: Empty `ctx.tools`
- **WHEN** `complete()` is invoked with `ctx.tools = undefined` or `ctx.tools = []`
- **THEN** the existing agent-loop path is used unchanged
- **AND** no `outputFormat` is set on the SDK query

### Requirement: Strict call-shape — capture mode mutually exclusive with executable tools, root must be object
The bridge SHALL accept only two `ctx.tools` shapes when classification produces any capture tools:
1. Exactly one capture tool **and zero executable tools**, AND that capture tool's root schema (after the deep clone in "Deep schema clone for `outputFormat`") has `type === "object"` (the capture path runs); or
2. Any other shape — multiple capture tools, one or more capture tools alongside any executable tools, or a single capture tool whose root schema is non-object — is rejected.

When the call shape is rejected, the bridge SHALL NOT start any SDK query and SHALL push a `start` event followed by an `error` event on the pi-ai stream whose `errorMessage` names the offending tools (or the offending root type) and states the call-shape limitation. `complete()` SHALL resolve with an `AssistantMessage` whose `stopReason === "error"`.

#### Scenario: Two unregistered tools rejected
- **WHEN** `complete()` is invoked with `ctx.tools = [unregisteredA, unregisteredB]` and neither is in `pi.getActiveTools()`
- **THEN** the bridge does not start a Claude SDK query
- **AND** the pi-ai stream emits `start` then `error` whose `errorMessage` names both `unregisteredA` and `unregisteredB` and references the one-capture-tool-per-call limitation
- **AND** `complete()` resolves with an `AssistantMessage` whose `stopReason === "error"`

#### Scenario: One unregistered tool alongside an executable tool rejected
- **WHEN** `complete()` is invoked with `ctx.tools = [registeredA, unregisteredCapture]` and `registeredA.name ∈ pi.getActiveTools()` and `unregisteredCapture.name ∉ pi.getActiveTools()`
- **THEN** the bridge does not start a Claude SDK query
- **AND** the pi-ai stream emits `start` then `error` whose `errorMessage` names `unregisteredCapture` and the executable tool present, and states that capture mode is mutually exclusive with executable tools in v1
- **AND** `complete()` resolves with an `AssistantMessage` whose `stopReason === "error"`

#### Scenario: One capture tool with non-object root rejected
- **WHEN** `complete()` is invoked with `ctx.tools = [unregisteredCapture]` and `unregisteredCapture.parameters` has `type !== "object"` (e.g. `Type.Array(...)`, `Type.String(...)`)
- **THEN** the bridge does not start a Claude SDK query
- **AND** the pi-ai stream emits `start` then `error` whose `errorMessage` references the offending root `type` and states that capture mode requires an object root
- **AND** `complete()` resolves with an `AssistantMessage` whose `stopReason === "error"`

#### Scenario: One capture tool with object root accepted
- **WHEN** `complete()` is invoked with `ctx.tools = [unregisteredCapture]`, no other tools, and `unregisteredCapture.parameters.type === "object"`
- **THEN** the bridge accepts the call
- **AND** the capture path runs

### Requirement: Capture path isolation
The capture path SHALL be implemented as a dedicated function (`runCaptureQuery`) that does not interact with the bridge's user-session state. While running, the capture path SHALL NOT push any frame onto the active-frame stack used by the agent-loop path, SHALL NOT supersede or interrupt any active user frame, and SHALL NOT mutate the cross-call state variables `cachedSessionId`, `cachedSessionCwd`, or `lastSentMessageHashes` at any point in its lifecycle (including on the SDK's mid-flight `system:init` message).

#### Scenario: Capture call concurrent with active user turn does not interrupt the user
- **WHEN** a user's interactive pi turn is in flight (an executable-mode frame is on the active-frame stack)
- **AND** a capture-shape `complete()` call is invoked concurrently
- **THEN** the bridge does not log `streamSimple: superseding active frame` for the user's frame
- **AND** the bridge does not call `interrupt()` on the user's SDK query as a result of the capture call
- **AND** the user's frame remains on the stack, unmodified, until the user's own lifecycle completes
- **AND** the user's pi-ai stream does not receive any `error` event attributable to the capture call

#### Scenario: Capture call does not pollute cached session
- **WHEN** a capture-shape `complete()` call is invoked
- **AND** the capture call's SDK query receives a `system:init` message carrying a fresh `session_id`
- **THEN** `cachedSessionId` and `cachedSessionCwd` are not updated to the capture call's session
- **AND** any subsequent normal pi turn (`ctx.tools = []`) starts with the cache state it had before the capture call

#### Scenario: Capture call does not pollute message hashes
- **WHEN** a capture-shape `complete()` call is invoked
- **THEN** `lastSentMessageHashes` is not updated with the capture call's prompt hashes
- **AND** any subsequent normal pi turn does not register history divergence as a result of the capture call's prior execution

### Requirement: Synthesized `toolCall` content block on success
When the capture path's SDK query emits a `result` SDKMessage with `result.structured_output !== undefined`, the bridge SHALL synthesize an `AssistantMessage` containing exactly one `toolCall` content block whose `name` equals the capture tool's name and whose `arguments` equals `result.structured_output`. The synthesized AssistantMessage SHALL be built via the same `newTurnOutput(model)` helper the agent-loop path uses (so `api`, `provider`, `model`, and `timestamp` fields are populated correctly). The bridge SHALL propagate `result.usage` onto the AssistantMessage's usage fields (mapping `input_tokens` → `usage.input`, `output_tokens` → `usage.output`, `cache_read_input_tokens` → `usage.cacheRead`, `cache_creation_input_tokens` → `usage.cacheWrite`) and SHALL call `calculateCost(model, usage)` to populate cost fields. The bridge SHALL push a `done` event with `reason: "toolUse"` carrying that AssistantMessage on the pi-ai stream and end the stream.

#### Scenario: Successful capture
- **WHEN** the SDK returns `result.structured_output = { headline: "X", body: "Y" }` for a capture tool named `submit_digest`, with `result.usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 }`
- **THEN** the pi-ai stream's `done` event carries an `AssistantMessage` with `stopReason === "toolUse"`
- **AND** the AssistantMessage's `content` contains exactly one `toolCall` block with `name === "submit_digest"` and `arguments === { headline: "X", body: "Y" }`
- **AND** the AssistantMessage's `usage.input === 100`, `usage.output === 50`, `usage.cacheRead === 10`, `usage.cacheWrite === 0`
- **AND** the AssistantMessage's `usage.cost` is populated (via `calculateCost(model, usage)`)
- **AND** `complete()` resolves with that AssistantMessage

#### Scenario: Caller receives the same shape as direct providers
- **WHEN** a caller previously branched on `model.provider !== "claude-bridge"` to skip `ctx.tools` and parse JSON from text
- **THEN** with this change in place the caller can pass the same `ctx.tools` to claude-bridge that it passes to anthropic / openai / google providers
- **AND** the returned `AssistantMessage.content` exposes a `toolCall` block in the same position as direct providers

### Requirement: Surface terminal `result` lacking `structured_output` as error
When the capture path's SDK query emits a `result` SDKMessage with `result.structured_output === undefined` — regardless of `subtype` — the bridge SHALL push an `error` event on the pi-ai stream whose `errorMessage` includes the SDK `subtype` (and `is_error` if true) and end the stream. This SHALL apply to the documented `subtype === "error_max_structured_output_retries"` and to any other terminal `result` lacking `structured_output`. The error AssistantMessage SHALL also propagate `result.usage` / cost where present, so callers can observe retry-cost on failure.

#### Scenario: SDK exhausts validation retries
- **WHEN** the SDK emits `result.subtype === "error_max_structured_output_retries"` with no `structured_output` field
- **THEN** the pi-ai stream's `error` event has `reason === "error"`
- **AND** the AssistantMessage's `errorMessage` references `error_max_structured_output_retries`
- **AND** `complete()` resolves with that error AssistantMessage (it does not throw)

#### Scenario: Successful subtype but missing structured_output
- **WHEN** the SDK emits `result.subtype === "success"` but `result.structured_output` is `undefined`
- **THEN** the pi-ai stream's `error` event has `reason === "error"`
- **AND** the AssistantMessage's `errorMessage` references the subtype and the absence of `structured_output`
- **AND** `complete()` resolves with that error AssistantMessage (it does not throw)

### Requirement: Surface SDK iterator that closes without `result`
When the capture path's SDK iterator closes (via natural completion, transport error, or other early termination) without ever yielding a `result` SDKMessage, the bridge SHALL push an `error` event on the pi-ai stream whose `errorMessage` describes the unexpected stream closure and end the stream. `complete()` SHALL resolve with that error AssistantMessage; it SHALL NOT throw or hang.

#### Scenario: SDK iterator closes early
- **WHEN** the capture path's SDK iterator closes after yielding only `system:init` / partial assistant events, with no terminal `result` message
- **THEN** the pi-ai stream's `error` event has `reason === "error"`
- **AND** the AssistantMessage's `errorMessage` references unexpected iterator closure without `result`
- **AND** `complete()` resolves with that error AssistantMessage (it does not throw)

### Requirement: Surface synchronous SDK construction failure as error
When invoking the SDK `query` factory throws synchronously (e.g. invalid `outputFormat.schema`, subprocess `spawn` failure surfaced from the constructor, test-injected mock error), the bridge SHALL push `start` then `error` on the pi-ai stream whose `errorMessage` includes the thrown message, and end the stream. `complete()` SHALL resolve with that error AssistantMessage; it SHALL NOT propagate the throw to the caller.

#### Scenario: SDK constructor throws
- **WHEN** `_queryFactory({ prompt, options })` throws synchronously inside `runCaptureQuery`
- **THEN** the pi-ai stream emits `start` then `error` whose `errorMessage` references the constructor failure and the thrown message
- **AND** `complete()` resolves with an `AssistantMessage` whose `stopReason === "error"`

### Requirement: Deep schema clone for `outputFormat`
The schema submitted to the SDK's `outputFormat.schema` SHALL be a deep, JSON-only clone of the capture tool's `parameters`. The clone SHALL preserve every JSON-serializable schema keyword at every depth, including (non-exhaustively) `type`, `properties`, `items`, `required`, `enum`, `pattern`, `minLength`, `maxLength`, `minimum`, `maximum`, `minItems`, `maxItems`, `additionalProperties`, `description`. The clone SHALL drop symbol-keyed metadata at every depth (such as TypeBox's `Symbol(Kind)`, `Symbol(Modifier)`).

#### Scenario: Nested array length constraints survive
- **WHEN** the capture tool's `parameters` is a TypeBox `Type.Object({ topics: Type.Array(Type.String({ maxLength: 32 }), { maxItems: 5 }) })`
- **THEN** the schema submitted to `outputFormat.schema` contains both `properties.topics.items.maxLength === 32` and `properties.topics.maxItems === 5`
- **AND** no symbol-keyed properties appear at any depth of the cloned schema

#### Scenario: TypeBox optional fields survive
- **WHEN** the capture tool's `parameters` declares an optional field via `Type.Optional`
- **THEN** the cloned schema's `required` array reflects the optional field as not required
- **AND** the optional field's own schema is preserved under `properties`

### Requirement: Image-block warning on capture path
When `context.messages` contains any image content blocks (in any message position) at the start of a capture call, the bridge SHALL emit a structured WARN-level log line stating that the image blocks are being dropped due to capture-mode text-only replay. The bridge SHALL NOT reject the call; lossy text-only replay proceeds (per the message-history-replay requirement below).

#### Scenario: Image in current user message warns
- **WHEN** `complete()` is invoked with `ctx.messages = [{ role: "user", content: [{ type: "text", text: "describe this" }, { type: "image", source: {...} }] }]` and a single capture tool
- **THEN** the bridge emits a structured WARN-level log line referencing the dropped image block count and capture-mode text-only replay
- **AND** the call proceeds (text-only) and produces a `toolCall` content block per the success path

#### Scenario: Image in history warns
- **WHEN** `complete()` is invoked with `ctx.messages` containing image blocks in earlier user/assistant/toolResult messages
- **THEN** the bridge emits the same WARN log
- **AND** the call proceeds (text-only)

### Requirement: Capture path forwards `systemPrompt` and replays message history (text-only, lossy)
The capture path SHALL forward `context.systemPrompt` to the SDK as the static system prompt (instead of replacing it with the agent-loop path's `"You are a helpful coding assistant."`). The capture path SHALL replay the `context.messages` array as the SDK prompt by calling the existing `buildColdStartPrompt(context.messages)` helper. Replay is **text-only and lossy at every position** (current user message included, not just history): image content blocks are dropped (per `messageContentToText`), assistant tool-call arguments are truncated to 200 chars, and tool-result content is truncated to 500 chars. This is a documented limitation of v1 capture mode; callers that need image fidelity or untruncated tool-call history should not use capture mode for that input. Pi-skills / AGENTS / APPEND_SYSTEM blending logic SHALL NOT be applied on the capture path — those are pi-UI concerns and capture callers are pi-ai consumers.

#### Scenario: Caller's system prompt reaches the model
- **WHEN** `complete()` is invoked with `ctx.systemPrompt = "You are a digest writer. Output ONLY a JSON object matching the schema."` and a single capture tool
- **THEN** the SDK query's `systemPrompt` option equals that string verbatim
- **AND** no pi-UI append blocks (skills, AGENTS, APPEND_SYSTEM) are concatenated to it

#### Scenario: Multi-message capture preserves prior turns
- **WHEN** `complete()` is invoked with `ctx.messages = [user("A"), assistant("B"), user("now produce a digest")]` and a single capture tool
- **THEN** the SDK query's prompt contains a representation of all three messages (using `buildColdStartPrompt`)
- **AND** the synthesized `toolCall.arguments` reflect content informed by the earlier turns

### Requirement: Empty-prompt handling
The capture path SHALL accept calls where `context.systemPrompt` is non-empty even if `context.messages` produces no text via `buildColdStartPrompt` (matching direct-provider behavior for system-prompt-only calls). The capture path SHALL reject calls where BOTH `context.systemPrompt` is empty/missing AND `context.messages` produces no text, by pushing `start` + `error` whose `errorMessage` cites the empty-prompt condition.

#### Scenario: System-prompt-only call accepted
- **WHEN** `complete()` is invoked with `ctx.systemPrompt = "Produce a digest."`, `ctx.messages = []`, and a single object-root capture tool
- **THEN** the bridge starts the SDK query with that system prompt
- **AND** the capture path runs to completion (success or error per other requirements)

#### Scenario: Both empty rejected
- **WHEN** `complete()` is invoked with `ctx.systemPrompt` empty/missing AND `ctx.messages` producing no text via `buildColdStartPrompt`, plus a single capture tool
- **THEN** the bridge does not start a Claude SDK query
- **AND** the pi-ai stream emits `start` then `error` whose `errorMessage` references the empty-prompt condition
- **AND** `complete()` resolves with `stopReason === "error"`

### Requirement: Capture path emits no intermediate stream events
The capture path's pi-ai event stream SHALL emit exactly: one `start` event when the SDK iterator opens, then a single terminal `done(toolUse)` or `error` event at finalization. The capture path SHALL NOT push intermediate `text_start`, `text_delta`, `text_end`, `thinking_start`, `thinking_delta`, `thinking_end`, `toolcall_start`, `toolcall_delta`, or `toolcall_end` events. This preserves pi-ai's block-lifecycle invariant (every `*_delta` paired with a `*_start`/`*_end` indexed against `partial.content`).

#### Scenario: No partial deltas on the capture stream
- **WHEN** a capture call runs to completion (success or error)
- **THEN** the pi-ai event stream's emitted events consist of exactly: one `start`, then one terminal `done` or `error`
- **AND** no `*_delta`, `*_start` (other than the initial stream `start`), or `*_end` events appear

### Requirement: Capture path does not leak resources
On completion of a capture call (success or error), `runCaptureQuery` SHALL drain or interrupt its SDK query so that no zombie subprocess, MCP handler, or pending resolver remains. The text `[Tool execution interrupted by user before completion]` SHALL NOT appear in bridge logs as a consequence of capture-path completion (that text is reserved for the supersede path on the user-session stack, which the capture path does not touch).

#### Scenario: No drain text in logs after capture completes
- **WHEN** a capture call completes (success or error)
- **THEN** the bridge log for that call's lifecycle does not contain `[Tool execution interrupted by user before completion]`
- **AND** the bridge log does not contain `drainPendingResolversAsAborted` for the capture call

#### Scenario: Capture path SDK session is cleaned up
- **WHEN** a capture call completes
- **THEN** the SDK query for that call is no longer producing messages or holding resources (drained or interrupted)
- **AND** no entry remains for the capture call in any tracked-frame data structure

