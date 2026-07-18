# Capability: scenario-coverage

<!-- authored: in-session -->

## MODIFIED Requirements

### Requirement: Large Cold Start Prompt Coverage

THE scenario suite SHALL prove a large first prompt is accepted end-to-end by both selected drivers.

#### Scenario: Large cold-start prompt reaches model through either driver
- **WHEN** fresh pi starts with no session and first prompt exceeds 800 bytes with unique sentinel under `claude-p` and `claude-print` runs
- **THEN** each run completes selected-driver turn, logs no prompt-delivery failure, returns sentinel, and contains no non-delivery disclaimer

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

### Requirement: Both Stream Schemas Have Deterministic Fixtures

THE unit suite SHALL retain fixtures for interactive `claude-p` stream records and direct partial/complete stream records, covering nominal text/thinking, held tools, malformed input, abort, and missing terminal result.

#### Scenario: Parser regression without live billing
- **WHEN** either driver's parser contract changes
- **THEN** deterministic fixtures prove normalized pi events, usage, stop reason, and error classification before live scenarios run

### Requirement: Direct Concurrency Scenarios Prove State Isolation

WHEN direct main, capture, and nested invocations overlap in live scenarios, THE suite SHALL prove disjoint processes, shims, routers, IPC channels, queues, session state, and tool correlation rather than process exit alone.

#### Scenario: Concurrent direct paths
- **WHEN** direct main is parked while capture and nested calls execute
- **THEN** scenario verifies correct result returns to each owner with no cross-frame stream, resolver, or session contamination

---

## Acceptance criterion quality checklist

| AC ID | Testable | Solution-free | Unambiguous | Consistent | Complete |
|---|---|---|---|---|---|
| scenario-coverage.large-cold-start-prompt-coverage | [x] | [x] | [x] | [x] | [x] |
| scenario-coverage.full-bridge-scenarios-run-against-both-drivers | [x] | [x] | [x] | [x] | [x] |
| scenario-coverage.direct-protocol-integration-gates-are-retained | [x] | [x] | [x] | [x] | [x] |
| scenario-coverage.both-stream-schemas-have-deterministic-fixtures | [x] | [x] | [x] | [x] | [x] |
| scenario-coverage.direct-concurrency-scenarios-prove-state-isolation | [x] | [x] | [x] | [x] | [x] |
