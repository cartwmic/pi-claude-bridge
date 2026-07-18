# Capability: claude-peek-overlay

<!-- authored: in-session -->

## ADDED Requirements

### Requirement: Peek Explicitly Rejects Non-TUI Driver

WHERE `claude-print` is selected, THE `/claude-peek` command SHALL report that peek is unavailable because no underlying TUI exists and SHALL NOT open an overlay using stale interactive-driver mirror state.

#### Scenario: Toggle attempted in direct mode
- **WHEN** user invokes `/claude-peek` while current project selects `claude-print`
- **THEN** bridge displays an explicit unavailable message naming direct print mode
- **AND** no overlay or mirror tailer starts

#### Scenario: Existing overlay was opened before driver switch
- **WHEN** an interactive peek overlay exists and a later project invocation selects `claude-print`
- **THEN** stale mirrored content is not presented as the direct invocation's live screen

### Requirement: Interactive Peek Behavior Remains Available

WHERE `claude-p` is selected, THE existing read-only overlay toggle, live mirror targeting, focus preservation, failure isolation, and bridge-owned retention behavior SHALL remain unchanged.

#### Scenario: Interactive main turn
- **WHEN** user invokes `/claude-peek` during a `claude-p` main-provider turn
- **THEN** overlay follows that turn's mirror output and keeps editor focus

---

## Acceptance criterion quality checklist

| AC ID | Testable | Solution-free | Unambiguous | Consistent | Complete |
|---|---|---|---|---|---|
| claude-peek-overlay.peek-explicitly-rejects-non-tui-driver | [x] | [x] | [x] | [x] | [x] |
| claude-peek-overlay.interactive-peek-behavior-remains-available | [x] | [x] | [x] | [x] | [x] |
