# Capability: mcp-stdio-shim

<!-- authored: in-session -->

## MODIFIED Requirements

### Requirement: Shim lifecycle is bound to its selected-driver spawn

THE shim SHALL be spawned once per selected-driver invocation, SHALL be reachable only by its owning Claude process through explicit MCP configuration, and SHALL terminate when its bridge IPC channel or owning process stdin closes.

#### Scenario: Either driver exits
- **WHEN** an owning `claude-p` or `claude-print` process exits for normal completion, abort, or failure
- **THEN** its dedicated shim exits within the teardown grace period
- **AND** no shim remains attached to the completed invocation

### Requirement: Shim readiness proves exact tool availability

WHEN the owning Claude process completes MCP `tools/list`, THE shim SHALL publish its per-spawn readiness signal only after returning exactly the router-declared tool definitions.

#### Scenario: Readiness signal follows tools list
- **WHEN** the shim serves its first `tools/list` request
- **THEN** its response equals the router-declared tool set
- **AND** the readiness signal is published after that response is constructed

#### Scenario: List never succeeds
- **IF** shim startup or `tools/list` fails
- **THEN** readiness is not published and the owning driver cannot treat the MCP surface as ready

---

## Acceptance criterion quality checklist

| AC ID | Testable | Solution-free | Unambiguous | Consistent | Complete |
|---|---|---|---|---|---|
| mcp-stdio-shim.shim-lifecycle-is-bound-to-its-selected-driver-spawn | [x] | [x] | [x] | [x] | [x] |
| mcp-stdio-shim.shim-readiness-proves-exact-tool-availability | [x] | [x] | [x] | [x] | [x] |
