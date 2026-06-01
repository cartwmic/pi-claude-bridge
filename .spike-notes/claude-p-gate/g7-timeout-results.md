# G7 — `--timeout` semantics vs a held MCP call

**Date:** 2026-06-01T23:51:22.426Z · claude-p 0.1.0 · claude 2.1.159 · model claude-haiku-4-5
**Method:** ONE bridged tool `slow`; router `onPark` delays `deliver` by HOLD_MS=40000ms (simulated slow pi tool). Two sequential spawns.

## Results

| scenario | --timeout | hold | wall | exitCode | signal | sawResult | sentinel | exitDuringHold | attempts |
|---|---|---|---|---|---|---|---|---|---|
| SHORT (25s < 40s) | 25s | 40s | 25.5s | 2 | — | false | false | true | 2 |
| CONTROL-LONG (180s) | 180s | 40s | 46.7s | 0 | — | true | true | false | 1 |

## Verdict

**`--timeout` DOES count held-call wall-time.** The SHORT spawn exited at ~25.5s (timeout 25s) WHILE the tool was held (exitDuringHold=true, no result). A held pi tool longer than `--timeout` trips a timeout-kill mid-hold.

**IMPORTANT precision — the exit is NOT 124.** claude-p's `--timeout` governs its Stop-hook FIFO wait (see _NOTE.md "How claude-p detects turn lifecycle"). When the held tool outlasts `--timeout`, the Stop event never arrives in time and claude-p exits with **code 2 and stderr `claude-p: StopTimeout`** — NOT the shell-`timeout`-style exit 124 the gate hypothesized. To the bridge this is a premature exit with NO terminal `result` line, which `ClaudePStreamParser.endOfStream` classifies as a driver `error` and the resilience layer (D33) would treat as a retry candidate. CRITICAL: a `--timeout`-induced StopTimeout fires AFTER a `tools/call` has already been routed to pi (`router.everRoutedToolCall === true`), so the D33 idempotency gate FORBIDS a respawn — the turn would surface as a hard error to pi, not silently retry. This makes a too-small `--timeout` a turn-fatal failure mode, reinforcing the implication below.

Also observed (flakiness): SHORT attempt 1 hit a StopTimeout BEFORE the tool call even routed (no park) — a genuine boot flake, correctly retried; attempt 2 produced the clean mid-hold result. CONTROL completed on attempt 1.

## Implication for `deriveTimeout` (index.ts `CLAUDE_P_TIMEOUT_SECONDS` = 600s constant)

- `--timeout` is a HARD wall-clock budget that INCLUDES held-tool time (it bounds the Stop-hook FIFO wait, which only fires when the whole agent turn — held tools and all — finishes). The 600s constant is SUFFICIENT **only if** the entire pi turn (sum of ALL held tool rounds + model think-time in one spawn) stays under 600s wall. A SINGLE held round of S3 (45s) or S8 (120s) is well under 600s, so the constant survives those in isolation — BUT a turn with several slow held rounds, or any interactive/human-in-the-loop tool whose hold approaches 600s, would StopTimeout (exit 2) mid-turn. Because that fires after a tool call routed, D33 forbids respawn ⇒ turn-fatal error to pi.
- **deriveTimeout implication:** a generous CONSTANT is acceptable as a backstop but is NOT a correctness mechanism. The primary per-turn cancellation MUST be pi's AbortSignal (already wired into `spawnClaudeP`, design D31) — that lets pi cancel precisely and is decoupled from claude-p's wall-timer. The wall-timer (`--timeout`) must be set LARGE enough that it never fires during a legitimately-held tool; it is the last-resort backstop for a wedged claude-p, never the cancellation path for a slow-but-healthy pi tool. If pi tools can legitimately exceed 600s, `deriveTimeout` should be raised (or derived per-turn from the expected max tool duration) — a fixed 600s is a latent turn-fatal ceiling, not a safe upper bound.

## Raw run log
```
===== SHORT (timeout=25s, hold=40000ms) ATTEMPT 1 START 2026-06-01T23:49:44.763Z =====
[t=25s a1] EXIT code=2 signal=null wall=25464ms sawResult=false exitDuringHold=false deliverFired=false
[t=25s a1] STDERR claude-p: StopTimeout 
[SHORT a1] FLAKE (no tool call routed) — retrying
===== SHORT (timeout=25s, hold=40000ms) ATTEMPT 2 START 2026-06-01T23:50:10.231Z =====
[t=25s a2] PARK 2026-06-01T23:50:15.610Z piId=pi-88270fb9af4ead72 — holding 40000ms before deliver
[t=25s a2] EXIT code=2 signal=null wall=25486ms sawResult=false exitDuringHold=true deliverFired=false
[t=25s a2] STDERR claude-p: StopTimeout 
===== CONTROL-LONG (timeout=180s, hold=40000ms) ATTEMPT 1 START 2026-06-01T23:50:35.721Z =====
[t=180s a1] PARK 2026-06-01T23:50:40.606Z piId=pi-c9bea36aaab21caa — holding 40000ms before deliver
[t=180s a1] DELIVER 2026-06-01T23:51:20.608Z piId=pi-c9bea36aaab21caa after 40002ms
[t=180s a1] EXIT code=0 signal=null wall=46692ms sawResult=true exitDuringHold=false deliverFired=true
```
