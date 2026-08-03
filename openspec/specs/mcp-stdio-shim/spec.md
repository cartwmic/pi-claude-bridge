# mcp-stdio-shim Specification

## Purpose

Stdio MCP server subprocess exposing Pi-bridged tools to Claude Code under
either selected driver and proxying calls to the bridge's in-process router.
Shim owns exact readiness/tool roster and held-open promise parking: a
`tools/call` remains pending until Pi delivers its matching tool result.

Shim is an MCP server only. It runs as a separate process invoked by Claude
Code via per-spawn `--mcp-config`; both drivers bind its lifecycle to their
owning spawn.

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

THE router SHALL reconcile shim MCP requests, selected-driver observational `tool_use` ids, and pi `toolResult.id` without making stdout a second execution path: each shim call receives one bridge/pi id that remains the resolver key shown to and returned by pi; model tool id is correlation metadata aliased to that pi id when recovered by name + canonicalized arguments. Identical calls pair positionally inside one completed assistant tool-use batch while counts are asserted. IF request carries model id directly, THEN the alias is established immediately without replacing resolver key. IF counts or canonical pairing cannot reconcile, THEN owning invocation SHALL surface structured correlation error, safely drain pending resolvers, and invalidate resume hint rather than guess or hang.

#### Scenario: Interactive correlation
- **WHEN** interactive stdout and shim request describe same bridged call
- **THEN** router pairs them and matching pi result resolves only that call

#### Scenario: Direct correlation
- **WHEN** direct stream observational tool record and shim request describe same bridged call
- **THEN** router pairs them without routing or executing from stream record

#### Scenario: Parallel identical calls
- **WHEN** selected driver emits multiple identical-name+args calls in one assistant turn
- **THEN** positional pairing preserves model ids and pi results do not cross-wire

### Requirement: Shim rejects non-bridged tool names

IF the shim receives a `tools/call` request whose tool name is not in the set advertised at shim-spawn time, THEN the shim SHALL respond with an MCP error whose code indicates "unknown tool" and SHALL NOT forward the call to the router.

#### Scenario: Defense-in-depth on disallowed tool
- **IF** the driver attempts `tools/call` with name `mcp__custom-tools__forbidden`
- **AND** `forbidden` is not in the shim's advertised tool set
- **THEN** the shim returns an MCP error response with an "unknown tool" code
- **AND** the bridge's router is not contacted for this call

### Requirement: Shim lifecycle is bound to its spawn

THE shim SHALL be spawned once per selected-driver invocation, SHALL be reachable only by its owning Claude process through explicit MCP configuration, and SHALL terminate when its bridge IPC channel or its own MCP stdin closes; closure of the direct driver's user-input stream alone SHALL NOT tear down a shim that still owns held MCP rounds.

#### Scenario: Selected driver exits
- **WHEN** an owning `claude-p` or `claude-print` process exits for normal completion, abort, or failure
- **THEN** its dedicated shim exits within teardown grace
- **AND** no shim remains attached to completed invocation

#### Scenario: Direct user-input stream does not own shim lifetime
- **WHEN** direct user frame has been written and a held MCP round remains active
- **THEN** ending or idling user-input stream alone does not terminate shim
- **AND** shim remains until its MCP stdin or bridge IPC closes

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

### Requirement: Shim readiness proves exact tool availability

WHEN the shim accepts its first MCP `tools/list` request and constructs a response equal to the router-declared tool set, THE shim SHALL publish its per-spawn readiness signal; retained integration evidence SHALL prove no model-generation output precedes connected MCP initialization after bridge submits user frame.

#### Scenario: Readiness signal follows exact tools list
- **WHEN** shim handles first `tools/list`
- **THEN** response equals router-declared set
- **AND** readiness is published only for that successful handler path

#### Scenario: List never succeeds
- **IF** shim startup or `tools/list` fails
- **THEN** readiness is not published and owning driver cannot treat MCP surface as ready

---
