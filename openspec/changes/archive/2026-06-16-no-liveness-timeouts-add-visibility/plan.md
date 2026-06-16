# Execution Plan

Execution Mode = standard (not tdd-required), so steps are ordered removals +
additions with validators after each, not strict failing-test-first. The change
is BREAKING: keep it compiling at every step.

## Plan step 1: Remove the idle watchdog from index.ts

- **Covers:** T1.1, T1.2
- **Pre-conditions:** clean main; baseline validators green.
- **Action:**
  1. Delete `WATCHDOG_IDLE_MS`, `Watchdog`, `makeWatchdog`, `__makeWatchdogForTests`.
  2. Delete `frame.watchdog` field + every `.poke()`/`.stop()` and the `makeWatchdog({...})`/`onWedge` block in `startFreshQueryClaudeP`.
  3. `npm run typecheck` → expect PASS (no dangling refs).
- **Verification:** typecheck.
- **Rollback:** `git checkout index.ts`.

## Plan step 2: Remove killWedged + `--timeout` plumbing

- **Covers:** T2.1, T2.2
- **Pre-conditions:** step 1 done.
- **Action:**
  1. Remove `killWedged` (interface + impl + wrapper forwarding + `makeFailedHandle`) in `src/driver/claudeP.ts`.
  2. Remove `timeoutSeconds` from `ClaudePSpawnConfig` + `--timeout` emission; remove `CLAUDE_P_TIMEOUT_SECONDS` + threading in `index.ts` (`buildCaptureDeps`) and `src/capture.ts` (`CaptureDeps`, `cfg`).
  3. `npm run typecheck` → PASS.
- **Verification:** typecheck.
- **Rollback:** `git checkout src/driver/claudeP.ts src/capture.ts index.ts`.

## Plan step 3: Stderr capture + premature-error tail

- **Covers:** T3.1, T3.2 (AC `driver-diagnostics.child-stderr-is-captured-to-a-per-spawn-debug-file`, `driver-diagnostics.premature-exit-error-surfaces-the-last-stderr-lines`)
- **Pre-conditions:** step 2 done.
- **Action:**
  1. Replace the stderr handler in `spawnClaudeP` with per-spawn-file append + bounded tail ring.
  2. Thread the tail through `settle()` → `endOfStream` → `prematureMessage` in `src/driver/stream.ts`.
  3. `npm run typecheck` → PASS.
- **Verification:** typecheck; unit test added in step 5.
- **Rollback:** `git checkout src/driver/claudeP.ts src/driver/stream.ts`.

## Plan step 4: State dump + `--debug-file` forwarding

- **Covers:** T4.1, T4.2 (AC `driver-diagnostics.in-flight-state-dump-on-abnormal-termination`, `driver-diagnostics.claude-debug-logging-is-forwarded-to-a-bridge-owned-file`)
- **Pre-conditions:** step 3 done.
- **Action:**
  1. Add `lastDeltaAt` tracking + `claudeP.lifecycle.stateDump` log at settle/abort.
  2. Add `debugFile?` spawn option → `--debug-file` argv; resolve per-spawn bridge path in `index.ts`/`capture.ts` gated by `CLAUDE_BRIDGE_CLAUDE_DEBUG_FILE`.
  3. `npm run typecheck` → PASS.
- **Verification:** typecheck; argv unit test in step 5.
- **Rollback:** `git checkout src/driver/claudeP.ts index.ts src/capture.ts`.

## Plan step 5: Tests + docs

- **Covers:** T5.1–T5.5
- **Pre-conditions:** steps 1–4 done.
- **Action:**
  1. Delete `unit-watchdog.mjs` + `unit-driver-killwedged.mjs`.
  2. Update `unit-driver-claude-p.mjs` (`--timeout`→`--debug-file`), drop `timeoutSeconds` from baseCfgs (resilience, disallow-list, integration).
  3. Add `unit-driver-stderr-capture.mjs`.
  4. README/CHANGELOG/constitution doc updates.
  5. `npm run test:unit` → PASS.
- **Verification:** unit suite.
- **Rollback:** `git checkout tests README.md CHANGELOG.md`.

## Plan step 6: Full validation + symbol sweep

- **Covers:** T5.4 (grep), T6.1
- **Action:**
  1. `grep -rn "killWedged\|WATCHDOG\|makeWatchdog\|timeoutSeconds\|CLAUDE_P_TIMEOUT" index.ts src tests` → expect zero (spike-notes excluded).
  2. `npm run typecheck && npm run build && npm run test:unit` → green.
  3. Integration suite if `claude`/`claude-p` + creds available; else record environment-gated status vs baseline.
- **Verification:** typecheck + build + unit green; integration where feasible.
- **Rollback:** revert the code commit.

## Completion Verification

- `npm run typecheck` → "No errors found"
- `npm run build` → exit 0
- `npm run test:unit` → 0 fail
- `grep -rn "killWedged\|makeWatchdog\|WATCHDOG\|CLAUDE_P_TIMEOUT\|timeoutSeconds" index.ts src/ tests/` → no source matches

## Manual Adjustments

- Standard (non-TDD) order: removals are type-checked rather than test-first;
  new visibility code gets a dedicated unit test (step 5.3) + argv test (5.2).
- Integration tests require real `claude` + Anthropic credentials; if
  unavailable in the apply environment, unit + typecheck + build are the binding
  gate and integration status is reported against the recorded baseline.
