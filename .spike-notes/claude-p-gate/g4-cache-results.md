> **[SUPERSEDED 2026-06-01]** This note concluded interactive claude-p forfeits caching. That was a TEST ARTIFACT (undersized ~1.26k-token system prompt below Anthropic's cache minimum). With a large stable prefix, single-shot interactive `--resume` DOES cache. See `g4-singleshot-caching.md` + design "G4 resolution". Retained for provenance.

# G4 — warm-resume cache-shape (HARD GATE; cost+latency; blocks cut-over)

**Date:** 2026-06-01T23:59:11.085Z · claude-p 0.1.0 · claude 2.1.159 · model claude-haiku-4-5
**Session:** e2e8b45f-5369-4400-8d39-f51876494bb9 (turn 1 fresh `--session-id`, turns 2-6 `--resume` same id)
**System prompt:** PINNED 5045 bytes, identical every turn, NO dynamic sections. mcpConfig constant. Isolation flags identical to production (`--strict-mcp-config`, `--setting-sources ""`, `--disallowedTools …`). Env passed through verbatim (CLAUDE_CONFIG_DIR / HOME NOT overridden).
**Concurrency:** 1 (strictly sequential, one claude-p alive at a time).

## VERDICT: FAIL (corrected — see CORRECTED ANALYSIS; the auto-generated `warmDeltaSized=true` below is a divide-by-zero artifact because the cold prefix was itself 0)

> NOTE on `warmDeltaSized=true`: the probe heuristic compares warm `cache_creation`
> against the cold-turn "prefix" = `cacheWrite+cacheRead`. On turn 1 that was **0**
> (no caching at all), so the heuristic divided by zero and fell back to an absolute
> threshold, mis-reporting `true`. The REAL finding is below.

## CORRECTED ANALYSIS — caching is OFF entirely (not "busted by injections")

The original G4 risk hypothesis was: per-spawn injections (attachment/ai-title/
file-history-snapshot/dynamic system sections) shift the cached PREFIX → cache MISS
→ `cache_creation` every warm turn. **That is NOT what happened.** The far worse,
clearer reality:

- **`cache_creation_input_tokens` = 0 AND `cache_read_input_tokens` = 0 on EVERY turn**
  (cold AND warm), confirmed in the raw claude-p `result.usage` (see stream JSONL).
- `input_tokens` GROWS monotonically 3802 → 7656 → 11556 → 15496 → 19472 → 23494,
  i.e. the FULL accumulated conversation is billed as fresh `input` every turn.
- This means **claude-p's interactive/PTY mode sets NO `cache_control` breakpoints** —
  prompt caching is entirely disabled, so there is nothing for `--resume` to warm-read.

### Control experiments (localize the cause)

| run | mode | flags | cache_creation | cache_read |
|-----|------|-------|----------------|------------|
| claude-p (this G4) | interactive PTY (D26) | full bridge isolation flags | **0** every turn | **0** every turn |
| raw `claude -p` (control 0) | `--print` | `--model` only | **50015** (cold) | 0 |
| raw `claude -p` (control A) | `--print` | SAME pinned `--system-prompt` + `--strict-mcp-config --setting-sources "" --disallowedTools …` | **26336** (cold) | 0 |

The SAME native `claude` binary (2.1.159) DOES engage prompt caching when invoked
as `claude -p` (`--print`), even with the bridge's exact isolation flags. It does
NOT engage caching when driven by claude-p's interactive PTY session. **The
differentiator is interactive vs `--print` mode — NOT the isolation flags, NOT the
per-spawn injections.** The bridge's "never nominal `claude -p`" decision (design
D26 / constitution IV) is precisely what forfeits Anthropic prompt caching.

### Cost/latency implication

Without `--print`, every turn re-sends the whole growing transcript as uncached
`input`. By turn 6 that is 23.5K uncached input tokens vs what would be ~1–2K of
new delta over a warm-read prefix. For long sessions this is an O(N²) token-cost
and latency blow-up — the NOT-ACCEPTABLE regression G4 exists to catch.

### Does this mandate the T4.10 fork?

**No — T4.10 (strip/pin the per-spawn injections) would NOT fix this**, because the
injections are not the cause. The cause is structural: interactive mode emits no
`cache_control`. Fixing it requires either (a) claude-p itself setting cache
breakpoints in its interactive prompt assembly (an upstream/fork change to claude-p,
not to this repo's `src/**`), or (b) the bridge abandoning the interactive-PTY
approach for `claude -p` — which design D26 / constitution IV explicitly forbid and
which earlier gates (workspace-trust, T0.14) found blocks interactive mode anyway.
This is a **design-level blocker for the cut-over**, escalate to the owner.

- warm turns (2-6) all have `cache_read` > 0: **false**
- warm AND cold `cache_creation` > 0 (any caching at all): **false** — caching is OFF
- `input_tokens` grows monotonically (full re-send each turn): **true**
- turn 2 recalled "4242" (coherence): **true** (`--resume` DID restore the conversation)
- warm turns producing usage: **5/5** (no flakes — clean, repeatable result)

## Per-turn usage

| turn | input | cache_creation (write) | cache_read | output | assistant (truncated) |
|------|-------|------------------------|------------|--------|------------------------|
| 1 (fresh) | 3802 | 0 | 0 | 204 | "Your favorite number is 4242." |
| 2 (resume) | 7656 | 0 | 0 | 332 | "Your favorite number is 4242.4242" |
| 3 (resume) | 11556 | 0 | 0 | 444 | "Your favorite number is 4242.42424243" |
| 4 (resume) | 15496 | 0 | 0 | 564 | "Your favorite number is 4242.42424243Eve" |
| 5 (resume) | 19472 | 0 | 0 | 708 | "Your favorite number is 4242.42424243Eve" |
| 6 (resume) | 23494 | 0 | 0 | 828 | "Your favorite number is 4242.42424243Eve" |

## Coherence

Turn 2 prompt: "What is my favorite number? Reply with just the number."
Turn 2 reply: "Your favorite number is 4242.4242"
Recalled 4242: **true** → `--resume` restored the conversation (not a blank session).

## Injection diagnosis (per-spawn line counts across all transcripts)

```json
{
  "attachment": 0,
  "aiTitle": 36,
  "fileHistorySnapshot": 21,
  "mode": 36,
  "permissionMode": 36
}
```
Interpretation: these are the suspect per-spawn interactive injections. If warm cache_read is high and creation is delta-sized DESPITE these lines appearing, then they do NOT enter the cached prompt prefix (they are local stdout markers, not API prompt content) and pinning `--system-prompt` + avoiding dynamic sections IS sufficient. If warm creation ≈ full prefix, identify which injection shifted the prefix.

## Flakiness

- turn 1 (fresh): attempts=[{"attempt":1,"exit":0,"sawResult":true,"hasUsage":true,"argRejected":false,"argError":false}]
- turn 2 (resume): attempts=[{"attempt":1,"exit":0,"sawResult":true,"hasUsage":true,"argRejected":false,"argError":false}]
- turn 3 (resume): attempts=[{"attempt":1,"exit":0,"sawResult":true,"hasUsage":true,"argRejected":false,"argError":false}]
- turn 4 (resume): attempts=[{"attempt":1,"exit":0,"sawResult":true,"hasUsage":true,"argRejected":false,"argError":false}]
- turn 5 (resume): attempts=[{"attempt":1,"exit":0,"sawResult":true,"hasUsage":true,"argRejected":false,"argError":false}]
- turn 6 (resume): attempts=[{"attempt":1,"exit":0,"sawResult":true,"hasUsage":true,"argRejected":false,"argError":false}]

## Raw run log
```
===== G4 warm-resume cache-shape — sessionId=e2e8b45f-5369-4400-8d39-f51876494bb9 =====
system-prompt bytes=5045 model=claude-haiku-4-5
----- TURN 1 (fresh) ATTEMPT 1 2026-06-01T23:58:54.923Z -----
[t1] EXIT code=0 signal=null sawResult=true argRejected=false usage in=3802 cw=0 cr=0 out=204
----- TURN 2 (resume) ATTEMPT 1 2026-06-01T23:58:58.047Z -----
[t2] EXIT code=0 signal=null sawResult=true argRejected=false usage in=7656 cw=0 cr=0 out=332
----- TURN 3 (resume) ATTEMPT 1 2026-06-01T23:59:00.622Z -----
[t3] EXIT code=0 signal=null sawResult=true argRejected=false usage in=11556 cw=0 cr=0 out=444
----- TURN 4 (resume) ATTEMPT 1 2026-06-01T23:59:03.236Z -----
[t4] EXIT code=0 signal=null sawResult=true argRejected=false usage in=15496 cw=0 cr=0 out=564
----- TURN 5 (resume) ATTEMPT 1 2026-06-01T23:59:05.786Z -----
[t5] EXIT code=0 signal=null sawResult=true argRejected=false usage in=19472 cw=0 cr=0 out=708
----- TURN 6 (resume) ATTEMPT 1 2026-06-01T23:59:08.551Z -----
[t6] EXIT code=0 signal=null sawResult=true argRejected=false usage in=23494 cw=0 cr=0 out=828
```