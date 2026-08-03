# claude-peek-overlay Specification

## Purpose
Read-only `/claude-peek` overlay behavior for interactive `claude-p` turns and explicit no-PTY-tail behavior when `claude-print` is selected.
## Requirements
### Requirement: Overlay Toggle Command

WHERE `claude-p` is selected, WHEN user invokes `/claude-peek`, THE bridge SHALL toggle read-only overlay while preserving editor focus. WHERE the next fresh-turn or peek-command resolution selects `claude-print`, THE bridge SHALL display explicit unavailability, create no overlay/tailer, and dispose any prior interactive overlay/tailer at that resolution point rather than show stale mirror.

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
- **WHEN** existing interactive overlay is open and next fresh-turn or peek-command driver resolution selects `claude-print`
- **THEN** overlay/tailer are disposed at that resolution point and an unavailable notification is shown
- **AND** stale interactive content is not shown under resolved print selection

### Requirement: Live Screen During Main-Provider Turn

WHILE a main-provider turn is in flight AND the overlay is shown, THE overlay SHALL display the current screen content of the underlying `claude` session,
derived from the mirrored PTY output, updating as new output arrives with
re-renders coalesced to a bounded rate.

#### Scenario: Overlay updates during streaming
- **WHEN** the underlying `claude` session repaints while a turn streams
- **THEN** the overlay content advances to reflect the new screen state without user action

#### Scenario: Bounded re-render rate
- **WHEN** mirrored output arrives in rapid bursts
- **THEN** overlay re-renders are coalesced to the bounded rate rather than performed per byte

### Requirement: Peek Follows Latest Main-Turn Spawn Only

WHERE `claude-p` is selected, WHEN a new main-provider spawn begins, THE peek SHALL retarget to that spawn's mirror output and SHALL never target capture or subagent spawns. WHERE `claude-print` is selected, THE peek SHALL dispose any prior mirror target and SHALL not retarget to the direct spawn.

#### Scenario: Retarget on new interactive turn
- **WHEN** one interactive main turn ends and another begins
- **THEN** overlay shows new interactive spawn screen

#### Scenario: Direct main turn excluded
- **WHEN** new main turn uses `claude-print`
- **THEN** no mirror target is created and prior target is disposed

#### Scenario: Capture path excluded
- **WHEN** capture runs while overlay shown
- **THEN** overlay never displays capture output

### Requirement: Explicit Idle And Error States

WHILE no main-provider spawn is active, THE overlay SHALL display an explicit
idle state. IF the peek path fails (mirror file missing or unreadable,
emulator error, tail failure), THEN THE overlay SHALL display an explicit
error state AND THE bridge SHALL emit a structured log entry for the failure.

#### Scenario: Idle between turns
- **WHEN** the overlay is shown and no turn is in flight
- **THEN** the overlay displays the idle state rather than a stale or blank frame presented as live

#### Scenario: Peek failure surfaces without degrading silently
- **IF** the mirror file cannot be read while a turn is in flight
- **THEN** the overlay shows the error state and a structured log entry is written

### Requirement: Peek Failures Never Affect The Inference Turn

IF any peek-path component fails at any point, THEN THE in-flight inference turn SHALL proceed unaffected:
no failure, delay, abort, or output alteration SHALL result from the peek
path.

#### Scenario: Turn survives peek crash
- **IF** the peek module throws during a streaming turn
- **THEN** the turn completes and its streamed output to pi is byte-identical to a run without the overlay

### Requirement: Fixed Session Geometry Rendering

THE peek screen model SHALL match the fixed claude-p session geometry of 120
columns by 40 rows, and THE peek SHALL NOT resize or otherwise alter the
underlying session geometry. WHEN the overlay viewport is narrower than the
session width, THE overlay SHALL crop or horizontally scroll the rendered
grid.

#### Scenario: Narrow viewport crops
- **WHEN** the overlay viewport is narrower than 120 columns
- **THEN** rendered rows are cropped or horizontally scrolled; the session itself is never resized

### Requirement: Mirror Files Confined To Bridge-Owned Storage

THE bridge SHALL write mirror files only to a bridge-owned diagnostics
location and SHALL NOT write them under `~/.claude/`. THE bridge SHALL bound
accumulation by retaining at most a fixed number of recent per-spawn mirror
files and deleting older ones.

#### Scenario: Bridge-owned path
- **WHEN** a main-provider spawn is created with mirroring enabled
- **THEN** the mirror path resolves under the bridge-owned diagnostics location, never under `~/.claude/`

#### Scenario: Stale files cleaned
- **WHEN** the retained-file limit is exceeded by a new spawn's mirror file
- **THEN** the oldest mirror files are deleted so at most the limit remains

---

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
