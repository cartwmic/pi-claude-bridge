# Capability: claude-p-driver

<!-- authored: in-session -->

## MODIFIED Requirements

### Requirement: Native tool emission is blocked via `--disallowedTools`

THE interactive driver SHALL configure every `claude-p` spawn with a current native-tool disallow set such that `mcp__custom-tools__*` is the only callable tool surface. The binding guarantee is non-routing/non-execution: any native or housekeeping emission MUST be dropped and never surfaced to pi. The set MUST include all tools observed through supported Claude versions, including `ReportFindings` and `SendMessage` added after the prior 2.1.159 audit, while preserving the bridged MCP namespace.

#### Scenario: Current native set is closed
- **WHEN** interactive driver arguments are built
- **THEN** `--disallowedTools` includes the previously documented native set plus `ReportFindings` and `SendMessage`
- **AND** no disallow token suppresses `mcp__custom-tools__*`
- **AND** the advertised callable roster is exactly the declared bridged MCP tools

#### Scenario: Built-in housekeeping is not surfaced
- **WHEN** Claude emits any native housekeeping call, including `WaitForMcpServers`
- **THEN** no pi tool call or pi tool execution is produced

#### Scenario: Native refusal is verified beyond roster introspection
- **WHEN** user settings attempt to allow a native tool and a model is asked to call it
- **THEN** the native operation does not execute
- **AND** foreign user MCP tools remain absent

## ADDED Requirements

### Requirement: Interactive Held Calls Have No Upstream Idle Cutoff

WHILE an interactive invocation is waiting on a held bridge MCP call, THE child Claude process SHALL not terminate that call because of its default stdio-MCP idle interval.

#### Scenario: Tool exceeds upstream idle default
- **WHEN** a healthy pi tool remains held longer than Claude Code's default stdio-MCP idle interval
- **THEN** `claude-p` continues waiting until pi returns the result or caller aborts

---

## Acceptance criterion quality checklist

| AC ID | Testable | Solution-free | Unambiguous | Consistent | Complete |
|---|---|---|---|---|---|
| claude-p-driver.native-tool-emission-is-blocked-via-disallowedtools | [x] | [x] | [x] | [x] | [x] |
| claude-p-driver.interactive-held-calls-have-no-upstream-idle-cutoff | [x] | [x] | [x] | [x] | [x] |
