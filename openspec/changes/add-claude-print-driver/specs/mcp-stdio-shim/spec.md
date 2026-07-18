# Capability: mcp-stdio-shim

<!-- authored: in-session -->

## MODIFIED Requirements

### Requirement: Shim lifecycle is bound to its spawn

THE shim SHALL be spawned once per selected-driver invocation, SHALL be reachable only by its owning Claude process through explicit MCP configuration, and SHALL terminate when its bridge IPC channel or its own MCP stdin closes; closure of the direct driver's user-input stream alone SHALL NOT tear down a shim that still owns held MCP rounds.

#### Scenario: Selected driver exits
- **WHEN** an owning `claude-p` or `claude-print` process exits for normal completion, abort, or failure
- **THEN** its dedicated shim exits within teardown grace
- **AND** no shim remains attached to completed invocation

## ADDED Requirements

### Requirement: Shim readiness proves exact tool availability

WHEN the shim accepts its first MCP `tools/list` request and constructs a response equal to the router-declared tool set, THE shim SHALL publish its per-spawn readiness signal; after the bridge submits the user frame, Claude SHALL not begin model generation until its MCP initialization completes.

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
| mcp-stdio-shim.shim-readiness-proves-exact-tool-availability | [x] | [x] | [x] | [x] | [x] |
