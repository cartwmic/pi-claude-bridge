## Why

The bridge currently guesses a `claude-p` subprocess is "wedged" via two
liveness timers — a held-round-aware idle **watchdog** (`WATCHDOG_IDLE_MS`,
index.ts) that SIGKILLs after 180s of stdout silence, and claude-p's own
wall-clock `--timeout` backstop (`CLAUDE_P_TIMEOUT_SECONDS`). Both are
heuristics that can kill a healthy-but-slow turn and neither helps a human
diagnose a real hang. The owner has adopted a strict principle: **no
liveness/wedge timeouts** — recovery is CALLER-DRIVEN abort (the existing
SIGINT→grace→SIGKILL process-group kill on pi's `AbortSignal`) plus strong
VISIBILITY so a real hang is self-diagnosing and handled reactively. This
aligns with constitution Principle VII (failures surface; degradation is
explicit): a silent timer that masks the underlying error is the opposite of
surfacing it.

## What Changes

- **BREAKING** Remove the idle watchdog: `makeWatchdog`, `WATCHDOG_IDLE_MS`,
  `__makeWatchdogForTests`, the per-frame `frame.watchdog` instance, all
  `.poke()`/`.stop()` calls, and the `onWedge → killWedged()` wiring.
- **BREAKING** Remove `ClaudePHandle.killWedged()` (interface + impl) — only
  the watchdog called it; the abort path uses `handle.abort()`.
- **BREAKING** Remove the `CLAUDE_BRIDGE_CLAUDE_P_TIMEOUT_SECONDS` knob, the
  `CLAUDE_P_TIMEOUT_SECONDS` constant, the `timeoutSeconds` field on
  `ClaudePSpawnConfig`/`CaptureDeps`, and the `--timeout` flag emission in
  `buildClaudePArgs`. claude-p always runs with no wall cap.
- Preserve the resilience retry gate: a premature/no-result exit still
  classifies as `error` via the existing `proc 'close'`/`endOfStream` path and
  flows through `shouldRetry` (no replacement timer is added).
- **VISIBILITY** Capture claude-p child **stderr** into a per-spawn rotated
  debug file and surface the last N stderr lines in the premature-exit `error`
  event (so `PromptNotAccepted`/`StopTimeout`/Anthropic stream errors are
  observable). stdout stays clean (claude-p parses it as NDJSON).
- **VISIBILITY** On abort/forced-termination/premature-exit, log an in-flight
  state dump (last-delta age, held-round flag, partial-buffer length).
- **VISIBILITY** Always-on forward `claude --debug-file <per-spawn path>` to the
  child `claude` via claude-p's verbatim unknown-flag passthrough (no fork).

## Capabilities

### New Capabilities
- `driver-diagnostics`: observability surface for a `claude-p` spawn — child
  stderr capture to a per-spawn debug file, last-N-stderr-lines in the error
  event, an in-flight state dump on abnormal termination, and always-on
  `claude --debug-file` forwarding.

### Modified Capabilities
- `claude-p-driver`: removes the wall-clock `--timeout` requirement and the
  bridge-side idle-watchdog liveness mechanism; premature-exit-as-error and
  caller-driven abort become the sole recovery contract.

## Impact

- **Affected files:**
  - `index.ts` — remove watchdog block, `frame.watchdog`, pokes, `onWedge`
    wiring, `CLAUDE_P_TIMEOUT_SECONDS`, `timeoutSeconds` plumbing; add
    state-dump logging + debug-dir resolution + `--debug-file` path wiring.
  - `src/driver/claudeP.ts` — remove `killWedged` (interface + impl) and
    `timeoutSeconds`/`--timeout`; capture stderr into a per-spawn file + ring
    buffer; thread last-N-stderr into the premature `error` message; accept a
    `debugFile` spawn option → `--debug-file` argv.
  - `src/driver/stream.ts` — thread optional stderr tail into `prematureMessage`.
  - `src/capture.ts` — drop `timeoutSeconds` plumbing; pass debug-file option.
  - `openspec/specs/claude-p-driver/spec.md` — delta (remove `--timeout`
    requirement; reword premature-exit requirement).
- **Tests:** delete `unit-watchdog.mjs` + `unit-driver-killwedged.mjs`; update
  `unit-driver-claude-p.mjs` (`--timeout` assertions) and any `timeoutSeconds`
  baseCfgs; add tests for stderr-tail-in-error and `--debug-file` argv.
- **Env/Docs:** `CLAUDE_BRIDGE_WATCHDOG_IDLE_MS` and
  `CLAUDE_BRIDGE_CLAUDE_P_TIMEOUT_SECONDS` are removed (README/CHANGELOG note).
- **No new runtime dependencies.** No change to `~/.claude/` access
  (constitution III): the debug file is written under the bridge's own debug
  dir, and `--debug-file` points `claude` at a bridge-owned path.
