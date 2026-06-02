# G4 reframe — interactive caching WORKS intra-process; only cross-spawn --resume loses it

**Date:** 2026-06-01. Decisive analysis of the existing G1 multiround fixture
(`g1-multiround-stream.jsonl` — ONE claude-p spawn, agent loop, 3 held tool rounds).

Per-assistant-message usage WITHIN the single spawn:

| segment | input | cache_creation | cache_read |
|---------|-------|----------------|------------|
| round 1 | 10 | 0   | 14348 |
| round 2 | 7  | 636 | 13772 |
| round 3 | 6  | 79  | 14408 |
| …       | 6  | 94–97 | 14487–14584 |
| final text | 10 | 611 | 14457 |
| **result (turn total)** | 100 | 3034 | **186460** |

Every round WARM-READS ~14k cached tokens; cache_creation is a tiny per-round delta
(79–636). **Interactive claude (via claude-p) caches fully within a live process.**

## Reframe of the G4 FAIL
The G4 cross-turn failure (cache_read=0 over 6 `--resume` turns) is NOT "interactive
mode can't cache". It is specifically: a FRESH claude-p process that `--resume`s a
session replays the transcript WITHOUT cache breakpoints. A LIVE, long-lived process
caches normally (proven above — the agent loop's rounds are effectively sequential
turns within one process, and they cache).

## Consequence for the options
- **Option 2 (persistent process) premise is PROVEN.** Keep ONE claude-p/claude alive
  per pi session and feed turns into the live session → caching works (no `--resume`).
  This satisfies the interactive-only constraint D26 AND restores warm caching.
  Cost: needs a claude-p fork (upstream claude-p is single-turn, exits after Stop) to
  stay alive + accept subsequent prompts + frame per-turn results; persistent-process
  lifecycle complicates abort/supersede/concurrency. Feasibility = the open question.
- **Option 1 (`claude -p --print --resume`)** also caches (cross-spawn warm read ~90k)
  but uses the headless surface and reverses D26.
- The bridge's CURRENT design (per-turn spawn + `--resume`) is the worst of both — it
  is the specific pattern that loses the cache. Whatever path is chosen, the
  spawn-per-turn-with-resume model must change (persistent process) OR move to --print.
