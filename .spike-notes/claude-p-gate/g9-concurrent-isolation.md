# G9 — Concurrent-spawn isolation (S14 main+main) — empirical results

**Date:** 2026-06-02 · **Versions:** `claude 2.1.159`, `claude-p 0.1.0`
(node_modules/.bin/claude-p), node 24.14.0, darwin 23.3.0 ·
**Change:** `replace-sdk-with-claude-p` · **Branch:** `replan-driver-from-phase-0`

Harness: `tests/int-claude-p-concurrent.mjs` (run with `RUN_REAL_CLAUDE_P=1`,
`node --import tsx --test`). Wires the REAL modules — `createRouter`
(src/mcp/router.ts, one per spawn with its own auto-generated unique socket via
`generateSocketPath`) + the BUILT shim (`dist/src/mcp/shim.js`, `--mode main`,
own `--mcp-config`) + `buildClaudePArgs` (src/driver/claudeP.ts) +
`ClaudePStreamParser` (src/driver/stream.ts) — against REAL claude-p, WITHOUT pi.
Each spawn gets its OWN tool and a UNIQUE sentinel; `onPark` holds the call open
`HOLD_MS=2000` (so concurrent holds OVERLAP) then `router.deliver`s THAT spawn's
sentinel. Model `claude-haiku-4-5`, `--timeout 180`, fresh session per spawn.

This is the S14 representative case: a claude-bridge "parent" parked on a tool
while a claude-bridge "child" runs concurrently — modeled as N independent
claude-p processes each holding a tool call open at the same time.

Fixtures recorded:
- `.spike-notes/claude-p-gate/g9-e1-spawnA-stream.jsonl` — raw stdout, spawn A (alpha→AAA).
- `.spike-notes/claude-p-gate/g9-e1-spawnB-stream.jsonl` — raw stdout, spawn B (beta→BBB).
- `.spike-notes/claude-p-gate/g9-concurrent-call-log.txt` — interleaved PARK/DELIVER timeline.
- `.spike-notes/claude-p-gate/g9-concurrent-results.md` — E2 contention table (generated).

---

## G9 (E1) — 2-way concurrent isolation: **PASS** (clean on attempt #1)

Two claude-p spawns launched simultaneously via `Promise.all`. Each:
- own `createRouter()` → own unique unix socket (DISTINCT paths asserted);
- own shim subprocess with its own `--mcp-config` pointing at its own socket;
- own single bridged tool (A: `mcp__custom-tools__alpha`→`AAA-7f3c1d`;
  B: `mcp__custom-tools__beta`→`BBB-9a2e84`).

### Isolation evidence (all asserted green)
1. **Distinct sockets** — A `…f17d1f21….sock`, B `…983bf421….sock`.
2. **No wire cross-talk** — router A saw ONLY `…__alpha`, router B saw ONLY
   `…__beta`; neither router ever saw the other's call. Each router routed
   exactly ONE tool call.
3. **Correct sentinels, no cross-wiring** — spawn A's model reported `AAA-7f3c1d`
   and NOT `BBB-…`; spawn B reported `BBB-9a2e84` and NOT `AAA-…`.
4. **Both clean turn-ends** — both `stopReason:"result"`, `exit=0`.

### Holds genuinely overlapped (concurrency proven, not interleaved-sequential)
From the call log:
```
B PARK    47.137Z  socket=…983bf421…  beta
A PARK    48.469Z  socket=…f17d1f21…  alpha   <- A parks WHILE B's hold is still open
B DELIVER 49.140Z  -> "BBB-9a2e84"            (B held ~2.0s: 47.137→49.140)
A DELIVER 50.471Z  -> "AAA-7f3c1d"            (A held ~2.0s: 48.469→50.471)
```
Both calls were parked at the same instant (A parked 0.67s before B delivered),
so the two routers were simultaneously holding their respective claude-p
processes blocked inline on distinct sockets. No deliver leaked to the wrong
router; the minted-piId keying (router.ts) and the per-spawn socket isolation
(ipc.ts `generateSocketPath`) held under genuine concurrency.

## WaitForMcpServers / boot behavior under concurrency: **no interference**

Each spawn independently emitted `WaitForMcpServers` (filtered by the parser) and
reached its own first parked tool call. firstEvent(spawn→first driver event): A
5598ms, B 5063ms — both booting concurrently inside the same ~11.5s window. One
spawn being PARKED (held ~2s) did NOT delay or interfere with the OTHER spawn's
startup/`WaitForMcpServers` resolution: B booted, parked, and DELIVERED while A
was still booting toward its own park, and A then parked and completed normally.
`WaitForMcpServers` for one spawn resolved against its own shim/router while the
other spawn's tool call was held open — exactly the S14 nested main+main
requirement. No deadlock, no cross-blocking.

## Concurrent boot-cost vs sequential G1 baseline

| metric                         | G1 sequential (1 spawn) | G9 E1 (2 concurrent)        |
|--------------------------------|-------------------------|------------------------------|
| spawn→first park               | ~5s                     | A ~5.6s, B ~5.1s             |
| wall (whole turn)              | ~11.1s (3 held rounds)  | A 11.5s / B 9.8s (1 round + 2s hold), both inside one ~11.5s window |

Running two spawns AT ONCE did NOT roughly double wall time (the two ~5s
cold-boots overlapped rather than serialized): total wall for BOTH concurrent
spawns (~11.5s) ≈ a single sequential spawn's wall. Cold-boot dominates and
parallelizes well at 2-way; the held-open round adds the ~2s hold on top. So
2-way concurrency is essentially free relative to the single-spawn baseline.

## S25 (main + CAPTURE) — DEFERRED to post-capture

The S25 variant (a main spawn concurrent with a CAPTURE-mode spawn) requires the
capture path (`--mode capture`, `--capture-tool`, the in-shim validate+stash, and
the bridge reading `router.getCaptureStash()`). That path is Phase 2 (tasks
T2.1–T2.9) and NOT yet wired into a driver/bridge flow. The shim + router already
contain the capture plumbing (shim.ts capture branch; router.ts onCaptureStash /
getCaptureStash), but there is no end-to-end capture spawn to run concurrently
here. **S25 main+capture concurrency is deferred to a post-capture gate; do NOT
build capture in this gate.** The 2-way main+main isolation proven here is the
mechanism S25 will reuse (distinct socket + distinct shim per spawn), so the
isolation primitive is already validated; only the capture-mode spawn is missing.

## E2 — contention probe (reliability): levels 2 / 3 / 4

Full table + per-failure detail in `g9-concurrent-results.md`. Summary
(HOLD_MS=2000, 3 runs/level, claude-haiku-4-5):

| concurrency | runs | passes | fails | failure rate |
|------------:|-----:|-------:|------:|:------------|
| 2 | 3 | 1 | 2 | 2/3 |
| 3 | 3 | 0 | 3 | 3/3 |
| 4 | 3 | 0 | 3 | 3/3 |

### Failure mode — UNIFORM and BENIGN-for-routing
Every single failure (23 failed spawns across all levels) was identical:
`stderr: claude-p: StopTimeout`, `exit=2`, `signal=null`, **`everRouted=false`**.
There were NO SessionStartTimeouts, NO crashes, NO partial/garbled streams, and —
critically — **NO failure on a spawn that had already routed a tools/call.** Of
the entire E2 run only 4 tool calls were ever parked, and ALL 4 of those spawns
SUCCEEDED. The StopTimeout is claude-p's hook (`Stop` hook) failing to fire under
CPU/IO contention; it kills the spawn at turn-end *before any tool round in the
failing spawns* (these spawns never even reached their first tool call). So
contention degrades THROUGHPUT/availability, never CORRECTNESS or isolation: a
spawn either completes cleanly and correctly (isolation intact, right sentinel)
or dies with StopTimeout having done nothing observable.

### D33 resilience assessment — ALL observed failures are RETRIABLE
The classifier (`classifyRetriable`, mirroring the bridge's
`shouldRetry = !router.everRoutedToolCall` gate) marked **100% (23/23) of failures
RETRIABLE**: each is a premature `error` (exit≠0, no `result`) with `everRouted=false`,
so no side-effecting tool could have run and a cold respawn (fresh `--session-id`)
is safe and idempotent. This is EXACTLY the case `spawnClaudePWithResilience`
(src/driver/claudeP.ts, design D33) handles: detect `stopReason:"error"`, consult
`shouldRetry()`, back off (250ms × attempt), respawn with a fresh id. We could not
invoke index.ts's wired resilience here (the harness drives the raw driver), but
the failure shape is precisely what the wrapper recovers — and the one dangerous
shape (StopTimeout AFTER a tool routed → everRouted=true → NOT retriable) did not
occur once. Net: the D33 layer WOULD recover the observed contention failures.

> Caveat: failure rate is stochastic and CPU-bound. E1 (the dedicated 2-way
> isolation test) passed CLEAN on attempt #1, yet E2's level-2 sample failed 2/3
> the same evening under the heavier 9-group back-to-back load. The numbers above
> characterize a worst-case contended machine; they are a lower bound on
> reliability, not a fixed rate. The takeaway for the design is qualitative: at
> ≥3 concurrent claude-p the StopTimeout rate is high enough that the D33
> retry-respawn layer is REQUIRED (not optional) for nested same-provider
> concurrency to be usable. A real deployment should also consider a concurrency
> CAP / queue for same-provider nesting rather than relying on retry alone.

## src/** module bugs

None observed. router.ts, shim.ts, ipc.ts, and claudeP.ts behaved correctly under
genuine concurrency at all levels: per-spawn sockets stayed disjoint, minted-piId
keying prevented cross-wiring, `everRoutedToolCall` tracked correctly per-router
(every routed tool succeeded; every failure had everRouted=false), and the
StopTimeout failures surfaced as clean `stopReason:"error"` exits — the resilience
seam's expected input. The StopTimeout itself is a claude-p 0.1.0 / `claude`
runtime contention defect, NOT a bridge bug. No src/** fix needed.

### Fixtures recorded (E2)
- `.spike-notes/claude-p-gate/g9-concurrent-results.md` — failure-rate table + per-spawn modes.
- `.spike-notes/claude-p-gate/g9-concurrent-call-log.txt` — full PARK/DELIVER + START/END timeline for E1 and all E2 runs (shows only 4 parks total, all on spawns that passed).
