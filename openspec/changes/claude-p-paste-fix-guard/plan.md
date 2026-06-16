# Execution Plan

## Plan step 1: Commit OpenSpec plan artifacts

- **Covers:** T1.1
- **Pre-conditions:** `openspec/config.yaml` schema is `opsx-superpowers`; change name is `claude-p-paste-fix-guard`; `no-liveness-timeouts-add-visibility` remains untouched.
- **Action:**
  1. Author proposal, specs, clarify, design, analyze, review, tasks, and plan.
  2. Run `openspec status --change claude-p-paste-fix-guard`.
  3. Commit only `openspec/changes/claude-p-paste-fix-guard/**`.
- **Verification:** `openspec status` shows artifacts present; no changes under the other active OpenSpec change.
- **Rollback:** Revert the artifact commit.

## Plan step 2: Bump claude-p dependency pin

- **Covers:** T2.1, T2.2
- **Pre-conditions:** OpenSpec artifact commit exists.
- **Action:**
  1. Replace `github:cartwmic/claude-p#b24e3827a5c10ce5475578e4130ead74024d8b30` with `github:cartwmic/claude-p#f47f71dfa34593a32cb911f617f9cf8ca1fa0073` in `package.json`.
  2. Run `npm install` so `package-lock.json` and `node_modules/claude-p` resolve to the fixed fork and Zig prepare build runs.
  3. Inspect `package-lock.json` and installed package/source for fixed ref and paste-collapse echo handling.
  4. Commit `package.json` and `package-lock.json`.
- **Verification:** `npm install` exits 0; lockfile resolved URL contains `f47f71dfa34593a32cb911f617f9cf8ca1fa0073`; installed source contains `Pastedtext` or equivalent paste-collapse normalization.
- **Rollback:** Revert the pin commit and rerun `npm install`.

## Plan step 3: Add S31 scenario guard

- **Covers:** T3.1, T3.2
- **Pre-conditions:** Fixed claude-p dependency is installed.
- **Action:**
  1. Add `scripts/run-scenario-s31-large-cold-start-prompt.sh` with AC comments for `scenario-coverage.large-cold-start-prompt-coverage` and `claude-p-driver.fixed-claude-p-fork-pin`.
  2. Build a >1500 byte first prompt with a unique sentinel and instruct exact sentinel reply.
  3. Assert no `PromptNotAccepted`, at least one cold-start `fresh spawn ... resume=no`, and at least one `caching session=` line.
  4. Use `scn_assert_response` with positive sentinel and negative non-delivery regex.
  5. Add S31 entry to `SCENARIOS.md` and opus/timeout entry to `scripts/scenario-overrides.conf`.
  6. Commit scenario files and docs after validation evidence is captured in verify.md.
- **Verification:** live `bash scripts/run-scenario-s31-large-cold-start-prompt.sh` prints PASS for mechanical and coherence checks.
- **Rollback:** Remove S31 script and docs entries.

## Plan step 4: Validate and write verify.md

- **Covers:** T4.1, T4.2
- **Pre-conditions:** Pin and S31 scenario changes exist locally.
- **Action:**
  1. Run unit tests (`npm run test:unit`) and record result.
  2. Run live S31; retry once only if boot/network flake occurs.
  3. Run `openspec validate claude-p-paste-fix-guard --strict --json` if supported; otherwise record CLI behavior.
  4. Mark tasks complete.
  5. Author `verify.md` with structural, task, spec coherence, commit hygiene, AC↔test mapping, and constitution compliance checks.
  6. Commit `scripts/run-scenario-s31-large-cold-start-prompt.sh`, `scripts/scenario-overrides.conf`, `SCENARIOS.md`, `openspec/changes/claude-p-paste-fix-guard/tasks.md`, and `openspec/changes/claude-p-paste-fix-guard/verify.md`.
- **Verification:** final git log shows three logical local commits and no push.
- **Rollback:** Revert validation/scenario commit.

## Completion Verification

- `npm install` exits 0 and lockfile resolves `claude-p` to `f47f71dfa34593a32cb911f617f9cf8ca1fa0073`.
- `npm run test:unit` exits 0.
- `bash scripts/run-scenario-s31-large-cold-start-prompt.sh` exits 0.
- `openspec validate claude-p-paste-fix-guard --strict --json` is recorded in `verify.md`.
- AC literals appear in changed scenario/docs files.

## Manual Adjustments

- Execution Mode is standard, so steps use ordered implementation and validation rather than failing-test-first TDD.
