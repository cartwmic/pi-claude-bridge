# Capability: warm-pi-resume

<!-- authored: in-session -->

## ADDED Requirements

### Requirement: Resume Sidecar Records Driver Identity

WHEN a resumable main-provider turn persists a sidecar, THE bridge SHALL record its driver identity alongside the existing opaque session id, history fingerprint chain, and Claude version without storing conversation content.

#### Scenario: Direct turn writes typed sidecar
- **WHEN** a resumable `claude-print` main turn completes without error
- **THEN** its sidecar records driver `claude-print` and the direct session id

#### Scenario: Legacy sidecar has no driver field
- **WHEN** an existing sidecar without driver identity is loaded
- **THEN** the bridge interprets it as `claude-p` for migration compatibility

### Requirement: Cross-Driver Warm Resume Is Forbidden

IF a sidecar's recorded driver differs from the currently selected driver, THEN THE bridge SHALL invalidate that resume hint and cold-start the current driver as a normal turn.

#### Scenario: Switch from interactive to direct
- **IF** a valid `claude-p` sidecar exists and configuration now selects `claude-print`
- **THEN** the bridge does not pass the interactive session id to direct Claude
- **AND** the direct turn cold-starts with current pi history

#### Scenario: Switch back to interactive
- **IF** a `claude-print` sidecar exists and configuration now selects `claude-p`
- **THEN** the bridge does not pass the direct session id to `claude-p`
- **AND** the interactive turn cold-starts normally

---

## Acceptance criterion quality checklist

| AC ID | Testable | Solution-free | Unambiguous | Consistent | Complete |
|---|---|---|---|---|---|
| warm-pi-resume.resume-sidecar-records-driver-identity | [x] | [x] | [x] | [x] | [x] |
| warm-pi-resume.cross-driver-warm-resume-is-forbidden | [x] | [x] | [x] | [x] | [x] |
