# claude-p-fork Specification

## Purpose

The custom patch carried on the maintained fork `cartwmic/claude-p` (forked from
`smithersai/claude-p` per the `forking-for-custom-patches` skill). These
requirements describe what the patched `claude-p` driver guarantees about
delivering a prompt into the interactive `claude` session, independent of how the
binary is built or consumed (that is `claude-p-binary-provisioning`). The patch
is the proven root-cause fix for the StopTimeout "hang"
(`.spike-notes/claude-p-gate/stoptimeout-rootcause-PROVEN.md`).

## Requirements

### Requirement: Echo-confirmed prompt commit

WHEN the patched `claude-p` driver has typed the pi prompt into the interactive `claude` PTY, THE driver SHALL confirm the typed prompt was accepted by observing its echo in the captured PTY output before it presses Enter to submit the turn. The confirmation SHALL read the existing rolling PTY-output buffer
(`SharedState.recent`), match the prompt echo in an ANSI-tolerant manner (the
match SHALL tolerate escape sequences, line-wrapping, and box-drawing inserted by
Ink), and SHALL only then send the Enter keystroke. The Enter keystroke SHALL NOT
be sent on the basis of an elapsed timer alone.

#### Scenario: Prompt echo observed, then committed
- **WHEN** the prompt keystrokes are typed and the PTY output subsequently contains the prompt echo
- **THEN** the driver presses Enter to submit the turn
- **AND** the turn proceeds to await the `Stop` hook exactly as before the patch

#### Scenario: No reliance on the blind debounce
- **WHEN** a turn is driven by the patched binary
- **THEN** the Enter keystroke is gated on the observed echo, not on the unconditional `ink_enter_debounce_ms` sleep the stock binary used

### Requirement: Bounded retype on dropped prompt

WHILE the prompt echo has not yet been observed and the confirmation budget has not been exhausted, THE driver SHALL re-type the prompt (preceded by a clear-line keystroke so a partially-accepted prompt cannot concatenate into a corrupted input buffer), re-checking for the echo after each attempt. Re-typing SHALL occur
only before the Enter keystroke has been sent, so the operation cannot submit the
turn more than once.

#### Scenario: First type dropped, retype lands
- **WHEN** the first typed prompt produces no echo within the per-attempt window
- **THEN** the driver sends a clear-line keystroke and types the prompt again
- **AND** when the echo is then observed, the driver presses Enter exactly once

#### Scenario: Retype cannot double-submit
- **WHEN** any number of retype attempts occur
- **THEN** no Enter keystroke is sent until an echo is confirmed
- **AND** at most one Enter keystroke is ever sent for the turn

### Requirement: Fail fast when the prompt cannot be confirmed

IF the prompt echo is not observed after the bounded retype budget is exhausted, THEN the patched driver SHALL abandon the turn with a distinct, named error (a new `RunError` variant, e.g. `PromptNotAccepted`) and exit promptly, rather
than pressing Enter and waiting the full `--timeout` for a `Stop` hook that can
never fire. The prompt error SHALL be distinguishable on stderr from
`StopTimeout` and `SessionStartTimeout` so the bridge can classify it.

#### Scenario: Unconfirmable prompt fails fast
- **IF** every retype attempt within the budget produces no echo
- **THEN** the driver exits with the `PromptNotAccepted` error well before `--timeout` elapses
- **AND** stderr names the failure distinctly from `StopTimeout`

#### Scenario: Bridge can retry the fast-fail
- **IF** the patched driver exits with `PromptNotAccepted` and no `tools/call` was routed for the turn
- **THEN** the failure is retriable by the bridge's existing resilience layer (design D33), the same as a transient hook timeout

### Requirement: Patch preserves the interactive-TUI driving model

THE patch SHALL change only WHEN keystrokes are committed (the echo-confirm gate),
and SHALL NOT introduce any non-interactive prompt-delivery path. The patched
driver SHALL continue to drive the interactive `claude` TUI via the PTY and SHALL
NOT cause `claude` to be invoked in nominal print mode (`-p`/`--print`), preserving
the bridge's hard requirement that no nominal `claude -p` surface is used.

#### Scenario: Still interactive after the patch
- **WHEN** the patched binary runs any turn
- **THEN** `claude` is driven through the interactive Ink TUI in a PTY
- **AND** no `-p`/`--print` invocation of `claude` is produced

#### Scenario: Native-tool isolation untouched
- **WHEN** the patched binary forwards flags to `claude`
- **THEN** `--disallowedTools`, `--strict-mcp-config`, and `--setting-sources` are forwarded exactly as the stock binary forwarded them (constitution principle IV unaffected)

### Requirement: Fork is maintained against upstream

THE fork SHALL retain the patch as a clearly-marked custom commit on the fork's
default branch (commit message prefixed `custom:` with the upstream URL and
reason, per the `forking-for-custom-patches` skill) and SHALL keep the `upstream`
remote configured so upstream releases can be merged via the `sync-custom-forks`
workflow. The patch SHALL be confined to the input-commit step so it ports across
upstream revisions with minimal conflict surface.

#### Scenario: Custom patch is identifiable
- **WHEN** the fork's history is inspected
- **THEN** the patch commit is prefixed `custom:` and names the upstream repo and the reason
- **AND** an `upstream` remote points at `smithersai/claude-p`
