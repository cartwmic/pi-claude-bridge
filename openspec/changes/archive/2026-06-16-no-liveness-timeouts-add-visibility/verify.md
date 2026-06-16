# Verify

**Generated:** 2026-06-14 by worker (claude)
**Change:** no-liveness-timeouts-add-visibility

## Completion Decision

**Status:** green

## Checks

| # | Check | Status | Details |
|---|---|---|---|
| 1 | Structural validation (`openspec validate --strict`) | pass | "Change 'no-liveness-timeouts-add-visibility' is valid" |
| 2 | Task completion (zero `- [ ]` in tasks.md) | pass | 14/14 tasks checked; 0 unchecked |
| 3 | Delta vs current spec coherence | pass | claude-p-driver: 2 MODIFIED + 1 REMOVED (`--timeout` req) — matches code (no `--timeout`, no watchdog). driver-diagnostics: 4 ADDED — all implemented in src/driver/claudeP.ts + stream.ts + index.ts. |
| 4 | Commit hygiene (subject ≤72; body explains why) | pass | `docs(openspec): propose…` (49) and `feat(driver)!: remove liveness timeouts; add caller-driven-recovery visibility` (72); both bodies explain WHY + carry BREAKING CHANGE trailer. |
| 5 | AC↔test mapping (canonical IDs) | pass | See detail; 6/6 ACs forward-covered, all changed test files reverse-covered or exempt. |
| 6 | Constitution compliance audit | pass | III honored (no `~/.claude/` writes; diagnostics under bridge debug dir, `--debug-file` to bridge path); VII honored (silent guess-and-kill → surfaced stderr + state dump). |

## Check 5 detail — AC↔test mapping (canonical ID format)

### Forward coverage (each AC has ≥1 test)

| AC ID | Test references | Status |
|---|---|---|
| claude-p-driver.unexpected-driver-exit-surfaces-as-error | tests/unit-driver-resilience.mjs (literal ID); tests/unit-driver-error-late-tool-result.mjs (behavioral premature-exit→error) | covered |
| claude-p-driver.prompt-injection-via-claude-p-input | tests/unit-cold-start-prompt.mjs + int-claude-p-main-turn (behavioral; modified req only dropped `--timeout` wording, injection behavior unchanged) | covered |
| driver-diagnostics.child-stderr-is-captured-to-a-per-spawn-debug-file | tests/unit-driver-stderr-capture.mjs (literal ID) | covered |
| driver-diagnostics.premature-exit-error-surfaces-the-last-stderr-lines | tests/unit-driver-stderr-capture.mjs (literal ID) | covered |
| driver-diagnostics.in-flight-state-dump-on-abnormal-termination | tests/unit-driver-stderr-capture.mjs (literal ID, comment) + int-claude-p-abort (live `claudeP.lifecycle.stateDump` asserted in debug log) | covered |
| driver-diagnostics.claude-debug-logging-is-forwarded-to-a-bridge-owned-file | tests/unit-driver-claude-p.mjs (literal ID + `--debug-file` argv assertions) | covered |

### Reverse coverage (each changed test references ≥1 AC)

| Test file | AC references | Status |
|---|---|---|
| tests/unit-driver-stderr-capture.mjs (new) | driver-diagnostics.child-stderr-…, .premature-exit-…, .in-flight-state-dump-… | referenced |
| tests/unit-driver-claude-p.mjs | driver-diagnostics.claude-debug-logging-… | referenced |
| tests/unit-driver-resilience.mjs | claude-p-driver.unexpected-driver-exit-surfaces-as-error | referenced |
| tests/unit-driver-error-late-tool-result.mjs | `# spec-exempt: comment-only accuracy edit; behavioral anti-hang test unchanged` | exempt |
| tests/unit-disallow-list.mjs, tests/int-*.mjs, tests/spike-g4-singleshot-caching.mjs | `# spec-exempt: mechanical removal of the now-deleted timeoutSeconds field` | exempt |

## Check 6 detail — Constitution sampling

20 files changed (≤50 → audit all changed source files; coverage note below).

| Sampled file | Principles checked | Status | Notes |
|---|---|---|---|
| src/driver/claudeP.ts | III, VII | compliant | stderr file + state dump under bridge dir; `--debug-file` is a forwarded path the bridge owns; no `~/.claude/` write. |
| index.ts | III, VII | compliant | DIAGNOSTICS_DIR = dirname(claude-bridge.log); resolveClaudeDebugFile points under it; gated by CLAUDE_BRIDGE_CLAUDE_DEBUG_FILE. |
| src/capture.ts | V, VI | compliant | Capture prompt bytes untouched; per-spawn diagnostics keyed by capture session id (no cross-path state). |
| src/driver/stream.ts | VII | compliant | Premature error message now carries the stderr tail (more failure surfacing, not less). |

**Sampling coverage:** 4 source files audited of 6 changed source files (README/CHANGELOG excluded as docs) = 100% of behavioral source.

## Summary

- Pass count: 6/6
- Decision: green
- **Archive gate:** READY
