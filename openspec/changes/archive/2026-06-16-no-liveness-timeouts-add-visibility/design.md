## Context

The bridge drives Anthropic's `claude` CLI via a `claude-p` subprocess. Today it
runs **two liveness timers** that guess a spawn is wedged:

1. **Idle watchdog** (`index.ts`): `WATCHDOG_IDLE_MS` (180s, env
   `CLAUDE_BRIDGE_WATCHDOG_IDLE_MS`) + `makeWatchdog()`. Poked on every stream
   delta; when claude-p stdout is silent 180s AND no tool round is held, it calls
   `onWedge()` → `handle.killWedged()` (SIGKILL the process group, classified
   `error` → retry-eligible). While a tool round is held it defers forever.
2. **claude-p `--timeout`** (`CLAUDE_P_TIMEOUT_SECONDS`,
   env `CLAUDE_BRIDGE_CLAUDE_P_TIMEOUT_SECONDS`): a wall-clock backstop already
   defaulting to `undefined` (no cap), emitted by `buildClaudePArgs`.

The owner's principle: **no liveness/wedge timeouts.** Recovery is caller-driven
abort (`capture.ts`/`index.ts` `handle.abort()` → SIGINT → grace → SIGKILL of the
process GROUP, the unchanged D31 path) plus **visibility** so a real hang is
self-diagnosing and handled reactively. This is a **BREAKING** change: it removes
public env knobs and a driver interface method (`killWedged`).

Constitution principles respected: **VII** (failures surface; degradation is
explicit) — the removal trades a silent guess-and-kill for loud, observable
state; **III** (no writes under `~/.claude/`) — all new diagnostics write under
the bridge's own debug dir and `--debug-file` points `claude` at a bridge-owned
path. Domain invariant 1 (≤1 in-flight main turn) and invariant 2 (tool results
only via pi) are untouched.

## Goals / Non-Goals

**Goals:**
- Remove both liveness timers and the now-dead `killWedged()` path.
- Preserve the resilience retry gate keyed on a real `error`-classified exit
  (D33), with NO replacement timer.
- Preserve the caller-driven abort path (D31) exactly.
- Add visibility: child stderr capture to a per-spawn file, last-N stderr lines
  in the surfaced error event, an in-flight state dump on abnormal termination,
  and always-on `claude --debug-file` forwarding.

**Non-Goals:**
- No new retry/backoff policy; the existing bounded-retry wrapper stays.
- No claude-p fork change (see D5 finding — none is required).
- No change to nominal-turn streaming or cost/usage accounting.
- No new runtime dependency.

## Decisions

### D1: Remove the idle watchdog wholesale (no replacement timer)

**Choice:** Delete `makeWatchdog`, `WATCHDOG_IDLE_MS`, `__makeWatchdogForTests`,
`Watchdog` interface, `frame.watchdog`, all `.poke()`/`.stop()` calls, and the
`onWedge` wiring in `startFreshQueryClaudeP`. Liveness is no longer the bridge's
job.

**Alternatives considered:**
- **Keep the watchdog but default-disable (idleMs=0)**: leaves dead code and a
  re-enable footgun; contradicts the principle. Rejected.
- **Replace with a much larger idle window**: still a liveness guess. Rejected.

**Rationale:** The watchdog's only real recovery value was retrying a *boot*
wedge (no tool routed). A genuine boot failure already produces a real
subprocess exit (claude-p's `SessionStartTimeout`/`StopTimeout`, non-zero exit)
which classifies `error` via the existing `proc 'close'` → `endOfStream`
path and flows through `shouldRetry`. So the retry gate survives without the
watchdog. A *true* indefinite hang with no exit and no abort is now handled
reactively via abort + visibility — by design.

**4-point test:** multiple approaches Y; lasting Y; reasonable disagreement Y
(some would keep a generous watchdog); constrains future options Y → **ADR
candidate Y** (Scale M: optional; recorded here).

### D2: Remove `killWedged()` from the driver interface

**Choice:** Delete `ClaudePHandle.killWedged` (interface + impl in
`spawnClaudeP` + the resilience wrapper's forwarding + `makeFailedHandle`). Only
the watchdog called it; `abort()` is the caller-driven kill.

**Alternatives considered:**
- **Keep `killWedged` for external callers**: no other caller exists (verified
  by grep); keeping it is speculative API. Rejected.

**Rationale:** With the watchdog gone, `killWedged` is unreachable. Removing it
shrinks the interface and removes the `error`-vs-`aborted` asymmetry it existed
to bridge. The retry-gate behavior it documented is fully covered by natural
premature-exit classification.

**4-point test:** approaches Y; lasting Y; disagreement N; future-constraint Y →
ADR candidate N (mechanical interface narrowing).

### D3: Remove `--timeout` plumbing entirely

**Choice:** Delete `CLAUDE_P_TIMEOUT_SECONDS`, the `timeoutSeconds` field on
`ClaudePSpawnConfig` and `CaptureDeps`, its threading in `buildCaptureDeps`/
`capture.ts`, and the `--timeout` emission in `buildClaudePArgs`. claude-p always
runs with no wall cap (it treats an absent `--timeout` as unlimited).

**Alternatives considered:**
- **Keep the knob default-undefined**: it is still a liveness lever and a
  documented env knob; the principle says remove it. Rejected.

**Rationale:** A wall cap counts held-tool idle time (gate G7) and can kill a
healthy parked tool. Unattended-batch ceilings move to the supervisor, which
aborts the pi turn (caller-driven).

**4-point test:** approaches Y; lasting Y; disagreement Y; future-constraint Y →
ADR candidate Y (recorded here; Scale M optional).

### D4: Capture child stderr to a per-spawn file + ring buffer; surface tail in error

**Choice:** In `spawnClaudeP`, replace the current "log first 500 bytes of
stderr at info" handler with: (a) append every stderr chunk to a per-spawn file
under the bridge debug dir (`<debugDir>/claude-p-stderr-<sid8>-<pid>-<ts>.log`),
opened lazily on first chunk, best-effort (failure logs once, never throws);
(b) keep a bounded in-memory ring of the last `STDERR_TAIL_LINES` (=20) lines.
On premature `settle()` (not aborted, no `result`), pass the tail to
`endOfStream` so `prematureMessage` appends a `— last stderr:\n<tail>` section.

**Alternatives considered:**
- **Only the file, no tail in error**: forces a human to open the file for the
  most common case (PromptNotAccepted). Rejected — the tail in the event is the
  high-value visibility.
- **Tee stderr onto the bridge logger per line**: noisy and interleaves with
  structured logs; a dedicated file is cleaner and matches the stale-diag
  convention. Rejected as the primary sink (we still log a one-line pointer).

**Rationale:** stderr is where claude-p surfaces `PromptNotAccepted`/
`StopTimeout`/Anthropic stream errors; it is currently truncated to 500 bytes
and not persisted. Per-spawn file + bounded tail gives both durable RCA and a
self-describing error event. stdout stays untouched (NDJSON cleanliness, domain).

**4-point test:** approaches Y; lasting Y; disagreement Y; future-constraint N →
ADR candidate N.

### D5: Always-on `claude --debug-file` forwarding — feasible bridge-side, NO fork

**Finding:** `claude-p`'s README states *"Unrecognized flags are forwarded
verbatim to `claude`."* The native `claude` CLI exposes
`--debug-file <path>` ("Write debug logs to a specific file path (implicitly
enables debug mode)"), confirmed via `claude --help` on the installed binary
(`/Users/.../.local/bin/claude`). Therefore the bridge can pass `--debug-file
<bridge-path>` in the claude-p argv and claude-p forwards it to the child
`claude` — **no claude-p fork change is required.**

**Choice:** Add an optional `debugFile?: string` spawn option. When set (default
on), `buildClaudePArgs` appends `--debug-file <path>`. `index.ts`/`capture.ts`
resolve a per-spawn path under the bridge debug dir and pass it unless
`CLAUDE_BRIDGE_CLAUDE_DEBUG_FILE === "0"` (escape hatch, mirroring
`CLAUDE_BRIDGE_DEBUG`). The path is asserted NOT under `~/.claude/` (constitution
III): claude's debug default is `~/.claude/debug/<session>.txt`; pointing it at a
bridge-owned path both captures it AND keeps it out of `~/.claude/`.

**Alternatives considered:**
- **`ANTHROPIC_LOG=debug` env on the child**: also viable (inherited env), but it
  logs to stderr/console rather than a discrete file and lacks a clean per-spawn
  path. We already capture stderr (D4); `--debug-file` adds the structured file
  with no parsing burden. Chosen `--debug-file`.
- **Require a claude-p fork to add a first-class debug passthrough**: unnecessary
  given verbatim forwarding. Rejected.

**Residual risk (R3):** `--debug-file` *implicitly enables debug mode*, which may
emit extra text into the child `claude` PTY. claude-p derives its stdout NDJSON
from the transcript JSONL via the Stop hook, not from scraping the TUI, so debug
chatter in the PTY scrollback should not corrupt the NDJSON. This is validated by
the integration suite (real claude-p turns); the env escape hatch is the
rollback if a regression appears. Because of this residual risk, the flag is
behind an always-on-but-disable-able gate rather than hard-wired.

**4-point test:** approaches Y; lasting Y; disagreement Y; future-constraint Y →
ADR candidate Y (recorded here).

### D6: In-flight state dump at the single terminal settle point

**Choice:** Emit one structured `warn`-level log (`event:
"claudeP.lifecycle.stateDump"`) carrying `{ lastDeltaEpochMs, lastDeltaAgeMs,
heldRound, partialBufferLen }` at the driver's terminal settle/abort site, so
abort and premature-exit paths each log exactly once (clarify I2/B). The driver
tracks `lastDeltaAt` on each forwarded event and exposes held-round + partial
length already known to the frame/parser.

**Rationale:** Self-diagnosing hangs without double-logging. Solution-free in the
spec; concrete fields here.

**4-point test:** approaches Y; lasting N; disagreement N; future-constraint N →
ADR candidate N.

## Risks / Trade-offs

| # | Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|---|
| R1 | A true indefinite hang (no exit, no abort) now blocks the turn forever | Low | Medium | This is the accepted principle; visibility (state dump + stderr tail + debug-file) makes it diagnosable; pi's abort is the recovery. The pre-existing watchdog only ever fired on *silence*, which a real hang with held tool already deferred forever anyway. |
| R2 | Removing the watchdog drops boot-wedge auto-retry | Low | Low | A boot wedge that produces a real exit still retries via D33; only a boot hang with NO exit is no longer auto-killed — rare, and now observable. |
| R3 | `--debug-file` enabling debug mode pollutes claude-p's PTY/NDJSON | Low | Medium | NDJSON derives from transcript, not TUI scrape; validated by the integration suite; `CLAUDE_BRIDGE_CLAUDE_DEBUG_FILE=0` disables instantly. |
| R4 | Per-spawn debug files accumulate on disk | Medium | Low | Files are small, named per sid/pid/ts under the debug dir; same unbounded-ish profile as existing stale-diag dumps. Follow-up (Open Q) may add rotation; out of scope here. |
| R5 | Stale tests reference removed symbols → red build | Medium | Low | Delete `unit-watchdog.mjs` + `unit-driver-killwedged.mjs`; update `unit-driver-claude-p.mjs` `--timeout` cases + `timeoutSeconds` baseCfgs; grep for removed symbols before commit. |

## Migration Plan

1. Code removal (D1–D3), then additions (D4–D6), keeping it compiling at each step.
2. Tests: delete the two unit files; update claude-p arg tests; add stderr-tail +
   `--debug-file` argv tests; keep abort + resilience tests green.
3. Validators: `typecheck`, `build`, `test:unit`; integration suite where the
   environment permits real `claude`/`claude-p`.
4. Docs: README/CHANGELOG note removal of `CLAUDE_BRIDGE_WATCHDOG_IDLE_MS` and
   `CLAUDE_BRIDGE_CLAUDE_P_TIMEOUT_SECONDS`; add `CLAUDE_BRIDGE_CLAUDE_DEBUG_FILE`.
5. **Rollback:** revert the commit; or set `CLAUDE_BRIDGE_CLAUDE_DEBUG_FILE=0` to
   disable only the debug-file forwarding if R3 manifests.

## Open Questions

- Debug-file/stderr-file retention: should per-spawn diagnostics be rotated/
  capped like `claude-bridge.log`? Deferred — out of scope; tracked as R4. Owner
  decides if disk growth becomes a problem.
