# Proposal: add-claude-peek-overlay

## Why

When the bridge drives a turn, the underlying Claude Code Ink TUI is invisible —
the user cannot see what the driver is doing (spinner, tool churn, permission
surprises) without spelunking debug logs after the fact. A live, read-only
picture-in-picture peek inside the pi terminal closes that visibility gap
without touching the inference path (Constitution II: bridge stays
inference-only; the overlay observes, never executes). Feasibility is already
proven by two passing spikes (`.spike-notes/claude-peek/CONCLUSION.md`).

## What Changes

- `cartwmic/claude-p` fork gains a `--mirror-file <path>` flag: a **write-only
  tee** of raw PTY output bytes to a caller-supplied path. Absent the flag,
  behavior is byte-for-byte unchanged; present, the only new effect is the
  file write (echo-confirm gate, trust-dialog scanner, Ink readiness logic
  untouched). Ships via the existing fork workflow: `custom:` commit, push,
  bump pinned SHA in `package.json`.
- Bridge extension passes a per-spawn mirror path for **main-provider spawns
  only** (capture-path and subagent spawns are not mirrored), into a
  bridge-owned diagnostics location (never `~/.claude/`), with stale-file
  cleanup (keep last N).
- New peek module in the extension: tails the active mirror file, feeds bytes
  into a headless terminal emulator (`@xterm/headless`, fixed 120×40 to match
  claude-p session geometry), and renders the emulator grid in a pi-tui
  overlay via the documented `ExtensionUIContext.custom()` API
  (`overlay: true`, `nonCapturing: true`, anchored top-right), with renders
  coalesced (~10–20/s max).
- New `/claude-peek` pi command toggles the overlay. Overlay follows the
  latest main-turn spawn; shows an explicit idle state between turns and an
  explicit error state on any peek-path failure (Constitution VII). Peek
  failures never fail, delay, or abort the inference turn.
- New npm dependency: `@xterm/headless`.
- New e2e tmux scenario validating: overlay visible, live-updates during a
  streaming turn, editor keeps focus (prompt submits while overlay open),
  toggle-off works, and turn NDJSON output is unaffected by mirroring.

## Capabilities

### New Capabilities
- `claude-peek-overlay`: read-only live peek of the underlying Claude TUI —
  mirror-file wiring in the bridge, headless-emulator screen model, pi-tui
  overlay rendering, `/claude-peek` toggle command, failure isolation.

### Modified Capabilities
- `claude-p-fork`: new requirement — the fork carries a write-only PTY
  output mirror flag (`--mirror-file`) whose presence or absence never alters
  prompt-delivery behavior (echo-confirm gate and interactive-TUI driving
  model preserved).

## Clarifications (folded, plain Scale M)

Ambiguities resolved during the explore session (frozen in `intent.md`):

1. **Display surface** — in-pi overlay (not external terminal window; that
   option was explored and discarded).
2. **Concurrency target** — latest main-turn spawn only; no session picker.
3. **Geometry** — claude-p session stays fixed 120×40; overlay crops or
   h-scrolls when narrower. Session resize is out of scope (echo-confirm
   wrap risk).
4. **Fidelity** — monochrome text grid acceptable this change; ANSI color
   pass-through is a non-goal.
5. **Mirror lifecycle** — always-on for main-turn spawns (cheap, enables
   post-hoc replay later); per-spawn files, keep-last-N cleanup.
   *Assumption recorded by the loop: intent.md constrains location and
   cleanup but does not mandate opt-in gating; always-on chosen as the
   simplest behavior consistent with "failure isolation" and the existing
   always-on per-spawn debug logs.*

## Impact

- **Affected files (bridge repo):**
  - `package.json` — bump `claude-p` pin; add `@xterm/headless`.
  - `src/driver/claudeP.ts` — spawn config gains mirror path plumbing
    (argv assembly; main-provider spawns only).
  - `index.ts` — `/claude-peek` command registration, overlay wiring,
    per-spawn mirror path + current-spawn tracking.
  - New `src/peek/` module — mirror tailer, emulator screen model, overlay
    component (isolated from the stream/inference path).
  - `tests/` — unit tests for peek module; new scenario script under
    `scripts/` per the existing harness.
- **Affected projects (cross-repo):** `cartwmic/claude-p` fork
  (`/Volumes/Workshop/git/claude-p`, Zig): `src/args.zig`, `src/driver.zig`
  (reader-loop tee), README flag table.
- **Dependencies:** `@xterm/headless` (pure JS, no native deps).
- **No breaking changes.** No API surface change for existing bridge
  consumers; flag is additive on the fork.
