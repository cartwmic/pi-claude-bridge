# Capability: mcp-stdio-shim

<!-- authored: in-session -->

## MODIFIED Requirements

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

## ADDED Requirements

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

## Acceptance criterion quality checklist

| AC ID | Testable | Solution-free | Unambiguous | Consistent | Complete |
|---|---|---|---|---|---|
| mcp-stdio-shim.shim-lifecycle-is-bound-to-its-spawn | [x] | [x] | [x] | [x] | [x] |
| mcp-stdio-shim.tool-call-correlation-across-the-split-channels-d32 | [x] | [x] | [x] | [x] | [x] |
| mcp-stdio-shim.shim-readiness-proves-exact-tool-availability | [x] | [x] | [x] | [x] | [x] |
