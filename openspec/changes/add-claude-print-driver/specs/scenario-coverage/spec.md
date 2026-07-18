# Capability: scenario-coverage

<!-- authored: in-session -->

## ADDED Requirements

### Requirement: Full Bridge Scenarios Run Against Both Drivers

THE live scenario suite SHALL execute the bridge's S0–S27 main, tool, capture, resume, abort, steering, concurrency, and coherence behaviors against both `claude-p` and `claude-print`, except for the documented direct-mode peek difference.

#### Scenario: Direct parity run
- **WHEN** scenario suite selects `claude-print`
- **THEN** every applicable S0–S27 scenario runs through direct print mode
- **AND** pass criteria require conversation coherence, correct pi tool execution, clean lifecycle, and no native tool execution

#### Scenario: Interactive regression run
- **WHEN** scenario suite selects `claude-p`
- **THEN** existing applicable S0–S27 behavior remains green

#### Scenario: Peek exception is narrow
- **WHEN** direct-driver suite reaches peek behavior
- **THEN** it asserts explicit unavailability rather than TUI rendering
- **AND** no other scenario is exempted from parity

### Requirement: Direct Protocol Integration Gates Are Retained

THE validation suite SHALL retain real-driver integration evidence for readiness-gated submission, multi-round and parallel held tools, capture, warm resume/cache, partial streaming, abort cleanup, native isolation, and concurrent invocations.

#### Scenario: MCP readiness regression
- **IF** direct prompt generation begins while the shim is pending or absent
- **THEN** the integration gate fails before the change can be declared complete

#### Scenario: Native roster regression
- **IF** either driver's live initialized tool roster contains a native or foreign MCP tool
- **THEN** the integration gate fails as a Constitution IV violation

---

## Acceptance criterion quality checklist

| AC ID | Testable | Solution-free | Unambiguous | Consistent | Complete |
|---|---|---|---|---|---|
| scenario-coverage.full-bridge-scenarios-run-against-both-drivers | [x] | [x] | [x] | [x] | [x] |
| scenario-coverage.direct-protocol-integration-gates-are-retained | [x] | [x] | [x] | [x] | [x] |
