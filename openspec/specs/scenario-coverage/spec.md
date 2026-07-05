# scenario-coverage Specification

## Purpose

Live scenario coverage for bridge regressions that require end-to-end behavior evidence beyond unit or integration tests.

## Requirements

### Requirement: Large Cold Start Prompt Coverage

The scenario suite SHALL contain a live TUI regression scenario that proves a large first user prompt is accepted end-to-end by the claude-p driver path.

#### Scenario: Large cold-start prompt reaches the model
- **WHEN** a fresh pi process starts with `--no-session` and the first submitted user prompt is larger than 800 bytes and contains a unique sentinel token
- **THEN** the scenario SHALL observe a completed claude-p turn in the bridge log
- **AND** the bridge log SHALL contain no `PromptNotAccepted` occurrence
- **AND** the assistant response SHALL contain the sentinel token
- **AND** the assistant response SHALL NOT contain a non-delivery disclaimer such as not receiving or not seeing the prompt
