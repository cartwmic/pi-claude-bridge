# Capability: claude-peek-overlay

<!-- authored: in-session -->

## MODIFIED Requirements

### Requirement: Overlay Toggle Command

WHERE `claude-p` is selected, WHEN user invokes `/claude-peek`, THE bridge SHALL toggle read-only overlay while preserving editor focus. WHERE `claude-print` is selected, invocation SHALL display explicit unavailable state and SHALL not create overlay or tailer. IF selection changes to `claude-print` while overlay exists, THEN bridge SHALL dispose overlay/tailer and display unavailable notification rather than stale mirror.

#### Scenario: Toggle on in interactive mode
- **WHEN** `claude-p` is selected, command invoked, and overlay hidden
- **THEN** overlay appears and editor retains focus

#### Scenario: Toggle off in interactive mode
- **WHEN** `claude-p` is selected and overlay shown
- **THEN** overlay and timers/tailers are disposed

#### Scenario: Prompt submits while interactive overlay open
- **WHEN** user submits prompt while overlay shown
- **THEN** turn starts exactly as without overlay

#### Scenario: Command in direct mode
- **WHEN** `claude-print` is selected and command invoked
- **THEN** explicit unavailable message appears and no overlay/tailer starts

#### Scenario: Driver switches while overlay open
- **WHEN** existing interactive overlay is open and owning selection switches to `claude-print`
- **THEN** overlay/tailer are disposed before direct invocation is represented
- **AND** stale interactive content is not shown

## ADDED Requirements

### Requirement: Peek Explicitly Rejects Non-TUI Driver

WHERE `claude-print` is selected, THE peek feature SHALL report no underlying TUI and SHALL not present synthetic or stale content as equivalent live screen.

#### Scenario: Direct-mode peek
- **WHEN** user requests peek in direct mode
- **THEN** response names print-mode unavailability and starts no mirror resources

### Requirement: Interactive Peek Behavior Remains Available

WHERE `claude-p` is selected, THE existing read-only live overlay, latest-main targeting, focus preservation, failure isolation, geometry, and bridge-owned retention behavior SHALL remain unchanged.

#### Scenario: Interactive main turn
- **WHEN** user invokes peek during interactive main turn
- **THEN** overlay follows that turn mirror and keeps editor focus

---

## Acceptance criterion quality checklist

| AC ID | Testable | Solution-free | Unambiguous | Consistent | Complete |
|---|---|---|---|---|---|
| claude-peek-overlay.overlay-toggle-command | [x] | [x] | [x] | [x] | [x] |
| claude-peek-overlay.peek-explicitly-rejects-non-tui-driver | [x] | [x] | [x] | [x] | [x] |
| claude-peek-overlay.interactive-peek-behavior-remains-available | [x] | [x] | [x] | [x] | [x] |
