# mcp-stdio-shim Specification

## Purpose

Stdio MCP server subprocess that exposes pi-bridged tools to the `claude`
process (spawned by claude-p, configured via `--mcp-config`) and proxies calls
back to the bridge's in-process router. The shim is the only bridge-controlled
interface the inference driver sees. It implements the **held-open promise-park**
that the Phase-0 spike validated: a `tools/call` is forwarded to the in-process
router, which parks a Promise and resolves it only when pi delivers the tool
result via the next `streamSimple()` — and `claude` (driven by claude-p) blocks
inline on that response.

**Note (replan):** the hook-relay role from the prior in-house-PTY plan is
REMOVED. claude-p owns `SessionStart`/`Stop` hook registration, so the shim is an
MCP server only. The shim is still a separate process invoked by `claude` via
`--mcp-config` (claude-p forwards `--mcp-config` to `claude`).

## Requirements

### Requirement: Shim exposes only pi-bridged tools

THE shim SHALL advertise to the inference driver exactly the set of tools the bridge's in-process router declares for the current spawn's turn, with names in the `mcp__custom-tools__*` namespace. THE shim SHALL NOT expose any tool not declared by the router for that turn.

#### Scenario: Shim handshake reflects router's tool set
- **WHEN** a turn initializes and the shim receives an MCP `initialize` request followed by `tools/list`
- **THEN** the shim returns exactly the tool definitions the router declared at shim-spawn time
- **AND** no tool outside `mcp__custom-tools__*` appears in the response

### Requirement: Shim forwards tool calls to the in-process router

WHEN the shim receives an MCP `tools/call` request from the driver, THE shim SHALL forward the call (tool name, arguments, request id) to the bridge's in-process router over its dedicated IPC channel, await the router's response, and return the response to the driver verbatim. The router parks a Promise per call and resolves it when pi delivers the result on its next `streamSimple()`; the shim holds the MCP response open until then (the inference driver blocks inline, per the Phase-0 spike).

#### Scenario: Round-trip through router (held open until pi delivers)
- **WHEN** the driver issues `tools/call` for `mcp__custom-tools__read` with arguments `{ path: "/tmp/x" }`
- **THEN** the shim forwards the request to the router over the IPC channel
- **AND** the shim does NOT respond until the router resolves (i.e. until pi delivers the tool result via its next `streamSimple()`)
- **AND** when the router responds with a tool-result payload, the shim returns that payload as the MCP response

### Requirement: Tool-call correlation across the split channels (D32)

The held-open round-trip is split: the shim receives an MCP `tools/call` (its own JSON-RPC request id + tool name + arguments), while the model's `toolu_…` id appears only on claude-p's stdout, and pi delivers `toolResult.id` = the model's `toolu_…` id. THE router SHALL reconcile {shim request} ↔ {model `toolu_…` id} ↔ {pi `toolResult.id`} per design D32: park each shim call, recover the model's `toolu_…` id by matching tool name + canonicalized arguments against the stdout `tool_use` event, and key the parked resolver by that `toolu_…` id so pi's `toolResult.id` resolves it. For multiple identical-name+args calls in one assistant line (S11), fall back to positional pairing within that line and assert the counts match. IF claude-p's `tools/call` is found (gate G8) to carry the model's `toolu_…` id directly, that id is authoritative and the heuristic is unnecessary. This correlation is verified by gate G8 on a 2-parallel-tool fixture BEFORE the router is implemented.

#### Scenario: Parallel held calls resolve to the correct pi tool_result
- **WHEN** one assistant line emits two `tool_use` blocks (distinct names or args) and the shim receives two `tools/call` requests
- **THEN** each parked call is keyed to its model `toolu_…` id (recovered per D32)
- **AND** pi's two `toolResult`s — keyed by those `toolu_…` ids — each resolve the matching parked call (no cross-wiring)

### Requirement: Shim rejects non-bridged tool names

IF the shim receives a `tools/call` request whose tool name is not in the set advertised at shim-spawn time, THEN the shim SHALL respond with an MCP error whose code indicates "unknown tool" and SHALL NOT forward the call to the router.

#### Scenario: Defense-in-depth on disallowed tool
- **IF** the driver attempts `tools/call` with name `mcp__custom-tools__forbidden`
- **AND** `forbidden` is not in the shim's advertised tool set
- **THEN** the shim returns an MCP error response with an "unknown tool" code
- **AND** the bridge's router is not contacted for this call

### Requirement: Shim lifecycle is bound to its spawn

THE shim SHALL be spawned per claude-p invocation, SHALL be reachable only by its owning `claude` process (via the inline `--mcp-config` pointer), and SHALL terminate when the IPC channel to the bridge closes or when its stdin is closed.

#### Scenario: Driver exit teardown
- **WHEN** the owning claude-p subprocess (and its `claude` child) exits (any reason: normal stop, abort, crash)
- **THEN** the shim's stdin closes
- **AND** the shim exits within an implementation-defined grace window
- **AND** no shim process remains attached to a dead driver

### Requirement: Shim is a separate process

THE shim SHALL run as its own OS process, not as a thread, worker, or in-process module of the bridge. THE shim SHALL communicate with the bridge only over its dedicated IPC channel. (The bridge resolves the shim binary's absolute path via `require.resolve('pi-claude-bridge/dist/mcp/shim.js')` or equivalent and passes it in the `--mcp-config` JSON; it does not rely on the spawned `claude` having the shim on `$PATH` — design D19/D30.)

#### Scenario: Process boundary preserved
- **WHEN** the bridge spawns a shim for a new turn
- **THEN** the shim has a distinct OS pid from the pi process
- **AND** the bridge process does not import the shim entry point at runtime as a module

### Requirement: Capture-mode tool calls receive deterministic shim response

WHEN the shim is configured for the capture path (router state `mode: "capture"`), THE shim SHALL handle `tools/call` for the capture tool entirely within its own process — validating arguments against the capture tool's JSON schema before answering. ON validation failure, the shim SHALL return MCP error `-32602 Invalid params` with a message naming the failing field path. ON validation success, the shim SHALL stash the validated arguments on the bridge-side router via the IPC channel, return the deterministic MCP response `{ "content": [{ "type": "text", "text": "Capture received. End your turn now." }] }`, AND NOT park a Promise awaiting any pi-side tool result.

#### Scenario: Capture tool called with valid args
- **WHEN** the model emits `tools/call` for the capture tool with arguments matching the schema
- **THEN** the shim validates the args locally
- **AND** stashes them via IPC to the bridge router
- **AND** returns the deterministic success response to `claude`
- **AND** the model is free to emit `end_turn`

#### Scenario: Capture tool called with invalid args
- **WHEN** the model emits `tools/call` for the capture tool with arguments failing schema validation
- **THEN** the shim returns MCP error `-32602` naming the failing field path
- **AND** the model receives the error and may self-correct within the same turn

#### Scenario: Capture tool called repeatedly
- **WHEN** the model emits a second valid `tools/call` for the capture tool after a first valid call in the same turn
- **THEN** the shim returns MCP error `-32603` with a message instructing the model to end its turn
- **AND** the first call's stashed arguments remain the final result

### Requirement: Malformed MCP messages surface as errors

IF the shim receives a stdin message that is not valid JSON-RPC over MCP, THEN the shim SHALL respond with an MCP error per the JSON-RPC specification and SHALL emit a structured log entry, without terminating its process for a single bad message.

#### Scenario: Garbage on stdin
- **IF** the driver writes a malformed JSON-RPC frame to the shim's stdin
- **THEN** the shim responds with an MCP `parse error` on stdout
- **AND** the shim continues processing subsequent valid messages
