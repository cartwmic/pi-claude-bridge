# Gate G-echo — patched-binary validation (before/after)

Date: 2026-06-03 · claude-p fork cartwmic/claude-p@415f4ba (echo-confirm patch) ·
claude 2.1.159 · zig 0.15.2 · darwin 23.3.0 · model claude-haiku-4-5.
Harness: `stoptimeout-proof.mjs --concurrency 10 --waves 6 --timeout 60 --load 16`
(16 CPU-saturation workers on 8 cores + 10 simultaneous boots/wave × 6 waves = 60 spawns).

## Result

| binary | spawns | StopTimeout wedges | PromptNotAccepted | failures | retypes exercised |
|---|---|---|---|---|---|
| **stock** claude-p 0.1.0 | 60 | **2** (w2-s1, w2-s7) | n/a | **2/60** | n/a |
| **patched** fork @415f4ba | 60 | **0** | **0** | **0/60** | **58/60** |

The SAME load that silently wedged 2/60 on the stock binary produced **0 failures**
on the patched binary. Critically, **58 of 60 spawns needed at least one retype**
(`attempt 2`/`attempt 3`) — i.e. the first typed prompt WAS dropped (the exact
stock failure condition), and the echo-confirm loop detected the missing echo and
retyped until it landed. Every drop recovered; none wedged.

Sample recovery (`RETYPE-RECOVERY-sample.log`):
```
typing prompt (51 bytes), attempt 1
typing prompt (51 bytes), attempt 2
typing prompt (51 bytes), attempt 3
prompt echo confirmed; Enter sent; waiting on claude API
```

## Interpretation

- The root cause (input-readiness race) still OCCURS under load (drops happened
  58/60) — the patch does not prevent the drop, it **recovers** from it before the
  turn can wedge. That is the correct fix shape: confirm-and-retype, fail fast only
  if unrecoverable (which did not occur here).
- Zero `PromptNotAccepted`: the 750ms × 3 budget was sufficient at this load. A
  heavier load could exhaust it → fast-fail + D33 respawn (seconds), never the 600s
  wedge.

**G-echo: PASS.**
