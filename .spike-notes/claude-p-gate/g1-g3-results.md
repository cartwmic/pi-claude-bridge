# G1 + G3 empirical results — REAL claude-p multi-round held blocking

**Date:** 2026-06-01 · **Versions:** `claude 2.1.159`, `claude-p 0.1.0`
(node_modules/.bin/claude-p), node 24.14.0, darwin 23.3.0 ·
**Change:** `replace-sdk-with-claude-p` · **Branch:** `replan-driver-from-phase-0`

Harness: `tests/int-claude-p-multiround.mjs` (run with `RUN_REAL_CLAUDE_P=1`).
It wires the REAL modules — `createRouter` (src/mcp/router.ts) + the BUILT shim
(`dist/src/mcp/shim.js`, `--mode main`) + `buildClaudePArgs` (src/driver/claudeP.ts)
+ `ClaudePStreamParser` (src/driver/stream.ts) — against the REAL claude-p binary,
WITHOUT pi. `onPark` immediately `router.deliver`s a synthetic step result.
ONE bridged tool `mcp__custom-tools__step({ n })` returns `step <n> done; next=<n+1>`
until n=3 (then "STOP"). Model `claude-haiku-4-5`, `--timeout 180`, fresh session.

Fixtures recorded:
- `.spike-notes/claude-p-gate/g1-multiround-stream.jsonl` — raw claude-p stdout (clean PASS).
- `.spike-notes/claude-p-gate/g1-mcp-call-log.txt` — per-call RECEIVED→RESOLVED hold log.

---

## G1 — Multi-round held blocking: **PASS**

In ONE claude-p spawn the router parked **3 distinct** `tools/call`s
(`n=1 → n=2 → n=3`, each a distinct minted piId), each held open on the shim
until `router.deliver`, and the driver `done` resolved with **`stopReason:"result"`**
(`exit=0`). The model read each `next=` and chained the next call, proving the
held-open mechanism keeps claude-p blocked inline across sequential rounds — not
just the single round the Phase-0 spike (Exp C) tested. Wall ~10–11s.

Evidence (call log, clean run):
```
RECEIVED piId=… n=1  RESOLVED -> "step 1 done; next=2"
RECEIVED piId=… n=2  RESOLVED -> "step 2 done; next=3"
RECEIVED piId=… n=3  RESOLVED -> "step 3 done; STOP … COMPLETED_3_STEPS"
ATTEMPT … END ok=true stopReason=result exit=0 parked=3
```

## G3 — Turn-end: `result` is **per-TURN, not per-segment**: **PASS** (parser rule holds)

The captured stdout for a 3-round turn contains **exactly ONE `result` line**, at
the very end — AFTER all three tool rounds and their `tool_result`s. There is NO
`result` between rounds. Verbatim structural sequence (27 lines):

```
mode → permission-mode → file-history-snapshot → user(str) → ai-title
assistant(thinking) → assistant(text)
assistant(tool_use WaitForMcpServers) → user(tool_result)
[round 1] assistant(text) → assistant(tool_use step) → user(tool_result)
[round 2] assistant(text) → assistant(tool_use step) → user(tool_result)
[round 3] assistant(text) → assistant(tool_use step) → user(tool_result)
assistant(text final)
system/stop_hook_summary → system/turn_duration
result   (subtype=success, usage{input,output,cache_read,cache_creation}, NO stop_reason)
```

Therefore the parser's turn-end rule — **done only on `result`; a `tool_use`
block / tool round does NOT terminate the turn** (src/driver/stream.ts
`handleResult` / `handleAssistant`) — MATCHES the observed schema. Fed the real
fixture through `ClaudePStreamParser`: it emits 3 tool-use events (one per round),
one terminal `done{reason:"result"}` (last event), one `usage` event, NO `error`,
and `WaitForMcpServers` + all noise lines (mode/permission-mode/file-history-snapshot/
attachment/ai-title/system subtypes) were filtered. No parser fix needed for G3.

A permanent regression guard for this was added to `tests/unit-driver-stream.mjs`
("G3: real multi-round fixture") which replays `g1-multiround-stream.jsonl` and
asserts exactly one `result` line + one terminal done.

---

## Behavioral findings (NOT bugs in src/**; documented for D32 / cut-over)

### F1 — `claude` DOUBLE-prefixes bridged MCP tool names on stdout
The bridge advertises tool names to the shim ALREADY namespaced
(`mcp__custom-tools__step`; index.ts builds `${MCP_TOOL_PREFIX}${t.name}` with
`MCP_TOOL_PREFIX = "mcp__custom-tools__"`). `claude` then re-namespaces EVERY MCP
tool on its stdout as `mcp__<serverName>__<advertisedName>`, yielding the
**double-prefixed** on-stdout name `mcp__custom-tools__mcp__custom-tools__step`.

This is consistent with Exp C, where the server `pi-spike-tools` registered the
tool UNPREFIXED (`pi_ping`) and stdout showed a single prefix
(`mcp__pi-spike-tools__pi_ping`). The double-prefix is therefore a deterministic
consequence of advertising an already-prefixed name.

Impact: **none for routing** (D32 — the round-trip is shim/router-owned by minted
piId; the stdout name is observational/UX only). The parser surfaces the event
correctly because `isBridgedToolName` only checks the `mcp__` prefix. BUT any
future code that tries to map a stdout `tool_use` name back to a pi tool by exact
name (e.g. UX correlation, G8) MUST account for the double prefix — strip
`mcp__<server>__` once to recover the bridge-advertised name, or twice to recover
the bare tool name. Worth a note in design.md's D32/G8 section. The integration
test matches on `mcp__`-prefix + `__step`-suffix rather than exact name.

### F2 — a speculative pre-WaitForMcpServers `tool_use` can appear (single-prefix)
On some runs the model emits an initial `tool_use` for the step tool BEFORE the
`WaitForMcpServers` boot completes — with the SINGLE-prefixed name
(`mcp__custom-tools__step`) and a STRING arg (`{"n":"1"}`). This block does NOT
reach the shim (the MCP server isn't connected yet); the model then runs
`WaitForMcpServers` and re-issues the real (double-prefixed, numeric-arg) calls.
Consequence: the stdout `tool_use` count can EXCEED the number of actual held
round-trips (router parked 3, stdout showed 4 `mcp__…step` blocks on one run).
Confirms D32's design choice — tool-use stdout events are observational and the
router/shim count is authoritative; a UX correlator must tolerate orphan stdout
tool-use blocks that never parked.

---

## Reliability (informs G4/G9)

claude-p mechanism itself was reliable: when the model called the tool, the
held-blocking + turn-end behavior worked every time (exit 0, clean `result`).

The observed flakiness was MODEL-BEHAVIOR, not a claude-p timeout: on several
single-attempt runs the turn completed cleanly (`stopReason=result`, `exit=0`) but
the model called the tool **zero times** (`parked=0`) — it either declined or
answered without using the tool. NO `SessionStartTimeout`/`StopTimeout` was seen
in this batch (the contention-driven hook-timeout failure mode documented in
`_NOTE.md` did not reproduce here at 1-way concurrency).

Tally (sequential, no concurrency):
- With `G1_MAX_ATTEMPTS=3` (default): PASS on first attempt both times tried.
- Single-attempt (`G1_MAX_ATTEMPTS=1`): ~4/8 runs hit `parked=0` (model skipped
  the tool); the rest passed. The up-to-3-attempt retry absorbs these misses.

Implication: the prompt-driven multi-round scenario is reliable WITH the retry
loop the spec mandated; the bridge's D33 resilience layer (respawn on premature
error) plus prompt engineering covers the model-skip case. The hook-timeout
failure mode (`_NOTE.md`) remains the separate G9 watch item under contention.

---

## Files touched (allowed-set only)
- `tests/int-claude-p-multiround.mjs` (NEW — the G1 harness)
- `tests/unit-driver-stream.mjs` (added the G3 fixture-replay turn-end test)
- `.spike-notes/claude-p-gate/g1-multiround-stream.jsonl` (fixture)
- `.spike-notes/claude-p-gate/g1-mcp-call-log.txt` (hold log)
- `.spike-notes/claude-p-gate/g1-g3-results.md` (this note)

NO `src/**` or `index.ts` edits. No bug found in the modules under test.
