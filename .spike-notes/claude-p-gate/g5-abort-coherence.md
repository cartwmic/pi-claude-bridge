# HARD GATE G5 — abort coherence (S7/S8/S13) + T1.13/T1.14 — 2026-06-02

Driver `CLAUDE_BRIDGE_DRIVER=claude-p`, claude-p 0.1.0, model
`claude-bridge/claude-haiku-4-5`, pi 0.75.5, bridge `0650d49`. Concurrency 1.
`CLAUDE_CONFIG_DIR`/`HOME` NOT overridden. Nothing committed. `src/**`/`index.ts`
untouched (diagnosis only).

## Verdicts

| Gate | Verdict |
|---|---|
| **T1.13** abort mid-turn mechanics | **PASS** (stable) |
| **G5(a)/S7** interrupted-text-partial recall | **MECHANICS PASS; partial-recall ESCALATED (design gap)** |
| **G5(b)/S8** held-tool abort coherence | **FLAKY: ~2/3 runs PASS, fails outright otherwise** (4 PASS / 2 FAIL over 6 runs; ~1/3 fabricates completion) |
| **T1.14** late tool-result after abort | **PASS** (Case-1 capture exercised; stable) |
| **S13** enumeration/rapid-retype | folded into the S7 finding (same buffered-text + re-echo root cause) — see below |

## The two empirical root causes (load-bearing diagnosis)

### 1. claude-p buffers the whole turn text (no incremental token stream)

`claude -p --output-format stream-json` emits the ENTIRE assistant turn text in
~one buffered burst. Probes:
- "count to 5000", abort 0 ms after first `text_delta` → committed partial =
  `highest=5000` (full).
- "count to 5000", abort at fixed wall-clock BEFORE first delta → `highest=0`
  (empty).
- Only **3** `text_delta` lines for a 5000-number count.

⇒ You cannot capture "reached 42 of 500". The SDK era streamed token-by-token so
`query.interrupt()` truncated a genuine partial; claude-p print mode cannot. S7's
literal claim is therefore **not exercisable** on this driver.

### 2. Warm-resume re-echo (`src/driver/stream.ts`)

On `--resume`, claude-p replays prior `assistant` lines. `handleAssistant()`
(src/driver/stream.ts ~L281-325) emits a `text-delta` for EVERY assistant-line
`text` block (~L291-295) and cannot tell a replayed-history line from the new
turn's line. So the bridge **prepends stale prior assistant text** to each warm
turn:
- `T1="READY"`, `T2="READYNoted: 137…"`, `T3="READY…Cats…"`, … (cumulative).

Under abort this is corrupting: an aborted warm turn commits the **stale prior
text** (e.g. `"READY."`) as its "partial" (so `commitAbortedPartial`'s `!hasText`
branch never fires — `hasText` is true on the stale echo, so no `[interrupted]`
marker is added). On the next turn the model sees garbled history, frequently
emits `"No response requested."` / declines, or (S8) **fabricates** that the
held tool completed.

## Why S8 is flaky (honest)

Held-tool abort is deterministic (sleep lives in pi). But the next-turn coherence
probe rides on warm-resume of the aborted session, so the re-echo (#2) makes the
model FABRICATE "SlowTool completed successfully after 10 seconds" on ~1/3–4
runs (sometimes self-correcting later in the same answer). The test's
`fabricated` regex now catches this and fails the attempt (no fake-pass); the
4-attempt retry usually lands a clean attempt. Underlying coherence is NOT
reliable.

## What IS solid (no regression)

- Abort mechanics: SIGINT to the claude-p process group, `done` resolves promptly
  ("aborted") WITHOUT a terminal `result` (7–12 ms), no orphan. `abortFrame` →
  `claudeHandle.abort()` → `signalGroup(pgid,"SIGINT")` works.
- `commitAbortedPartial` is correct and unit-proven (`tests/unit-abort-partial.mjs`).
- T1.14 Case-1 late-tool-result capture (index.ts ~L1033-L1099) works end-to-end:
  pi delivers the real result post-abort, bridge captures it for the aborted
  frame, closes the stream cleanly, next turn fresh-dispatches.
- `onAbort` keeps `cachedSessionId` (no context loss at the cache layer).

## ESCALATION (for the main agent — src fix, not a test fix)

Post-abort **interrupted-TEXT-partial recall** is a genuine capability regression
vs the SDK era. To restore it the driver layer must either:
- (a) stream text incrementally AND suppress replayed-history `assistant` lines on
  `--resume` in `src/driver/stream.ts` (distinguish "history replay" from "new
  turn"), OR
- (b) on the turn FOLLOWING an abort, force a **cold-replay** (drop the cached
  session id for that one turn) so `buildColdStartPrompt` re-embeds pi history
  cleanly instead of warm-resuming the semantically-degenerate SIGINT-killed
  session. This also fixes the S8 fabrication flakiness.

Option (b) is the smaller, surgical change and aligns with the existing
`detectHistoryDivergence` cold-start machinery. It trades one cache-creation per
post-abort turn (the documented "read OR creation (cold-replay)" G5 exemption)
for correct coherence.

## Cache-shape disposition

"read OR creation (cold-replay)" exemption — documented. Warm-resume of a
SIGINT-aborted session STAYS warm (cache_read>0 observed) but is semantically
degenerate; a correct post-abort turn would force cold-replay (cache-creation).
No unexplained cache-creation; bridge wrote nothing to `~/.claude/sessions/`
(the `*.json` files there are claude-p's own pid-named session files).

## Files

- `tests/int-claude-p-abort.{sh,mjs}` (T1.13)
- `tests/int-claude-p-abort-late-tool-result.{sh,mjs}` (T1.14)
- `tests/int-claude-p-abort-coherence.mjs` (G5 / S7 / S8)
- Full record: `SCENARIO_RESULTS.md` → "HARD GATE G5" section.
