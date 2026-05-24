# mcp-stdio-shim Specification

## Purpose
TBD - created by archiving change normalize-output-capture-spec-post-sdk-removal. Update Purpose after archive.
## Requirements
### Requirement: Shim exposes only pi-bridged tools

THE shim SHALL advertise to the inference driver exactly the set of tools the bridge's in-process router declares for the current PTY's turn, with names in the `mcp__custom-tools__*` namespace. THE shim SHALL NOT expose any tool not declared by the router for that turn.

#### Scenario: Shim handshake reflects router's tool set
- **WHEN** a PTY initializes and the shim receives an MCP `initialize` request followed by `tools/list`
- **THEN** the shim returns exactly the tool definitions the router declared at shim-spawn time
- **AND** no tool outside `mcp__custom-tools__*` appears in the response

### Requirement: Shim forwards tool calls to the in-process router

WHEN the shim receives an MCP `tools/call` request from the driver, THE shim SHALL forward the call (tool name, arguments, request id) to the bridge's in-process router over its dedicated IPC channel, await the router's response, and return the response to the driver verbatim.

#### Scenario: Round-trip through router
- **WHEN** the driver issues `tools/call` for `mcp__custom-tools__read` with arguments `{ path: "/tmp/x" }`
- **THEN** the shim forwards the request to the router over the IPC channel within an implementation-defined timeout
- **AND** when the router responds with a tool-result payload, the shim returns that payload as the MCP response

### Requirement: Shim rejects non-bridged tool names

IF the shim receives a `tools/call` request whose tool name is not in the set advertised at shim-spawn time, THEN the shim SHALL respond with an MCP error whose code indicates "unknown tool" and SHALL NOT forward the call to the router.

#### Scenario: Defense-in-depth on disallowed tool
- **IF** the driver attempts `tools/call` with name `mcp__custom-tools__forbidden`
- **AND** `forbidden` is not in the shim's advertised tool set
- **THEN** the shim returns an MCP error response with an "unknown tool" code
- **AND** the bridge's router is not contacted for this call

### Requirement: Shim lifecycle is bound to its PTY

THE shim SHALL be spawned by the bridge per PTY, SHALL be reachable only by its owning PTY (via the inline `--mcp-config` pointer), and SHALL terminate when the IPC channel to the bridge closes or when its stdin is closed.

#### Scenario: PTY exit teardown
- **WHEN** the owning PTY exits (any reason: normal stop, abort, crash)
- **THEN** the shim's stdin closes
- **AND** the shim exits within an implementation-defined grace window
- **AND** no shim process remains attached to a dead PTY

### Requirement: Shim is a separate process

THE shim SHALL run as its own OS process, not as a thread, worker, or in-process module of the bridge. THE shim SHALL communicate with the bridge only over its dedicated IPC channel.

#### Scenario: Process boundary preserved
- **WHEN** the bridge spawns a shim for a new PTY
- **THEN** the shim has a distinct OS pid from the pi process
- **AND** the bridge process does not import the shim entry point at runtime as a module

### Requirement: Shim binary serves both MCP-server and hook-relay roles

THE `pi-claude-bridge-shim` binary SHALL accept a `--mode` flag selecting its role: `--mode mcp --socket <path>` for the stdio MCP server invoked by `claude --mcp-config`, or `--mode hook --event <name> --socket <path>` for hook-payload relay invoked by `claude` hook commands declared in inline `--settings`. Both modes communicate with the bridge over the same per-PTY unix-domain socket whose path is supplied via the `--socket` argument. Both modes communicate with the bridge using the newline-delimited JSON wire protocol specified in design D20.

THE bridge SHALL resolve the shim binary's absolute path via `require.resolve('pi-claude-bridge/dist/mcp/shim.js')` (or equivalent ESM mechanism) and pass that absolute path in both the `--mcp-config` JSON and the `--settings` hook commands. THE bridge SHALL NOT rely on the spawned `claude` subprocess having `pi-claude-bridge-shim` on its `$PATH`.

#### Scenario: MCP mode handshake
- **WHEN** the shim is invoked with `--mode mcp --socket /tmp/pi-claude-bridge-abc.sock`
- **THEN** the shim opens stdio MCP, advertises only `mcp__custom-tools__*` tools, and forwards `tools/call` requests to the bridge over the socket

#### Scenario: Hook mode payload relay
- **WHEN** the shim is invoked with `--mode hook --event session-start --socket /tmp/pi-claude-bridge-abc.sock` and a JSON payload is provided on stdin
- **THEN** the shim connects to the socket, sends the event name and payload, awaits a structured response, writes the response to stdout in the format `claude` expects for that hook event, and exits within an implementation-defined latency budget

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

---

