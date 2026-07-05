# claude-peek-overlay Specification

## Purpose
TBD - created by archiving change add-claude-peek-overlay. Update Purpose after archive.
## Requirements
### Requirement: Overlay Toggle Command

WHEN the user invokes the `/claude-peek` command, THE bridge extension SHALL
toggle a read-only peek overlay inside the pi terminal: shown if hidden,
removed if shown. WHILE the overlay is shown, THE overlay SHALL NOT capture
keyboard focus — the pi editor SHALL continue to receive keystrokes and
accept prompt submission.

#### Scenario: Toggle on
- **WHEN** `/claude-peek` is invoked and no overlay is shown
- **THEN** the overlay appears inside the pi terminal viewport
- **AND** the pi editor retains focus (typed text reaches the editor)

#### Scenario: Toggle off
- **WHEN** `/claude-peek` is invoked while the overlay is shown
- **THEN** the overlay is removed and its update timers/tailers are disposed

#### Scenario: Prompt submits while overlay open
- **WHEN** the user types a prompt and presses Enter while the overlay is shown
- **THEN** the prompt is submitted and a turn starts, exactly as without the overlay

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

WHEN a new main-provider spawn begins a turn, THE peek SHALL retarget to that
spawn's mirror output. THE bridge SHALL NOT mirror or target capture-path or
subagent spawns.

#### Scenario: Retarget on new turn
- **WHEN** a main-provider turn ends and a subsequent main-provider turn begins
- **THEN** the overlay shows the new spawn's session screen

#### Scenario: Capture path excluded
- **WHEN** a capture-path request runs concurrently with the overlay shown
- **THEN** the overlay never displays the capture spawn's output

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

