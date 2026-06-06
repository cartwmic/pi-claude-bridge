# Spike — source-level resume-staleness gate in the claude-p fork

**Date:** 2026-06-06 · **Fork branch:** `spike/resume-staleness-gate` (claude-p) · **zig 0.15.2** · **claude 2.1.159 / haiku**

## Goal
Replace the bridge-side "let claude-p emit a possibly-stale `--resume` result, then detect `staleSuspected` downstream and discard + cold-retry" band-aid with a **source-level gate in the fork** that never emits a stale result in the first place — the same philosophy as the `275dde9` MCP-readiness gate.

## Root cause (confirmed by reading the fork)
- claude-p's turn completion = claude's real **Stop hook** (FIFO event, `driver.zig:645`), not a screen scrape.
- The result is built by `transcript.parse`, which returns **the LAST assistant message in the transcript** (`transcript.zig:105-111`, `driver.zig:734`).
- On `--resume` the transcript already ends with the **prior turn's** answer, so until the live turn is written, "last assistant message" *is the prior answer*. If a Stop is processed / the transcript is parsed before the live turn lands, claude-p emits the **prior** answer for the new prompt. (The `.stop` handler also didn't gate on `state == .awaiting_stop`.)

## The fix (fork: `src/driver.zig` + `src/transcript.zig`, +105/-22)
Two deterministic gates, reusing `transcript.parse`'s existing `num_turns` (assistant-message count):
1. **State gate:** a `.stop` is treated as our turn's completion only when `state == .awaiting_stop` (i.e. the live prompt was actually submitted). A Stop before submit is a replayed/prior signal → ignored.
2. **Transcript-growth gate (core):** at echo-confirm (just before submit) snapshot `baseline_turns = turnCountFile(transcript)`. After Stop, the post-Stop parse loop accepts a result via ONE rule — `num_turns > baseline_turns AND (final_text present OR is_error)` (the live turn appended a new assistant turn, with text). If the live turn does not materialize in the transcript within the window → **`StopTimeout` (error → the bridge cold-retries)**.

**No Stop-payload fallback (owner principle: error for visibility, not conditional complexity).** An earlier draft of this spike had a `saw_growth`/`baseline==0` branch that fell back to the Stop hook payload's `last_assistant_message` on a slow/absent transcript write. That was dropped: a single accept-or-error rule is simpler and surfaces a slow/absent write as an error (a cold-retry) instead of papering over it with a guessed answer. **Honest note:** this also removes the *pre-existing* payload fallback (which had covered slow transcript-text flushes for every turn, including fresh/cold-start), so a turn whose transcript text lags beyond the ~2s window now errors → cold-retry rather than using the payload. The window makes this rare; the trade is deliberate (visibility over a hidden fallback).

This makes a stale emit **structurally impossible** regardless of timing — the result is only released when the transcript proves the live turn ran. Not a heuristic, not probabilistic.

## Evidence
- **Deterministic unit test** (`transcript.zig`, `zig build test` → green): a prior-only transcript has `final_text="Paris"` (the stale HAZARD) and `num_turns=1` (baseline); after the live turn lands, `final_text="4"` and `num_turns=2` — `num_turns > baseline` is the guard's invariant.
- **`zig build`** clean; **`zig build test`** all green (existing + new tests).
- **Live e2e** (`resume-staleness-gate-e2e.mjs`, against the built fork binary, **under 6× CPU load**): a fresh turn + **4 `--resume` turns**, each with a unique token. Result: **every resume turn returned its OWN live token; 0 stale emits; all exit 0.** The gate does not break healthy resumes (no regression).

## Limitation (honest)
This run did not *trigger* the flaky stale race in the unguarded binary (it's load/timing dependent and didn't fire in this session) — so the e2e proves correctness + non-regression, not "reproduced-then-fixed." But the gate's guarantee does not depend on reproducing the race: it is a structural invariant (no result until the transcript shows the live turn), and the unit test pins the exact condition.

## What this dissolves (bridge-side)
- The bridge's **stale-result detection + cold-retry** (`staleSuspected` acted on by D5) — no longer needed; the bridge can trust claude-p's result.
- **"Thread B"** (broader in-process stale-result enforcement) — the fork gate covers EVERY `--resume` turn at the source, not just the first-post-restart one.
- The **C5 sequencing question** — there's no separate enforcement change to sequence against.

(The bridge keeps `suppressResumeReplay` for STREAM-replay dedup — claude-p still streams the replayed prior-turn lines, a separate concern. A fuller fork change could also skip streaming pre-baseline lines and let the bridge drop that too — noted as a follow-on.)

## Next step
Land the fork branch on claude-p `main`, bump the bridge's claude-p pin, then the bridge's warm-resume change drops the stale-guard + Thread-B dependency (artifacts updated accordingly).
