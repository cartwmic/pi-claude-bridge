# Capability: output-capture (delta)

External call-shape (`piAi.complete` with `ctx.tools = [captureTool]`) is
unchanged. The mechanism for enforcing schema-constrained structured output
shifts from the SDK's `outputFormat` option to a forced MCP tool-call on the
new claude-p driver path. v1 limitations from the original spec are
preserved verbatim. Requirements expressed in terms of SDK internals
(`outputFormat`, `result.structured_output`, `system:init`, SDK query) are
re-stated against the new driver. Requirements expressed purely in
externally-observable behavior are not duplicated here unless mechanism
wording requires update.

**Capture-path system prompt fidelity (Round-3 reconciliation):** the capture
path forwards `ctx.systemPrompt` verbatim per constitution V. No
capture-only system-prompt addendum is appended. Model steering relies on:
(a) the sole-tool advertisement on the MCP shim (no other tool is callable),
(b) the deterministic shim response per D16 ("Capture received. End your
turn now."), and (c) the disallow-set blocking any native-tool alternative.
If the model emits text alongside the tool call, the text is ignored per
clarify I3.

## ADDED Requirements

### Requirement: Capture path honors `AbortSignal`

WHEN pi signals abort on the current `AbortSignal` while a capture call is in flight, THE capture path SHALL abort its claude-p subprocess (per `claude-p-driver.abort-propagates-to-the-claude-p-subprocess`) and SHALL resolve `complete()` with `stopReason === "aborted"`.

#### Scenario: Abort during capture

- **WHEN** a capture-shape `complete()` is in flight and the caller's `AbortSignal` fires
- **THEN** the capture path aborts its claude-p subprocess
- **AND** the pi-ai stream pushes a `done` event with `reason: "aborted"`
- **AND** the resolved AssistantMessage's `stopReason === "aborted"`

## MODIFIED Requirements

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
- **AND** a fresh claude-p subprocess is spawned on the isolated capture path with the shim advertising only `unregisteredCapture`
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
- **AND** the capture path spawns a dedicated claude-p subprocess with the capture tool advertised as the sole MCP tool

### Requirement: Capture path isolation

The capture path SHALL be implemented as a dedicated function that does not interact with the bridge's user-session state. While running, the capture path SHALL NOT push any frame onto the main-provider active-frame stack, SHALL NOT supersede or interrupt any active main-provider frame, SHALL NOT mutate the cross-call state variables `cachedSessionId`, `cachedSessionCwd`, or `lastSentMessageHashes`, and SHALL spawn its own claude-p subprocess rooted at `os.tmpdir()` by default (unless the caller specifies a different cwd). The capture spawn SHALL use its OWN independent claude-p subprocess, MCP shim, in-process router state, and unix socket — disjoint from any concurrent main-provider spawn's — so a capture call running while a main turn's tool is parked (S25) shares no router map, socket, or `WaitForMcpServers` startup with the main spawn. (Gate G9 verifies the concurrent two-spawn case.)

#### Scenario: Capture call concurrent with active user turn does not interrupt the user

- **WHEN** a user's interactive pi turn is in flight (a main-provider frame is on the active-frame stack)
- **AND** a capture-shape `complete()` call is invoked concurrently
- **THEN** the bridge does not supersede or interrupt the user's main-provider frame
- **AND** the user's frame remains on the stack, unmodified, until the user's own lifecycle completes
- **AND** the user's pi-ai stream does not receive any `error` event attributable to the capture call

#### Scenario: Capture call does not pollute cached session

- **WHEN** a capture-shape `complete()` call is invoked
- **AND** the capture call emits a fresh driver session id (observable in claude-p's stdout result line)
- **THEN** `cachedSessionId` and `cachedSessionCwd` are not updated to the capture call's session
- **AND** any subsequent main-provider turn (`ctx.tools = []`) starts with the cache state it had before the capture call

#### Scenario: Capture call does not pollute message hashes

- **WHEN** a capture-shape `complete()` call is invoked
- **THEN** `lastSentMessageHashes` is not updated with the capture call's prompt hashes
- **AND** any subsequent main-provider turn does not register history divergence as a result of the capture call's prior execution

### Requirement: Synthesized `toolCall` content block on success

WHEN the capture path receives a valid IPC-stashed arguments object from the shim (per design D16/D21, the shim validates arguments against the capture tool's JSON schema before stashing), the bridge SHALL synthesize an `AssistantMessage` containing exactly one `toolCall` content block whose `name` equals the capture tool's name and whose `arguments` equals the stashed arguments. The IPC stash is the AUTHORITATIVE result source (per D21). claude-p's stdout terminal `result` line is consulted ONLY for `usage` / `cost` extraction, and claude-p's emitted tool-use lines only as a cross-check (verify a matching tool-use block was emitted; warn on divergence and trust the stash). There is no transcript-file read and no settle window — the bridge sees only claude-p's stdout. The synthesized AssistantMessage SHALL be built via the same `newTurnOutput(model)` helper the main-provider path uses. Usage propagation maps claude-p `result.usage` fields `input_tokens` → `usage.input`, `output_tokens` → `usage.output`, `cache_read_input_tokens` → `usage.cacheRead`, `cache_creation_input_tokens` → `usage.cacheWrite`; `calculateCost(model, usage)` populates cost fields. The bridge SHALL push a `done` event with `reason: "toolUse"` carrying that AssistantMessage on the pi-ai stream and end the stream.

#### Scenario: Successful capture

- **WHEN** the shim has IPC-stashed validated arguments `{ headline: "X", body: "Y" }` for capture tool `submit_digest`
- **AND** claude-p's stdout terminal `result` line shows `usage.input_tokens = 100`, `usage.output_tokens = 50`, `usage.cache_read_input_tokens = 10`, `usage.cache_creation_input_tokens = 0`
- **THEN** the pi-ai stream's `done` event carries an `AssistantMessage` with `stopReason === "toolUse"`
- **AND** the AssistantMessage's `content` contains exactly one `toolCall` block with `name === "submit_digest"` and `arguments === { headline: "X", body: "Y" }`
- **AND** the AssistantMessage's `usage.input === 100`, `usage.output === 50`, `usage.cacheRead === 10`, `usage.cacheWrite === 0`
- **AND** the AssistantMessage's `usage.cost` is populated
- **AND** `complete()` resolves with that AssistantMessage

#### Scenario: IPC stash present but transcript divergent (Round-5 B.P1#3)

- **WHEN** the shim has IPC-stashed validated arguments for the capture tool
- **AND** claude-p's stdout does not (yet) show the corresponding tool-use block at turn-end (race or truncation in claude-p's stdout)
- **THEN** the IPC stash is authoritative; the bridge synthesizes the success AssistantMessage from the stashed arguments
- **AND** the bridge emits a warn-level log entry naming the divergence
- **AND** `usage` / `cost` fields fall back to whatever the terminal `result` line contained (zeroes if absent)

#### Scenario: Caller receives the same shape as direct providers

- **WHEN** a caller passes the same `ctx.tools` to claude-bridge that it passes to anthropic / openai / google providers
- **THEN** the returned `AssistantMessage.content` exposes a `toolCall` block in the same position as direct providers
- **AND** the caller's existing branching on `model.provider !== "claude-bridge"` (if any) is no longer necessary for capture-shape responses

### Requirement: Surface absent capture-tool call as error

IF the capture path's claude-p subprocess emits its terminal `result` line (turn complete) without the bridge having received any valid IPC-stashed arguments from the shim, THEN the bridge SHALL push an `error` event on the pi-ai stream whose `errorMessage` names the failure cause ("model did not call capture tool" if no stash and no tool-use line in claude-p's stdout; "arguments failed schema validation" if the shim rejected one or more attempts via MCP error but no valid call followed) and end the stream. The error AssistantMessage SHALL also propagate claude-p's terminal `result.usage` / cost where present, so callers can observe retry-cost on failures.

#### Scenario: Model returned text only, never called the capture tool

- **WHEN** the capture path's claude-p stdout at turn-end contains assistant text blocks but no tool-use block matching the capture tool's name
- **THEN** the pi-ai stream emits `start` then `error` whose `errorMessage` references "model did not call capture tool"
- **AND** the AssistantMessage's usage fields are populated from the terminal `result` entry where present
- **AND** `complete()` resolves with an `AssistantMessage` whose `stopReason === "error"`

#### Scenario: Capture tool called with arguments failing schema validation

- **WHEN** claude-p's stdout contains a tool-use line for the capture tool whose arguments fail JSON-schema validation
- **THEN** the pi-ai stream emits `error` whose `errorMessage` references "arguments failed schema validation" and names at least one failing field path
- **AND** `complete()` resolves with `stopReason === "error"`

---

## Acceptance criterion quality checklist

| AC ID | Testable | Solution-free | Unambiguous | Consistent | Complete |
|---|---|---|---|---|---|
| output-capture.output-capture-classification-of-ctx-tools | [ ] | [ ] | [ ] | [ ] | [ ] |
| output-capture.strict-call-shape-capture-mode-mutually-exclusive-with-executable-tools-root-must-be-object | [ ] | [ ] | [ ] | [ ] | [ ] |
| output-capture.capture-path-isolation | [ ] | [ ] | [ ] | [ ] | [ ] |
| output-capture.synthesized-toolcall-content-block-on-success | [ ] | [ ] | [ ] | [ ] | [ ] |
| output-capture.surface-absent-capture-tool-call-as-error | [ ] | [ ] | [ ] | [ ] | [ ] |
| output-capture.capture-path-honors-abortsignal | [ ] | [ ] | [ ] | [ ] | [ ] |
