# Spike T0.14 — Interactive-mode positional-prompt liveness HARD GATE

**Result:** **FAIL → DESIGN UPDATE REQUIRED.** The interactive `claude` workspace-trust dialog blocks boot for untrusted cwds, AND is NOT bypassed by `--dangerously-skip-permissions`. The bridge needs an explicit handling path for the trust gate before Phase 1.

## Test setup

```js
pty.spawn("/Users/cartwmic/.local/bin/claude", [
  "--session-id", uuid,
  "--system-prompt", "Reply OK to any input.",
  "--strict-mcp-config",
  "--setting-sources", "",
  "--dangerously-skip-permissions",      // also tried "--permission-mode bypassPermissions"
  "--settings", JSON.stringify({ hooks: {...SessionStart, Stop} }),
  "hello"                                // positional prompt
], { ... node-pty options ... });
```

Cwd: fresh `mkdtempSync(tmpdir(), "spike-t14-")` (untrusted by `claude`).

## Result

After 15 seconds:
- SessionStart hook: NOT fired
- Transcript file: NOT created
- Assistant JSONL line: NOT appeared
- PTY process: alive (1133 bytes of output buffered)

PTY output shows the **workspace trust dialog** drawn by Ink:
```
[ANSI sequences ...]
Accessing workspace: /private/var/folders/46/.../spike-t14-XXX
Quick safety check: Is this a project you created or one you trust?
(Like your own code, a well-known open source project, ...)
```

The dialog is waiting for keyboard input ("y", arrow keys + Enter, etc.). Nothing proceeds until it's answered.

## Documented behavior (from `claude --help`)

> `-p, --print` ... Note: The workspace trust dialog is skipped when Claude is run with the -p mode.

> `doctor` ... Note: The workspace trust dialog is skipped and stdio servers from .mcp.json are spawned for health checks.

There is NO documented CLI flag to skip the dialog in interactive mode. `--dangerously-skip-permissions` skips PERMISSION dialogs but not the trust gate (verified empirically).

## Impact on the design

The PTY-driven interactive-mode architecture has two cwd categories:

| Scenario | Cwd | Trust status | Liveness |
|---|---|---|---|
| Main provider (normal pi turn) | Pi's project cwd | Pre-trusted by user's prior `claude` usage in that dir | OK — boot proceeds |
| Capture mode (D5 → cwd=`tmpdir()`) | Fresh `os.tmpdir()` each call | NEVER trusted | **BLOCKED** by trust dialog |
| First-time use in a new pi project | Pi's project cwd, never used with claude | UNTRUSTED first turn only | **BLOCKED** on first turn |

The current proposal/design assumes liveness without addressing this. The two failure cases above are real and must be handled.

## Options for handling

**A. PTY-output scanning + auto-answer.** The bridge watches PTY output for the dialog string ("Accessing workspace:" / "Quick safety check:") and sends keystrokes ("y\r" or arrow-key sequences) to dismiss it. Workable but fragile — the dialog text/layout can change between `claude` releases. Adds an ANSI-aware parser to the driver.

**B. Pre-trust cwds via filesystem.** `claude` likely persists trusted-workspace state somewhere under `~/.claude/`. The bridge would write to that file before spawning. **Violates constitution III** (writes under `~/.claude/`). Constitution amendment would be needed.

**C. Capture mode runs in a pre-trusted parent dir.** Instead of `os.tmpdir()` per call, capture mode uses a single pre-trusted directory under e.g. `~/.local/share/pi-claude-bridge/capture-cwd/` that the user trusts once. Acceptable for capture mode; doesn't fix the first-time-pi-project case.

**D. Use `-p` mode for capture only.** Reverts to the SDK-trust-surface concern the user rejected. NO.

**E. Open trust dialog and answer it once per-cwd manually.** Document that the user must run `claude` once in any new project to grant trust. Acceptable as a documented onboarding step for the main provider path; still leaves capture-mode broken.

## Recommendation

Combine **A** (PTY auto-answer for the main provider on first-time pi projects) with **C** (capture mode uses a pre-trusted parent dir under `os.tmpdir()` that the bridge prompts the user to trust once on first install). Document the onboarding step.

## Other findings from this spike

1. **`--strict-mcp-config` + `--setting-sources ""` + `--dangerously-skip-permissions` + `--settings <hooks>` does NOT crash the spawn** — flag combo is valid; the boot just stops at the trust dialog.
2. **Hooks are NOT fired** before the trust dialog is answered. So `SessionStart` cannot be used to programmatically dismiss the dialog.
3. **`--session-id <uuid>` is accepted** in interactive mode (no immediate rejection); the transcript file only appears AFTER the trust dialog is answered.
4. **node-pty PTY contains ANSI escape sequences for the Ink TUI** — the bridge will need an ANSI scanner if option A is adopted. Reference: `smithersai/claude-p` does exactly this.

## Next steps

1. **PAUSE Phase 1 implementation** until the trust-dialog story is resolved.
2. **Update design.md** to add a new D-decision covering trust-dialog handling.
3. **Add a Phase 0 sub-spike** to verify the chosen approach.
