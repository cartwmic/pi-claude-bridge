## 1. OpenSpec artifacts

- [x] 1.1 Author Scale-M OpenSpec artifacts for the approved change
  - intent: infra
  - files_allowed:
      - openspec/changes/claude-p-paste-fix-guard/**
  - files_forbidden:
      - openspec/changes/no-liveness-timeouts-add-visibility/**
  - allow_new_files: true

## 2. Dependency pin

- [x] 2.1 Bump claude-p to fixed fork commit and refresh npm lockfile
  - intent: infra
  - files_allowed:
      - package.json
      - package-lock.json
      - openspec/changes/claude-p-paste-fix-guard/**
  - files_forbidden:
      - openspec/changes/no-liveness-timeouts-add-visibility/**
  - allow_new_files: false

- [x] 2.2 Verify installed claude-p resolves to `f47f71dfa34593a32cb911f617f9cf8ca1fa0073` and contains paste-collapse echo handling
  - intent: infra
  - files_allowed:
      - package.json
      - package-lock.json
      - openspec/changes/claude-p-paste-fix-guard/**
  - files_forbidden:
      - openspec/changes/no-liveness-timeouts-add-visibility/**
  - allow_new_files: false

## 3. Scenario coverage

- [x] 3.1 Add S31 large cold-start prompt scenario using `scenario-lib.sh`
  - intent: feature
  - files_allowed:
      - scripts/run-scenario-s31-large-cold-start-prompt.sh
      - scripts/scenario-overrides.conf
      - SCENARIOS.md
      - openspec/changes/claude-p-paste-fix-guard/**
  - files_forbidden:
      - openspec/changes/no-liveness-timeouts-add-visibility/**
  - allow_new_files: true

- [x] 3.2 Document S31 in `SCENARIOS.md` and scenario override metadata
  - intent: feature
  - files_allowed:
      - scripts/scenario-overrides.conf
      - SCENARIOS.md
      - openspec/changes/claude-p-paste-fix-guard/**
  - files_forbidden:
      - openspec/changes/no-liveness-timeouts-add-visibility/**
  - allow_new_files: false

## 4. Validation and completion

- [x] 4.1 Run unit tests and live S31; retry S31 once only for transient boot/network failure
  - intent: infra
  - files_allowed:
      - openspec/changes/claude-p-paste-fix-guard/**
      - .test-output/scenarios/**
  - files_forbidden:
      - openspec/changes/no-liveness-timeouts-add-visibility/**
  - allow_new_files: true

- [x] 4.2 Author `verify.md` with the six opsx-superpowers checks and validation evidence
  - intent: infra
  - files_allowed:
      - openspec/changes/claude-p-paste-fix-guard/**
  - files_forbidden:
      - openspec/changes/no-liveness-timeouts-add-visibility/**
  - allow_new_files: true
