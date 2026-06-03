## Why

The `claude-p` driver intermittently wedges (silent up to the 600s `--timeout`,
then exit 2 `StopTimeout`). Root cause is **proven**
(`.spike-notes/claude-p-gate/stoptimeout-rootcause-PROVEN.md`): under
concurrent-boot CPU contention, `claude-p` types the prompt before the `claude`
Ink TUI's input is ready, the keystrokes drop, no turn starts, the `Stop` hook
never fires. Upstream is a single-turn, concurrency-1 educational tool that won't
fix this, so we carry a small fork.

## What Changes

- Fork `smithersai/claude-p` → `cartwmic/claude-p` (per `forking-for-custom-patches`:
  `custom:`-prefixed commit on the fork's default branch, `upstream` remote kept).
- Patch `src/driver.zig` (~30 lines): replace the blind 120ms `ink_enter_debounce_ms`
  sleep with an **echo-confirm-or-retype** loop over the existing `SharedState.recent`
  PTY buffer — press Enter only after the prompt echo is observed; clear-line + retype
  on miss (bounded); fail fast with a new `RunError` if never confirmed.
- Build the patched binary for the dev platform and **repoint** this bridge branch's
  `package.json` `claude-p` dependency to the fork; add a patched-binary identity
  check so a silent fallback to the stock binary is caught.
- Validate with `stoptimeout-proof.mjs`: the same load that gave 2/60 `StopTimeout`
  on the stock binary must drop to **0**.
- Non-breaking: driver contract, flags, MCP/transcript behavior unchanged.

## Capabilities

### New Capabilities
- `claude-p-fork`: the fork's echo-confirm input contract — what the patched driver
  guarantees about delivering a prompt and failing fast, and that it stays a
  maintained fork.

### Modified Capabilities
- `claude-p-driver`: prompt-delivery tightens (a turn MUST NOT advance to awaiting
  `Stop` until the prompt is confirmed delivered; an unconfirmable prompt fails fast,
  retriable, not a `--timeout` wedge), and the driver MUST run the patched binary.

## Impact

- **Bridge files:** `package.json` (dependency repoint), `index.ts`
  (`resolveClaudePBin` + identity check), `tests/**` (validation wiring),
  `.spike-notes/claude-p-gate/**` (harness + fixtures).
- **Fork files (`cartwmic/claude-p`):** `src/driver.zig`, one `RunError` variant.
- **Dependencies:** `claude-p` shifts from npm-prebuilt to fork-sourced; introduces a
  Zig 0.15.2 build for the fork.
- **Constitution:** III (no `~/.claude` writes) and IV (native-tool disallow) are
  unaffected and re-verified; the interactive-TUI / no-nominal-`-p` guarantee holds
  (the patch changes only *when* keystrokes commit).
- **Out of scope (follow-ups):** multi-platform CI/release pipeline for the fork
  binary; bridge-side concurrency cap + idle-watchdog (defense-in-depth).
