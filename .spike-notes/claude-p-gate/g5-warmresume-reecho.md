# Warm-resume RE-ECHO bug (root cause of G5 abort-coherence failures) — 2026-06-02

## Finding
On a `--resume` turn, claude-p 0.1.0 drains the FULL replayed transcript to stdout, so
`src/driver/stream.ts` re-emits EVERY prior assistant text block as new `text-delta`.
Confirmed general (not abort-specific) from `g4-singleshot-raw/e1.raw.txt` (4 sequential
`--resume` turns, assistant text blocks in stdout order):

| turn | assistant text blocks emitted on that spawn's stdout |
|------|------------------------------------------------------|
| 1 (fresh)  | `ok` |
| 2 (resume) | `ok`, `4242`  ← re-echoes turn 1 |
| 3 (resume) | `ok`, `4242`, `4243`  ← re-echoes turns 1–2 |
| 4 (resume) | `ok`, `4242`, `4243`, `4241`  ← re-echoes turns 1–3 |

## Impact
- **Corrupts every warm-resume turn**: pi's assistant message for turn N = (all prior
  responses) + (new response). Breaks normal multi-turn coherence (S0/S6/S12), not just abort.
- **Root cause of the G5 (S7/S8) failures**: T1.14a `commitAbortedPartial` commits the
  streamed text, but post-`--resume` that "text" is the stale re-echo (e.g. `READY.`), so
  the next turn's recall probe sees garbage; S8's occasional "SlowTool completed"
  FABRICATION is the same re-echo feeding the model a false prior state.
- T1.10/T1.11 PASSED because they were single fresh turns (no `--resume`), so never hit it.

## Mechanics that DO pass (unaffected)
- T1.13 abort mid-turn: clean SIGINT, aborts in 7–12ms, no orphan. PASS.
- T1.14 late-tool-result capture (Case-1): exercised, no crash. PASS.

## Fix paths
1. **Bridge-side stream filtering** (`stream.ts`/wiring): emit only the LIVE turn, suppressing
   the replayed prefix. Deterministic approach: the bridge knows `priorUserPromptCount`
   (real user prompts already in the resumed history); gate emission until the
   (priorUserPromptCount+1)-th REAL user-prompt line (tool_result `user` lines within the
   live turn don't count), then emit. Less invasive, no fork to maintain; a heuristic that
   must correctly classify replayed-vs-live and prompt-vs-tool_result lines.
2. **claude-p fork**: drain only POST-resume transcript lines (track the transcript
   high-water mark at SessionStart). Clean fix at the source; the bridge stays simple.
   Aligns with the already-anticipated fork for the persistent-process optimization
   (g4-investigation.md) — one fork could carry both changes.

Either fix unblocks G5 (the abort-coherence probes should pass once the committed partial is
the real live-turn text, not a re-echo). G5 is therefore NOT cleared pending this fix.
