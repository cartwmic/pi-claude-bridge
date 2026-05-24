# ADR-0014: Workspace trust-dialog handling

**Status:** Accepted
**Date:** 2026-05-24
**Source change:** `openspec/changes/archive/2026-05-24-replace-sdk-with-pty-tui/`

## Context

Phase 0 spike T0.14 (2026-05-21) discovered: when `claude` interactive boots in a workspace it doesn't recognize, it prompts a `Quick safety check` dialog requiring user keyboard input ("Yes, trust this project" / "No"). A PTY-driven session cannot respond to dialogs the way an interactive user does. Untrusted workspace = boot hangs. Trust state lives in `~/.claude/` (constitution III forbids the bridge from writing there), so pre-trusting via a config file is not an option.

## Decision Drivers

- Constitution III: bridge does not write to `~/.claude/`
- Constitution VII: undetected dialog must surface as documented error
- Capture-mode cwd = `os.tmpdir()` — fresh dir on every call; dialog fires every time
- Already-trusted cwd path must not regress (no spurious keystrokes)

## Considered Options

### Option A: ANSI-aware PTY output scanner with auto-answer
Bridge implements an ANSI-stripping scanner. On boot, scans first ~5 seconds of PTY output for substring `Quick safety check` (or `Accessing workspace:`) case-insensitively. On match: write `\r` (default = "Yes, trust this project" in current `claude` 2.1.114 layout). Scanner stops on first match OR on bounded-window expiry OR on first transcript-file-creation event.

**Pros:** single mechanism covers all cases (first-time workspace, capture-mode tmpdir, already-trusted cwd). No `~/.claude/` writes. Failure modes are spec'd.
**Cons:** couples to UI string (`Quick safety check`); if `claude` renames the dialog, scanner breaks (failure-surface: 30s no-transcript timer fires error).

### Option B: Pre-trust workspaces by spawning claude once and answering
**Pros:** amortizes the scanner.
**Cons:** still requires the scanner to do the initial answer. Constitution III concern (the "spawn once" still mutates `~/.claude/`). Doesn't help capture-mode tmpdir (fresh on every call).

### Option C: Document the dialog as a user-must-resolve hazard
**Pros:** zero bridge code.
**Cons:** every fresh pi project requires the user to manually answer once. Capture-mode tmpdir requires it on every call. Unacceptable UX.

### Option D: Use `--bare` flag to disable trust dialog
**Pros:** flag exists.
**Cons:** `--bare` also disables hooks (breaking ADR-0007) and disables OAuth in favor of `ANTHROPIC_API_KEY`-only. Trade off too much.

## Decision Outcome

**Chosen option:** A — ANSI-aware PTY output scanner with auto-answer.

**Rationale:** the scanner is needed regardless (option B still requires it for the initial answer). A single mechanism handles first-time project, capture-mode tmpdir, and already-trusted cwd (silent timeout, no harm). Failure surfacing per constitution VII: if dialog fires but scanner doesn't detect it within window AND no transcript after 30s, driver emits `error` with `errorMessage = "workspace trust dialog not detected; claude TUI may have changed its boot UI"` and kills PTY.

## Consequences

**Positive:**
- Works on fresh projects, capture-mode tmpdir, already-trusted dirs uniformly
- No `~/.claude/` writes (constitution III)
- Failure-surface explicit (R18)
- ~100-500ms scanner latency per call in capture mode (acceptable per change scope)

**Negative:**
- Couples to UI string (`Quick safety check`) — fragile against `claude` redesign
- False-positive risk: if model output contains the trigger substring in first 5s, scanner sends `\r` into PTY (benign; model is busy producing output)
- Adds `src/driver/ansi.ts` module for ANSI strip helper

**Neutral:**
- Scanner stops on first transcript-file-creation event (dialog can't fire after that)
- Phase 4 tests: T4.9 (detect+answer), T4.10 (non-interference in trusted cwd), T4.11 (failure surface)

## Links

- Source design discussion: `openspec/changes/archive/2026-05-24-replace-sdk-with-pty-tui/design.md` (Decision D25)
- Related ADRs: ADR-0001 (PTY-driver), ADR-0015 (typed injection runs AFTER scanner per ordering)
- Verification: `tests/unit-driver-ansi.mjs`, `tests/unit-driver-trust-scanner.mjs`, `tests/int-trust-dialog-*.mjs`
