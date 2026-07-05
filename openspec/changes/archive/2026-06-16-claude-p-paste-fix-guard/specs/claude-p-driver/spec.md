# Capability: claude-p-driver

## ADDED Requirements

### Requirement: Fixed claude-p fork pin

The bridge dependency graph SHALL resolve `claude-p` to fork commit `f47f71dfa34593a32cb911f617f9cf8ca1fa0073` or a later approved fork commit that preserves paste-collapse echo confirmation.

#### Scenario: Installed claude-p includes paste-collapse echo confirmation
- **WHEN** repository dependencies are installed from `package-lock.json`
- **THEN** the resolved `node_modules/claude-p` package SHALL come from `github.com/cartwmic/claude-p` at commit `f47f71dfa34593a32cb911f617f9cf8ca1fa0073`
- **AND** the installed package SHALL contain echo-confirmation handling for the normalized Ink paste-collapse marker observed as `Pastedtext#1`

#### Scenario: Dependency pin does not change bridge behavior envelope
- **WHEN** the fixed claude-p package is installed
- **THEN** the bridge SHALL continue invoking claude-p as the interactive TUI driver
- **AND** the bridge SHALL NOT add any new write under `~/.claude/`
- **AND** the bridge SHALL NOT change the native-tool disallow configuration required by Constitution IV

## MODIFIED Requirements

## REMOVED Requirements

## RENAMED Requirements

---

## Acceptance criterion quality checklist

| AC ID | Testable | Solution-free | Unambiguous | Consistent | Complete |
|---|---|---|---|---|---|
| claude-p-driver.fixed-claude-p-fork-pin | [x] package-lock and installed package can be inspected | [x] specifies dependency behavior and safety envelope | [x] exact fork commit and marker named | [x] extends existing claude-p-driver patched-binary requirement | [x] covers resolution, installed content, and no policy drift |
