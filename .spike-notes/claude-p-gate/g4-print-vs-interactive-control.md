> **[SUPERSEDED 2026-06-01]** This note concluded interactive claude-p forfeits caching. That was a TEST ARTIFACT (undersized ~1.26k-token system prompt below Anthropic's cache minimum). With a large stable prefix, single-shot interactive `--resume` DOES cache. See `g4-singleshot-caching.md` + design "G4 resolution". Retained for provenance.

# G4 control — `--print --resume` warm-reads across spawns; interactive claude-p does NOT

**Date:** 2026-06-01 · claude 2.1.159, model claude-haiku-4-5. Decisive apples-to-apples
control run by the main agent to confirm the G4 FAIL is interactive-PTY-specific.

Two sequential `claude -p --print` spawns sharing one `--session-id`/`--resume`, same
large pinned `--system-prompt` (~12.8 KB):

| spawn | mode | input | cache_creation | cache_read |
|-------|------|-------|----------------|------------|
| 1 (fresh `--session-id`) | `--print` | 17 | 50306 | 40465 |
| 2 (`--resume` same id)   | `--print` | 17/7 | 614 / 283 | **90771 / 45385** |

Spawn 2 warm-reads ~90k cached tokens across the process boundary, creating only a
~600-token delta. The SAME binary under claude-p's **interactive PTY** `--resume`
(G4 main run) returned `cache_read=0` / `cache_creation=0` on all 6 turns with input
growing 3802→23494.

## Conclusion
The cache regression is **interactive-vs-`--print` mode**, not the isolation flags, not
per-spawn injections, not TTL. Interactive `claude --resume` (fresh process) replays the
resumed transcript WITHOUT `cache_control` breakpoints; `--print --resume` sets them.
`cache_control` is chosen by `claude` when it builds the API request — **claude-p has no
influence over it**, so the T4.10 claude-p fork CANNOT fix this. Prompt caching is
forfeited entirely under the D26 interactive-claude-p approach. This is a structural,
Phase-3-cut-over-blocking conflict with the owner constraint "interactive only, never
nominal `claude -p`". Escalated to owner (see design.md G4).