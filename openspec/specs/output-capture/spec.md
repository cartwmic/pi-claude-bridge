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

The bridge SHALL inspect each tool in `Context.tools[]` **only at the start of a fresh user turn** (i.e. only when the bridge's dispatch would otherwise enter the fresh-turn path). On tool-result delivery calls (`lastMsg.role === "toolResult"`), classification SHALL NOT run and the existing tool-result handling SHALL be invoked unchanged. When classification does run, it SHALL partition `Context.tools[]` into **executable tools** (those whose `name` matches an entry returned by `pi.getActiveTools()`) and **capture tools** (the remainder). Using `getActiveTools()` rather than `getAllTools()` ensures registered-but-inactive tool names are correctly classified as capture-side. Executable tools SHALL continue to be exposed to the inference driver via the bridge's MCP shim unchanged. Capture tools SHALL be exposed to the inference driver as the **sole MCP tool** for a dedicated forced-tool-call invocation; all native built-in tools SHALL be in the disallow list per constitution principle IV; no other MCP tools SHALL be advertised on that invocation.

#### Scenario: All tools are pi-registered

- **WHEN** `complete()` is invoked with `ctx.tools = [registeredA, registeredB]`
- **THEN** both tools are exposed via the MCP shim on the main-provider path
- **AND** no forced-tool-call capture invocation is started
- **AND** the existing main-provider behavior runs unchanged

#### Scenario: One tool is unregistered, no other tools

- **WHEN** `complete()` is invoked with `ctx.tools = [unregisteredCapture]` and `unregisteredCapture.name` is not in `pi.getActiveTools()`
- **THEN** no MCP tool is registered for `unregisteredCapture` on the main-provider path
- **AND** a fresh PTY is spawned on the isolated capture path with the shim advertising only `unregisteredCapture`
- **AND** the driver invocation's disallow list includes all native built-in tools

#### Scenario: Registered-but-inactive tool is treated as capture

- **WHEN** `complete()` is invoked with `ctx.tools = [tool]` where `tool.name` is in `pi.getAllTools()` but NOT in `pi.getActiveTools()`
- **THEN** the bridge classifies `tool` as a capture tool
- **AND** if the rest of the call shape is valid, the capture path runs

#### Scenario: Tool-result delivery does not trigger classification

- **WHEN** the bridge's dispatch is invoked with `lastMsg.role === "toolResult"` and an active main-provider frame is present
- **THEN** the bridge does NOT run capture classification
- **AND** the existing tool-result delivery path runs unchanged

#### Scenario: Empty `ctx.tools`

- **WHEN** `complete()` is invoked with `ctx.tools = undefined` or `ctx.tools = []`
- **THEN** the existing main-provider path is used unchanged
- **AND** no forced-tool-call capture invocation is started

### Requirement: Strict call-shape — capture mode mutually exclusive with executable tools, root must be object

The bridge SHALL accept only two `ctx.tools` shapes when classification produces any capture tools:
1. Exactly one capture tool **and zero executable tools**, AND that capture tool's root schema has `type === "object"` (the capture path runs); or
2. Any other shape — multiple capture tools, one or more capture tools alongside any executable tools, or a single capture tool whose root schema is non-object — is rejected.

When the call shape is rejected, the bridge SHALL NOT invoke the inference driver and SHALL push a `start` event followed by an `error` event on the pi-ai stream whose `errorMessage` names the offending tools (or the offending root type) and states the call-shape limitation. `complete()` SHALL resolve with an `AssistantMessage` whose `stopReason === "error"`.

#### Scenario: Two unregistered tools rejected

- **WHEN** `complete()` is invoked with `ctx.tools = [unregisteredA, unregisteredB]` and neither is in `pi.getActiveTools()`
- **THEN** the bridge does not invoke the inference driver
- **AND** the pi-ai stream emits `start` then `error` whose `errorMessage` names both `unregisteredA` and `unregisteredB` and references the one-capture-tool-per-call limitation
- **AND** `complete()` resolves with an `AssistantMessage` whose `stopReason === "error"`

#### Scenario: One unregistered tool alongside an executable tool rejected

- **WHEN** `complete()` is invoked with `ctx.tools = [registeredA, unregisteredCapture]` and `registeredA.name ∈ pi.getActiveTools()` and `unregisteredCapture.name ∉ pi.getActiveTools()`
- **THEN** the bridge does not invoke the inference driver
- **AND** the pi-ai stream emits `start` then `error` whose `errorMessage` names `unregisteredCapture` and the executable tool present, and states that capture mode is mutually exclusive with executable tools in v1
- **AND** `complete()` resolves with an `AssistantMessage` whose `stopReason === "error"`

#### Scenario: One capture tool with non-object root rejected

- **WHEN** `complete()` is invoked with `ctx.tools = [unregisteredCapture]` and `unregisteredCapture.parameters` has `type !== "object"`
- **THEN** the bridge does not invoke the inference driver
- **AND** the pi-ai stream emits `start` then `error` whose `errorMessage` references the offending root `type` and states that capture mode requires an object root
- **AND** `complete()` resolves with an `AssistantMessage` whose `stopReason === "error"`

#### Scenario: One capture tool with object root accepted

- **WHEN** `complete()` is invoked with `ctx.tools = [unregisteredCapture]`, no other tools, and `unregisteredCapture.parameters.type === "object"`
- **THEN** the bridge accepts the call
- **AND** the capture path spawns a dedicated PTY with the capture tool advertised as the sole MCP tool

### Requirement: Capture path isolation

The capture path SHALL be implemented as a dedicated function that does not interact with the bridge's user-session state. While running, the capture path SHALL NOT push any frame onto the main-provider active-frame stack, SHALL NOT supersede or interrupt any active main-provider frame, SHALL NOT mutate the cross-call state variables `cachedSessionId`, `cachedSessionCwd`, or `lastSentMessageHashes`, and SHALL spawn its own PTY rooted at `os.tmpdir()` by default (unless the caller specifies a different cwd).

#### Scenario: Capture call concurrent with active user turn does not interrupt the user

- **WHEN** a user's interactive pi turn is in flight (a main-provider frame is on the active-frame stack)
- **AND** a capture-shape `complete()` call is invoked concurrently
- **THEN** the bridge does not supersede or interrupt the user's main-provider frame
- **AND** the user's frame remains on the stack, unmodified, until the user's own lifecycle completes
- **AND** the user's pi-ai stream does not receive any `error` event attributable to the capture call

#### Scenario: Capture call does not pollute cached session

- **WHEN** a capture-shape `complete()` call is invoked
- **AND** the capture call's PTY emits a fresh driver session id (observable in the transcript or the `SessionStart` payload)
- **THEN** `cachedSessionId` and `cachedSessionCwd` are not updated to the capture call's session
- **AND** any subsequent main-provider turn (`ctx.tools = []`) starts with the cache state it had before the capture call

#### Scenario: Capture call does not pollute message hashes

- **WHEN** a capture-shape `complete()` call is invoked
- **THEN** `lastSentMessageHashes` is not updated with the capture call's prompt hashes
- **AND** any subsequent main-provider turn does not register history divergence as a result of the capture call's prior execution

### Requirement: Synthesized `toolCall` content block on success

WHEN the capture path receives a valid IPC-stashed arguments object from the shim (per design D16/D21, the shim validates arguments against the capture tool's JSON schema before stashing), the bridge SHALL synthesize an `AssistantMessage` containing exactly one `toolCall` content block whose `name` equals the capture tool's name and whose `arguments` equals the stashed arguments. The IPC stash is the AUTHORITATIVE result source (per D21). The transcript is consulted ONLY for `usage` / `cost` extraction (terminal `result` entry) and as a cross-check (verify a matching tool-use block was emitted; warn on divergence and trust the stash). The synthesized AssistantMessage SHALL be built via the same `newTurnOutput(model)` helper the main-provider path uses. Usage propagation maps transcript fields `input_tokens` → `usage.input`, `output_tokens` → `usage.output`, `cache_read_input_tokens` → `usage.cacheRead`, `cache_creation_input_tokens` → `usage.cacheWrite`; `calculateCost(model, usage)` populates cost fields. The bridge SHALL push a `done` event with `reason: "toolUse"` carrying that AssistantMessage on the pi-ai stream and end the stream.

#### Scenario: Successful capture

- **WHEN** the shim has IPC-stashed validated arguments `{ headline: "X", body: "Y" }` for capture tool `submit_digest`
- **AND** the PTY's transcript terminal `result` entry shows `usage.input_tokens = 100`, `usage.output_tokens = 50`, `usage.cache_read_input_tokens = 10`, `usage.cache_creation_input_tokens = 0`
- **THEN** the pi-ai stream's `done` event carries an `AssistantMessage` with `stopReason === "toolUse"`
- **AND** the AssistantMessage's `content` contains exactly one `toolCall` block with `name === "submit_digest"` and `arguments === { headline: "X", body: "Y" }`
- **AND** the AssistantMessage's `usage.input === 100`, `usage.output === 50`, `usage.cacheRead === 10`, `usage.cacheWrite === 0`
- **AND** the AssistantMessage's `usage.cost` is populated
- **AND** `complete()` resolves with that AssistantMessage

#### Scenario: IPC stash present but transcript divergent (Round-5 B.P1#3)

- **WHEN** the shim has IPC-stashed validated arguments for the capture tool
- **AND** the transcript JSONL does not (yet) show the corresponding tool-use block at Stop time (race, truncation, or settle-window-exceeded)
- **THEN** the IPC stash is authoritative; the bridge synthesizes the success AssistantMessage from the stashed arguments
- **AND** the bridge emits a warn-level log entry naming the divergence
- **AND** `usage` / `cost` fields fall back to whatever the terminal `result` JSONL entry contained (zeroes if absent)

#### Scenario: Caller receives the same shape as direct providers

- **WHEN** a caller passes the same `ctx.tools` to claude-bridge that it passes to anthropic / openai / google providers
- **THEN** the returned `AssistantMessage.content` exposes a `toolCall` block in the same position as direct providers
- **AND** the caller's existing branching on `model.provider !== "claude-bridge"` (if any) is no longer necessary for capture-shape responses

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
The capture path SHALL forward `context.systemPrompt` to the PTY driver as the static system prompt (instead of replacing it with the agent-loop path's `"You are a helpful coding assistant."`). The capture path SHALL replay the `context.messages` array as the prompt by calling the existing `buildColdStartPrompt(context.messages)` helper. Replay is **text-only and lossy at every position** (current user message included, not just history): image content blocks are dropped (per `messageContentToText`), assistant tool-call arguments are truncated to 200 chars, and tool-result content is truncated to 500 chars. This is a documented limitation of v1 capture mode; callers that need image fidelity or untruncated tool-call history should not use capture mode for that input. Pi-skills / AGENTS / APPEND_SYSTEM blending logic SHALL NOT be applied on the capture path — those are pi-UI concerns and capture callers are pi-ai consumers.

#### Scenario: Caller's system prompt reaches the model
- **WHEN** `complete()` is invoked with `ctx.systemPrompt = "You are a digest writer. Output ONLY a JSON object matching the schema."` and a single capture tool
- **THEN** the PTY driver invocation's `systemPrompt` input equals that string verbatim
- **AND** no pi-UI append blocks (skills, AGENTS, APPEND_SYSTEM) are concatenated to it

#### Scenario: Multi-message capture preserves prior turns
- **WHEN** `complete()` is invoked with `ctx.messages = [user("A"), assistant("B"), user("now produce a digest")]` and a single capture tool
- **THEN** the PTY driver invocation's prompt contains a representation of all three messages (using `buildColdStartPrompt`)
- **AND** the synthesized `toolCall.arguments` reflect content informed by the earlier turns

### Requirement: Empty-prompt handling
The capture path SHALL accept calls where `context.systemPrompt` is non-empty even if `context.messages` produces no text via `buildColdStartPrompt` (matching direct-provider behavior for system-prompt-only calls). The capture path SHALL reject calls where BOTH `context.systemPrompt` is empty/missing AND `context.messages` produces no text, by pushing `start` + `error` whose `errorMessage` cites the empty-prompt condition.

#### Scenario: System-prompt-only call accepted
- **WHEN** `complete()` is invoked with `ctx.systemPrompt = "Produce a digest."`, `ctx.messages = []`, and a single object-root capture tool
- **THEN** the bridge starts the PTY driver invocation with that system prompt
- **AND** the capture path runs to completion (success or error per other requirements)

#### Scenario: Both empty rejected
- **WHEN** `complete()` is invoked with `ctx.systemPrompt` empty/missing AND `ctx.messages` producing no text via `buildColdStartPrompt`, plus a single capture tool
- **THEN** the bridge does not start a PTY driver invocation
- **AND** the pi-ai stream emits `start` then `error` whose `errorMessage` references the empty-prompt condition
- **AND** `complete()` resolves with `stopReason === "error"`

### Requirement: Capture path emits no intermediate stream events
The capture path's pi-ai event stream SHALL emit exactly: one `start` event when the PTY stream opens, then a single terminal `done(toolUse)` or `error` event at finalization. The capture path SHALL NOT push intermediate `text_start`, `text_delta`, `text_end`, `thinking_start`, `thinking_delta`, `thinking_end`, `toolcall_start`, `toolcall_delta`, or `toolcall_end` events. This preserves pi-ai's block-lifecycle invariant (every `*_delta` paired with a `*_start`/`*_end` indexed against `partial.content`).

#### Scenario: No partial deltas on the capture stream
- **WHEN** a capture call runs to completion (success or error)
- **THEN** the pi-ai event stream's emitted events consist of exactly: one `start`, then one terminal `done` or `error`
- **AND** no `*_delta`, `*_start` (other than the initial stream `start`), or `*_end` events appear

### Requirement: Capture path does not leak resources
On completion of a capture call (success or error), `runCaptureQueryPty` SHALL drain or interrupt its PTY driver invocation so that no zombie subprocess, MCP handler, or pending resolver remains. The text `[Tool execution interrupted by user before completion]` SHALL NOT appear in bridge logs as a consequence of capture-path completion (that text is reserved for the supersede path on the user-session stack, which the capture path does not touch).

#### Scenario: No drain text in logs after capture completes
- **WHEN** a capture call completes (success or error)
- **THEN** the bridge log for that call's lifecycle does not contain `[Tool execution interrupted by user before completion]`
- **AND** the bridge log does not contain `drainPendingResolversAsAborted` for the capture call

#### Scenario: Capture path PTY session is cleaned up
- **WHEN** a capture call completes
- **THEN** the PTY driver invocation for that call is no longer producing messages or holding resources (drained or interrupted)
- **AND** no entry remains for the capture call in any tracked-frame data structure

### Requirement: Surface absent capture-tool call as error

IF the capture path's PTY emits a `Stop` hook (turn complete) without the bridge having received any valid IPC-stashed arguments from the shim, THEN the bridge SHALL push an `error` event on the pi-ai stream whose `errorMessage` names the failure cause ("model did not call capture tool" if no stash and no tool-use block in transcript; "arguments failed schema validation" if the shim rejected one or more attempts via MCP error but no valid call followed) and end the stream. The error AssistantMessage SHALL also propagate the transcript's terminal `result` usage / cost where present, so callers can observe retry-cost on failures.

#### Scenario: Model returned text only, never called the capture tool

- **WHEN** the capture path's PTY transcript at `Stop` time contains assistant text blocks but no tool-use block matching the capture tool's name
- **THEN** the pi-ai stream emits `start` then `error` whose `errorMessage` references "model did not call capture tool"
- **AND** the AssistantMessage's usage fields are populated from the terminal `result` entry where present
- **AND** `complete()` resolves with an `AssistantMessage` whose `stopReason === "error"`

#### Scenario: Capture tool called with arguments failing schema validation

- **WHEN** the transcript contains a tool-use block for the capture tool whose arguments fail JSON-schema validation
- **THEN** the pi-ai stream emits `error` whose `errorMessage` references "arguments failed schema validation" and names at least one failing field path
- **AND** `complete()` resolves with `stopReason === "error"`

### Requirement: Capture path honors `AbortSignal`

WHEN pi signals abort on the current `AbortSignal` while a capture call is in flight, THE capture path SHALL deliver an interrupt to its PTY (per `claude-tui-driver.abort-propagates-to-the-pty`) and SHALL resolve `complete()` with `stopReason === "aborted"`.

#### Scenario: Abort during capture

- **WHEN** a capture-shape `complete()` is in flight and the caller's `AbortSignal` fires
- **THEN** the capture path interrupts its PTY
- **AND** the pi-ai stream pushes a `done` event with `reason: "aborted"`
- **AND** the resolved AssistantMessage's `stopReason === "aborted"`

