## Why

Cold-start pi prompts at 801+ bytes can be accepted by Claude's Ink TUI as a paste-collapse placeholder instead of literal echo, and the current bridge dependency pin still resolves to a claude-p fork revision that rejects that path with `claude-p: PromptNotAccepted`. This violates Constitution VII because a real user prompt fails before the inference turn reaches the model, and the scenario suite missed it because the largest existing scenario prompt is 236 bytes.

## What Changes

- Pin `claude-p` to fork commit `f47f71dfa34593a32cb911f617f9cf8ca1fa0073`, which accepts the normalized Ink paste-collapse marker during echo confirmation.
- Add scenario S31: first turn of a fresh `pi --no-session` session sends a >800 byte prompt with a sentinel and requires an exact sentinel reply.
- Document S31 in `SCENARIOS.md` as the regression guard for large cold-start prompt delivery through claude-p / Ink paste-collapse.
- Add verification evidence for dependency resolution, unit tests, and a live S31 run.

## Capabilities

### New Capabilities
- `scenario-coverage`: live TUI scenario coverage for regression classes not covered by unit tests or shorter scenario prompts.

### Modified Capabilities
- `claude-p-driver`: dependency pin must resolve to a claude-p fork revision that accepts large cold-start prompts collapsed by Ink paste display.

## Impact

Affected files:
- `package.json`
- `package-lock.json`
- `scripts/run-scenario-s31-large-cold-start-prompt.sh`
- `scripts/scenario-overrides.conf`
- `SCENARIOS.md`
- `openspec/changes/claude-p-paste-fix-guard/**`

Affected systems:
- npm dependency resolution and installed `node_modules/claude-p` binary build.
- Real pi TUI scenario harness using tmux and the claude-p driver.
- No bridge API change, no persisted conversation state, no writes under `~/.claude/`, and no native tool policy change.
