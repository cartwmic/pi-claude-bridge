# Capability: scenario-coverage

## ADDED Requirements

### Requirement: Large Cold Start Prompt Coverage

The scenario suite SHALL contain a live TUI regression scenario that proves a large first user prompt is accepted end-to-end by the claude-p driver path.

#### Scenario: Large cold-start prompt reaches the model
- **WHEN** a fresh pi process starts with `--no-session` and the first submitted user prompt is larger than 800 bytes and contains a unique sentinel token
- **THEN** the scenario SHALL observe a completed claude-p turn in the bridge log
- **AND** the bridge log SHALL contain no `PromptNotAccepted` occurrence
- **AND** the assistant response SHALL contain the sentinel token
- **AND** the assistant response SHALL NOT contain a non-delivery disclaimer such as not receiving or not seeing the prompt

## MODIFIED Requirements

## REMOVED Requirements

## RENAMED Requirements

---

## Acceptance criterion quality checklist

| AC ID | Testable | Solution-free | Unambiguous | Consistent | Complete |
|---|---|---|---|---|---|
| scenario-coverage.large-cold-start-prompt-coverage | [x] live S31 run checks log and response | [x] describes behavior, not implementation internals | [x] threshold, cold-start, sentinel, and pass/fail signals named | [x] compatible with existing scenario charter | [x] covers mechanical acceptance and model coherence |
