# Capability: claude-p-fork (delta)

## ADDED Requirements

### Requirement: Write-Only PTY Output Mirror

WHERE the `--mirror-file <path>` flag is supplied, THE patched `claude-p` driver SHALL append every byte read from the `claude` PTY output to the given file, in arrival order, as a pure tee. Mirroring SHALL be strictly write-only
with respect to the session: THE driver SHALL NOT send any keystroke, answer,
or byte to the PTY input on behalf of the mirror, and the prompt-delivery
behavior (echo-confirm gate, bounded retype, trust-dialog handling, Ink
readiness waits) SHALL be identical whether the flag is present or absent.
WHEN the flag is absent, THE driver's behavior SHALL be byte-for-byte
unchanged from the pre-patch binary.

#### Scenario: Mirror captures the session
- **WHEN** a turn runs with `--mirror-file` set
- **THEN** the file contains the raw PTY output bytes of the session in arrival order
- **AND** the turn's stdout output (text/json/stream-json) is unchanged from a run without the flag

#### Scenario: Absent flag, unchanged behavior
- **WHEN** a turn runs without `--mirror-file`
- **THEN** no mirror file is created and no mirror-related code path affects the turn

#### Scenario: Mirror write failure is non-fatal
- **IF** the mirror file cannot be opened or a mirror write fails mid-turn
- **THEN** the driver SHALL continue the turn unaffected, at most noting the failure on stderr
- **AND** the turn's exit code and stdout output are unchanged by the mirror failure

#### Scenario: Fork patch conventions preserved
- **WHEN** the fork's history is inspected after the change
- **THEN** the mirror patch is a clearly-marked `custom:` commit per the fork-maintenance requirement

---

## Acceptance criterion quality checklist

| AC ID | Testable | Solution-free | Unambiguous | Consistent | Complete |
|---|---|---|---|---|---|
| claude-p-fork.write-only-pty-output-mirror | [x] | [x] | [x] | [x] | [x] |
