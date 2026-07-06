<!-- authored: in-session -->

## 1. Preserve tool-use block boundaries

- [ ] 1.1 Close open inline assistant blocks when the bridge processes a driver `tool-use` event, without changing tool routing, result handling, usage accounting, or turn completion.
  - intent: fix
  - files_allowed:
      - index.ts
  - allow_new_files: false

## 2. Regression coverage

- [ ] 2.1 Add regression coverage for assistant text separated by tool-use boundaries, including replay-style delivery where router parking does not close blocks.
  - intent: fix
  - files_allowed:
      - tests/**/*.mjs
      - tests/**/*.ts
      - test/**/*.mjs
      - test/**/*.ts
  - allow_new_files: true

## 3. Validation

- [ ] 3.1 Run the targeted regression test and the gate-required validation command(s); record evidence in the final response or verify artifact if the gate requires one.
  - intent: infra
  - files_allowed:
      - openspec/changes/preserve-tool-boundary-text-blocks/tasks.md
      - openspec/changes/preserve-tool-boundary-text-blocks/verify.md
  - allow_new_files: true
