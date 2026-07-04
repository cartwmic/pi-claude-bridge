# Intent: add-claude-peek-overlay

## Intent

Add a picture-in-picture "peek" into the live Claude Code Ink TUI that the
bridge drives underneath pi. A `/claude-peek` command toggles a live-updating,
read-only overlay rendered inside the pi terminal itself (top-right,
non-focus-capturing), showing the current screen of the underlying `claude`
session while a turn streams. The user keeps full control of the pi editor
while the overlay is open, and the overlay follows the latest main-turn spawn
automatically (appearing per turn, idling between turns).

Mechanism (validated by two passing spikes, see
`.spike-notes/claude-peek/CONCLUSION.md`): the claude-p fork gains a
write-only `--mirror-file <path>` flag that tees raw PTY output bytes; the
bridge extension tails the per-spawn mirror file, feeds the bytes into a
headless terminal emulator (`@xterm/headless`, 120×40 — matching the fixed
claude-p session geometry), and renders the emulator grid rows in a pi-tui
overlay via the documented `ExtensionUIContext.custom()` API with
`overlay: true` and `nonCapturing: true`.

## Constraints

- **Read-only observer, always.** The peek path MUST NOT write a single byte
  to the claude-p PTY input, and MUST NOT alter the PTY output path beyond a
  write-only tee. The echo-confirm gate, trust-dialog scanner, and Ink
  readiness logic in claude-p must be byte-for-byte unaffected when the
  mirror flag is absent AND when it is present.
- **Fixed session geometry.** The claude-p session stays 120×40
  (`driver.zig cols=120 rows=40`). The overlay MUST NOT resize the session;
  when the overlay viewport is narrower than 120 columns it crops or
  horizontally scrolls. (Resizing risks changing Ink line-wrap behavior that
  the echo-confirm scanner depends on.)
- **Main-turn spawns only.** The overlay follows the latest main-provider
  spawn; capture-path and subagent spawns are not mirrored/targeted in this
  change.
- **claude-p change ships via the existing fork workflow**: patch
  `cartwmic/claude-p`, push, bump the pinned SHA in `package.json`
  (same flow as the `echo-confirm-input` patch).
- **Mirror files live in a bridge-owned location** (co-located with the
  existing bridge debug/diagnostics dirs or tmpdir) — never under
  `~/.claude/`. Per-spawn file naming; stale files cleaned up (keep last N).
- **UI only via documented ExtensionUIContext.** Overlay uses
  `ctx.ui.custom()` + `OverlayOptions` (`nonCapturing`, anchor, width) —
  no direct pi-tui internals.
- **Render throttling.** Ink repaints are frequent; overlay re-renders are
  coalesced (order of 10–20/s max), never per-byte.
- **Failure isolation.** Any peek-path failure (mirror file missing,
  emulator error, tail failure) degrades to the overlay showing an explicit
  error/idle state; it MUST NOT fail, delay, or abort the inference turn.
- **Validation includes an end-to-end tmux scenario** (per the repo's
  scenario harness) proving: overlay visible, overlay updates during a
  streaming turn, editor keeps focus (prompt submits while overlay open),
  overlay toggles off, and the turn's NDJSON output is unaffected by
  mirroring (no PTY-pollution regression).
- **Implementation gotchas from spikes are binding:** pi `registerCommand`
  handler signature is `(args: string, ctx)`; `ctx.ui.custom()` resolves
  only when `done()` is called (retain `done` for toggle-off; clear timers
  in `dispose()`).

## Invariants honored

- **Constitution I (pi owns conversation state):** mirror files contain raw
  terminal frames for live display only; they are ephemeral diagnostics
  (same class as the existing per-spawn debug logs), not conversation
  history the bridge consults for inference or resume.
- **Constitution II (bridge is inference-only):** the overlay does not
  execute tools or mutate pi UI outside the documented `ExtensionUIContext`;
  peek code is an isolated module observing the driver, with zero coupling
  into the inference/stream path.
- **Constitution III (no writes under `~/.claude/`):** mirror output goes to
  bridge-owned paths exclusively.
- **Constitution VII (failures surface; degradation explicit):** peek
  failures render an explicit overlay error state and a structured log
  entry; the inference path is unaffected.
- **Domain invariant 4 (native tools disallowed):** untouched — peek adds no
  tool surface.
- **Domain "Out-of-scope: Pi UI rendering":** honored via the documented
  `ExtensionUIContext` exception.

## Non-goals

- Interactive input into the peeked session (peek is a window, never a door).
- Peeking capture-path or subagent spawns; a session picker.
- Color/attribute-faithful rendering (monochrome text grid is acceptable in
  this change; ANSI color pass-through may come later).
- Resizing or otherwise altering the claude-p session geometry.
- Post-hoc replay/forensics UI for saved mirror files (the files may enable
  this later, but no UI ships in this change).
- External-terminal-window viewer (explored and discarded in favor of the
  in-pi overlay).
