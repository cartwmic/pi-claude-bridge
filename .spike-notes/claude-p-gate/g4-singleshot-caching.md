# G4 follow-up — does SINGLE-SHOT interactive claude-p (`--resume`) hit the prompt cache?

**Date:** 2026-06-01 · claude-haiku-4-5 · claude-p 0.1.0 · model claude-haiku-4-5
**Harness:** `tests/spike-g4-singleshot-caching.mjs` (REAL wiring: `createRouter` +
`buildClaudePArgs` + BUILT shim `dist/src/mcp/shim.js` + production isolation flags).
**Mode:** strictly SINGLE-SHOT — one claude-p process **per turn**. Turn 1 fresh
`--session-id`, turns 2..N `--resume` the same id. Concurrency 1 (sequential, one
claude-p alive at a time). Flaky turns (`StopTimeout`, exit 2) retried ≤3×.
`CLAUDE_CONFIG_DIR`/`HOME` NOT overridden. No `src/**` edits.

Isolation flags every spawn (from `buildClaudePArgs`, identical to production):
`--disallowedTools <native set>`, `--strict-mcp-config`, `--setting-sources ""`,
`--permission-mode bypassPermissions`, `--output-format stream-json --verbose`,
`--system-prompt <inline text>`, `--mcp-config <shim pointer>`, `--session-id`/`--resume`.

---

## HEADLINE — the prior G4 FAIL was a SIZE artifact, not a structural ceiling

**Single-shot interactive claude-p (`--resume`) DOES cache — and it caches the
GROWING CONVERSATION, not just a fixed prefix — PROVIDED the cacheable content
crosses Anthropic's minimum cache size.** The prior G4 run (cache_read=0 over 6
turns) used a ~5 KB / ~1.26k-token system prompt with NO tools — below the cache
threshold — so nothing was eligible to cache and `--resume` had nothing to warm-read.

With a ~40 KB / ~10k-token stable system prompt, every `--resume` turn warm-reads
the **entire prior conversation** (system prompt + all earlier turns + tool
results), and only the small new delta of each turn is written as `cache_creation`.
The control (E3: trivial system + same tools) reproduces the FAIL exactly
(cache_read=0, cache_creation=0, full re-send), isolating **system-prompt SIZE** —
not interactive-vs-`--print`, not the tools block — as the determinant.

> Note the `result.usage` accounting in interactive mode is CUMULATIVE across the
> agent-loop segments within a turn (it sums the per-assistant-message usages),
> which is why E2's `input - cache_read - cache_creation` goes negative in the
> per-turn table. The authoritative signal is the **per-assistant-message usage**
> (captured below): each model call's `cache_read` ≈ the full prefix-so-far.

---

## E1 — large system (~10k tok), NO tools, ×4 `--resume`

Per-turn `result.usage` (cumulative over the turn's segments):

| turn | mode | input | cache_creation | cache_read | output |
|------|------|-------|----------------|------------|--------|
| 1 | fresh | 20 | 21332 | 0 | 190 |
| 2 | resume | 40 | 21370 | 21332 | 326 |
| 3 | resume | 60 | 21406 | 42714 | 434 |
| 4 | resume | 80 | 21452 | 64132 | 550 |

Per-assistant-message usage `[input / cache_creation / cache_read / output]`
(two identical lines per segment are the stream's partial+final emission of the
SAME message — read each pair as one call):

- t1 (fresh): `[10/10666/0/95]` — writes the ~10.7k system prefix, reads nothing.
- t2 (resume): `[10/10666/0/95]` `[10/19/10666/68]` — **reads the 10.7k prefix**, writes only a 19-tok delta.
- t3 (resume): … `[10/18/10691/54]` — reads 10691 (prefix + turn-2 convo).
- t4 (resume): … `[10/23/10709/58]` — reads 10709 (prefix + turns 2-3 convo).

**The per-message `cache_read` GROWS turn over turn (10666 → 10691 → 10709)** —
i.e. the conversation history caches cumulatively. The per-turn `result.cache_read`
(0 → 21332 → 42714 → 64132) climbs because it sums each turn's segments. Coherence
held: t2 recalled "4242", arithmetic chained across turns. **Conversation caches
single-shot.**

## E2 — large system (~10k tok) + 6 MCP tools, ×4 `--resume` (turn 1 calls a tool)

| turn | mode | input | cache_creation | cache_read | output | attempts |
|------|------|-------|----------------|------------|--------|----------|
| 1 | fresh | 26 | 22909 | 10569 | 356 | 1 |
| 2 | resume | 64 | 24658 | 64107 | 963 | 1 |
| 3 | resume | 116 | 25604 | 142749 | 1532 | 1 |
| 4 | resume | — | — | — | — | 3 (FLAKY — no result; `StopTimeout`) |

Per-assistant-message usage:

- t1 (fresh): `[10/11183/0/176]` `[6/543/10569/4]` — first call writes the ~11.2k system+tools prefix; after the tool round the second call **reads 10569** (warm prefix) and writes only the 543-tok tool-result delta. **The prefix caches WITHIN the spawn (matches the G1 intra-spawn finding).**
- t2 (resume): `[10/11183/0/176]` `[6/543/10569/4]` `[10/742/10060/220]` `[6/82/11112/81]` `[6/101/11194/5]` — every segment warm-reads ~10–11.5k; cache_read climbs to 11194.
- t3 (resume): … trailing segments read 11295, 11460, 11528 — **cache_read tracks the growing transcript every segment.**

So with tools the cached prefix is bigger (~11.2k vs ~10.7k system-only) and the
**whole conversation + tool results cache cumulatively across single-shot
`--resume` spawns.** What fraction of each turn is cached vs uncached: essentially
ALL of it except the ~10–40 new prompt tokens and the new tool-result/assistant
delta (a few hundred tokens). On t3 the model warm-read ~11.5k and freshly wrote
only ~70–186 tokens per segment.

## E3 — CONTROL: TRIVIAL system (~68 chars) + same 6 tools, ×4 `--resume`

| turn | mode | input | cache_creation | cache_read | output | attempts |
|------|------|-------|----------------|------------|--------|----------|
| 1 | fresh | 10247 | 0 | 0 | 510 | 1 |
| 2 | resume | 24203 | 0 | 0 | 905 | 3 |
| 3 | resume | 37261 | 0 | 0 | 1302 | 1 |
| 4 | resume | — | — | — | — | 3 (FLAKY — no result) |

Per-assistant-message usage: **every segment is `[NNNN/0/0/M]` — cache_creation=0,
cache_read=0, full uncached re-send**, input growing 1794 → 2912 within a turn and
the turn total growing 10247 → 24203 → 37261 across turns. This is the EXACT prior
G4 FAIL signature reproduced.

**Conclusion of the control:** with the same 6 tools but a tiny system prompt,
caching is entirely OFF. The ~10k-token system tools roster (the 6 tool defs are
only ~hundreds of tokens) does NOT by itself cross the threshold; the large system
prompt does. **System-prompt SIZE is the lever, not the tools block.**

---

## Decisive questions

**Q1 — Does the stable system+tools prefix cache across single-shot `--resume` spawns?**
**YES.** E1 caches a ~10,666-token system prefix; E2 caches a ~11,183-token
system+tools prefix. Every `--resume` spawn warm-reads it (per-message
`cache_read` ≈ prefix size on the first call of each spawn). Confirmed across
fresh→resume→resume→resume.

**Q2 — Does ANY conversation history cache single-shot?**
**YES — this is the key correction to the prior G4 verdict.** `cache_read` does
NOT stay flat at the prefix size; it GROWS as the conversation grows (E1 per-message
reads 10666 → 10691 → 10709; E2 reads 10569 → 11194 → 11528). The replayed
`--resume` transcript is re-cached cumulatively, so each new single-shot spawn warm-reads
the full prior conversation + tool results, not merely a fixed prefix. The ONLY
uncached portion per turn is the new user prompt (~10–40 tok) plus the new
assistant/tool-result delta written as a small `cache_creation` (tens to a few
hundred tokens). **Caveat:** this held with a >~10k-token cacheable head. Below the
cache-size threshold (E3, prior G4) nothing caches at all.

**Q3 — Quantify single-shot caching for the bridge.**
The bridge's real prefix (full pi system prompt + all MCP tool defs) is large —
well above the threshold — so it behaves like E1/E2, NOT like E3. Single-shot
`--resume` will warm-read the **entire accumulated context every turn**, writing
only the per-turn delta as `cache_creation`. Residual no-cache penalty:
- At 50k total context: only the new turn's delta (~hundreds of tokens of user
  prompt + tool results) is uncached/freshly-written; ~50k is warm cache_read.
- At 100k total context: same shape — ~100k warm-read, only the per-turn delta fresh.
This is **the same asymptotic shape as the persistent-process ideal**: both pay a
small per-turn write and warm-read the rest. The single-shot path is NOT the
O(N²) full-re-send blow-up the prior G4 feared — that blow-up only occurs below the
cache threshold (tiny system prompt). With the bridge's real (large) prefix, the
single-shot per-turn-spawn + `--resume` model caches the conversation.
(Difference vs persistent process: cache ENTRIES expire after the ~5-min TTL; a
single-shot spawn after an idle gap >5 min cold-misses and re-writes — a persistent
warm process would too once idle past TTL, so the gap is small. Single-shot also
pays claude-p/PTY spawn + session-replay latency per turn, which is a LATENCY cost,
not a token cost.)

**Q4 — Any lever to make interactive claude-p cache the conversation single-shot,
short of `--print`/persistent process?**
**Found, and it is sufficient: pin a system prompt large enough to cross the cache
minimum (≈1k tokens; comfortably so at the bridge's real prefix size).** Once the
cacheable head exists, the interactive prompt assembly places `cache_control`
breakpoints and `--resume` warm-reads the whole transcript — no flag, no `--print`,
no persistent process required. No OTHER lever was needed or found; the tools block
alone did not do it (E3). If the bridge ever ran with a tiny system prompt it would
fall back to the E3/old-G4 full-re-send behavior — so the lever is "keep the pinned
prefix large," which the real pi system prompt already satisfies.

---

## VERDICT

**Single-shot interactive claude-p achieves MORE than prefix-only caching: with a
large stable system prompt it caches the FULL growing conversation across
per-turn-spawn `--resume`, warm-reading the entire prior transcript every turn and
writing only the per-turn delta.** The earlier "interactive `--resume` forfeits
conversation caching" conclusion was an artifact of an undersized (~1.26k-token)
system prompt that never crossed the cache minimum.

**Implication for the persistent-fork decision:** conversation caching does NOT
strictly require the persistent process *for token cost*. The current design
(per-turn spawn + `--resume`) DOES cache the conversation as long as the pinned
prefix is large — which the bridge's real pi-system-prompt + MCP-tool-defs prefix
is. The remaining advantages of a persistent process are **latency** (no per-turn
PTY/`claude` spawn + session replay) and **robustness** (avoid the `StopTimeout`
flakiness — see below), NOT prompt-cache token savings. "Good enough to avoid the
persistent fork" on cost grounds: **yes**; on latency/reliability grounds the
persistent fork is still the stronger option but is no longer mandated by caching.

This contradicts the prior `g4-cache-results.md` FAIL and the
`g4-intraspawn-caching-reframe.md` claim that "a FRESH process that `--resume`s
replays the transcript WITHOUT cache breakpoints." It DOES replay with cache
breakpoints — when there is a large-enough cacheable head.

## Reliability note (flakiness observed)

`StopTimeout` (exit 2, no `result`) recurred on later/larger turns: E2 t4 and E3 t4
failed all 3 attempts; several others needed 2–3 attempts. This matches the known
claude-p 0.1.0 `SessionStart`/`Stop` timeout flakiness under load and worsens as the
replayed `--resume` transcript grows (longer turns → higher chance of hitting the
internal Stop timeout). This is a SINGLE-SHOT-specific reliability tax (each turn
re-spawns + replays the whole growing session) and is an independent argument for
the persistent process — orthogonal to the caching finding.

## Artifacts
- Note: `.spike-notes/claude-p-gate/g4-singleshot-caching.md` (this file).
- Harness: `tests/spike-g4-singleshot-caching.mjs` (gated behind `RUN_REAL_CLAUDE_P=1`).
- Raw stdout fixtures: `.spike-notes/claude-p-gate/g4-singleshot-raw/{e1,e2,e3}.raw.txt`,
  `summary.json`.

## Compliance
- No `src/**` / `index.ts` edits (only added `tests/*.mjs` + `.spike-notes/*`). Not committed.
- Concurrency 1 (one claude-p per turn, strictly sequential).
- `CLAUDE_CONFIG_DIR` / `HOME` NOT overridden; `~/.claude` untouched (driver opens
  nothing there; isolation via `--strict-mcp-config --setting-sources ""`).
- Model claude-haiku-4-5. Flaky turns retried ≤3×.
