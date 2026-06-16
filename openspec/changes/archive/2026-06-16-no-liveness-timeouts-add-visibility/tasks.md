## 1. Remove the idle watchdog (Part A.1, design D1)

- [x] 1.1 Delete `WATCHDOG_IDLE_MS`, the `Watchdog` interface, `makeWatchdog`, and the `__makeWatchdogForTests` export from `index.ts`.
  - intent: refactor
  - files_allowed:
      - index.ts
  - allow_new_files: false
- [x] 1.2 Remove `frame.watchdog` field, all `.poke()`/`.stop()` calls (delivery re-arm ~:999, abortFrame, finalizeClaudePFrame), and the `makeWatchdog({...})` instantiation + `onWedge` wiring in `startFreshQueryClaudeP`.
  - intent: refactor
  - files_allowed:
      - index.ts
  - allow_new_files: false

## 2. Remove killWedged + `--timeout` plumbing (Part A.1/A.2, design D2/D3)

- [x] 2.1 Remove `ClaudePHandle.killWedged` (interface doc + impl in `spawnClaudeP`, the resilience-wrapper forwarding, and `makeFailedHandle`) from `src/driver/claudeP.ts`. Verify the abort + resilience paths still settle.
  - intent: refactor
  - files_allowed:
      - src/driver/claudeP.ts
  - allow_new_files: false
- [x] 2.2 Remove `timeoutSeconds` from `ClaudePSpawnConfig` + the `--timeout` emission in `buildClaudePArgs` (`src/driver/claudeP.ts`); remove `CLAUDE_P_TIMEOUT_SECONDS` constant + `timeoutSeconds` threading in `buildCaptureDeps` (`index.ts`) and `CaptureDeps`/`cfg` (`src/capture.ts`).
  - intent: refactor
  - files_allowed:
      - src/driver/claudeP.ts
      - src/capture.ts
      - index.ts
  - allow_new_files: false

## 3. Add visibility: stderr capture + premature error tail (Part B.4, design D4)

- [x] 3.1 In `spawnClaudeP`, capture child stderr to a per-spawn file under the bridge debug dir (lazy-open, best-effort, never throws; one-line log pointer) AND keep a bounded ring of the last `STDERR_TAIL_LINES` (=20) lines. Do not touch stdout.
  - intent: feature
  - files_allowed:
      - src/driver/claudeP.ts
  - allow_new_files: false
- [x] 3.2 Thread the captured stderr tail into `endOfStream`/`prematureMessage` (`src/driver/stream.ts`) so a premature, non-aborted, no-`result` exit's `error` event appends a bounded `— last stderr:` section. Pass it from the driver's `settle()`.
  - intent: feature
  - files_allowed:
      - src/driver/stream.ts
      - src/driver/claudeP.ts
  - allow_new_files: false

## 4. Add visibility: state dump + debug-file forwarding (Part B.5/B.6, design D5/D6)

- [x] 4.1 Emit one structured `claudeP.lifecycle.stateDump` warn log at the driver's terminal settle/abort site carrying `{ lastDeltaEpochMs, lastDeltaAgeMs, heldRound, partialBufferLen }`. Track `lastDeltaAt` on each forwarded event.
  - intent: feature
  - files_allowed:
      - src/driver/claudeP.ts
  - allow_new_files: false
- [x] 4.2 Add optional `debugFile?: string` spawn option → `--debug-file <path>` in `buildClaudePArgs`. In `index.ts`/`capture.ts` resolve a per-spawn bridge-owned debug path (under the debug dir, asserted NOT under `~/.claude/`) and pass it unless `CLAUDE_BRIDGE_CLAUDE_DEBUG_FILE === "0"`.
  - intent: feature
  - files_allowed:
      - src/driver/claudeP.ts
      - index.ts
      - src/capture.ts
  - allow_new_files: false

## 5. Tests + docs

- [x] 5.1 Delete `tests/unit-watchdog.mjs` and `tests/unit-driver-killwedged.mjs`.
  - intent: refactor
  - files_allowed:
      - tests/unit-watchdog.mjs
      - tests/unit-driver-killwedged.mjs
  - allow_new_files: false
- [x] 5.2 Update `tests/unit-driver-claude-p.mjs`: remove the two `--timeout` emission tests and `timeoutSeconds` from baseCfg; add a `buildClaudePArgs` test asserting `--debug-file <path>` is emitted when `debugFile` is set and omitted when unset. Remove `timeoutSeconds` from baseCfgs in `unit-driver-resilience.mjs` + `unit-disallow-list.mjs`.
  - intent: feature
  - files_allowed:
      - tests/unit-driver-claude-p.mjs
      - tests/unit-driver-resilience.mjs
      - tests/unit-disallow-list.mjs
  - allow_new_files: false
- [x] 5.3 Add a unit test (`tests/unit-driver-stderr-capture.mjs`) driving a stub bin that writes to stderr then exits non-zero with no `result`; assert the `error` event's `errorMessage` contains the stderr tail. Cite AC `driver-diagnostics.premature-exit-error-surfaces-the-last-stderr-lines`.
  - intent: feature
  - files_allowed:
      - tests/unit-driver-stderr-capture.mjs
  - allow_new_files: true
- [x] 5.4 Update integration tests that set `timeoutSeconds` (int-claude-p-*.mjs, int-capture-termination-bench.mjs) to drop the now-unknown field. Grep the repo to confirm NO non-spike-notes source references `killWedged`, `WATCHDOG`, `makeWatchdog`, `timeoutSeconds`, or `CLAUDE_P_TIMEOUT` after removal.
  - intent: refactor
  - files_allowed:
      - tests/**/*.mjs
  - allow_new_files: false
- [x] 5.5 Update README + CHANGELOG: remove `CLAUDE_BRIDGE_WATCHDOG_IDLE_MS` and `CLAUDE_BRIDGE_CLAUDE_P_TIMEOUT_SECONDS`; document `CLAUDE_BRIDGE_CLAUDE_DEBUG_FILE` + the no-liveness-timeouts principle. Update constitution only if needed (it already aligns with VII).
  - intent: docs
  - files_allowed:
      - README.md
      - CHANGELOG.md
      - openspec/constitution.md
  - allow_new_files: false

## 6. Validate

- [x] 6.1 Run `npm run typecheck`, `npm run build`, `npm run test:unit`; iterate until green. Run the integration suite where the environment permits real `claude`/`claude-p`; otherwise record pre-existing/environment-gated status against the baseline.
  - intent: infra
  - files_allowed:
      - "**/*"
  - allow_new_files: true
