# G4 cache blocker — investigate-before-deciding (Option 1 vs Option 2)

**Date:** 2026-06-01 · branch `replan-driver-from-phase-0` · claude 2.1.159 · claude-p 0.1.0 · model claude-haiku-4-5
**Scope:** read-only investigation. NO commits, NO edits to `src/**` or `index.ts`. All real claude-p runs at concurrency 1; `CLAUDE_CONFIG_DIR`/`HOME` NOT overridden.

This file decides nothing the owner reserved (the "never nominal `claude -p`" policy line — hard rule vs precaution — is theirs). It supplies the two missing inputs: (A) is a persistent-multi-turn claude-p fork feasible, and (B) what does caching actually cost/save, in numbers.

---

## Established facts carried in (not re-litigated)

- Interactive claude-p over 6 sequential `--resume` turns → `cache_creation=0` AND `cache_read=0` every turn; input grows 3802→23494 (full uncached re-send). (`g4-cache-results.md`)
- WITHIN one live claude-p spawn the agent loop caches fully: ~14k `cache_read` per round, tiny creation (79–636). (`g4-intraspawn-caching-reframe.md`)  → **a LIVE/persistent process caches; only the per-turn-spawn+`--resume` pattern loses it.**
- Control: `claude -p --print --resume` warm-reads ~90k across spawns (caches).
- Decision is Option 1 (`claude -p --print --resume`, caches, reverses D26) vs Option 2 (keep interactive, ONE persistent long-lived claude-p per pi session, caches, preserves D26, needs a fork).

---

## A. Persistent-multi-turn fork feasibility

Source read: `node_modules/claude-p/README.md`, GitHub `smithersai/claude-p` README + SPEC.md + `src/{main,driver,root,hook,stream,transcript,terminal,emit,args}.zig`, and the installed binary's `--help`.

### A.1 Lifecycle (confirmed)

claude-p drives the interactive `claude` TUI exactly as the reframe assumed:

1. Spawns `claude` interactively inside an in-process **zmux `NativeSession`** (a real PTY with a reader thread + bounded scrollback). macOS/Linux only (`forkpty`).
2. An ANSI scanner answers DA1/DA2/DSR/XTVERSION/window-size probes Ink issues at startup (else the TUI hangs).
3. Registers **two hooks** via inline `--settings` (never touches `~/.claude`):
   - **SessionStart** — fires once when Ink's UI is ready; the wrapper waits for the PTY output to go quiet (~80ms) then **types the prompt + Enter** into the live PTY.
   - **Stop** — fires once when the model finishes; payload carries `transcript_path`.
   A relay script in `$TMPDIR/claude-p-<pid>/` appends `<event>\t<payload>\n` to a per-run **FIFO** the driver polls. FIFO created fresh per invocation, destroyed on exit.
4. On Stop: drains the transcript JSONL (retries ~20×20ms for the final flush), extracts the final assistant message + usage, emits in the requested format.
5. **Tears the child down unconditionally after the FIRST Stop** — `session.terminate()`, with the in-source comment *"Tear down the child immediately — we already have the answer."* The wait is a single `while(true)` that `break`s as soon as `stop_payload != null`. SessionStart/Stop each fire **exactly once per process**; they are **not re-armed**.

**Exit-after-Stop confirmed.** Single-turn by construction. No `--max-turns`>1 loop semantics for *driving* multiple prompts; `--max-turns` only bounds the agent loop inside the one turn.

### A.2 Does the underlying interactive `claude` TUI stay alive & ready for a NEXT prompt? — YES (the load-bearing finding)

From the source: after Stop, **`claude` does NOT exit on its own — the wrapper kills it.** The driver comment and SPEC are explicit that the child is short-lived *because the wrapper terminates it*, not because the TUI ends. With no exit command sent to the TUI, **the interactive `claude` process would remain at its input prompt indefinitely** (normal Claude Code interactive behavior: after a turn it returns to the prompt, ready for the next message).

This is decisive for Option 2: the thing that loses caching is the *spawn-per-turn + `--resume`* pattern, and the thing that kills the live session is **one line in claude-p (`session.terminate()`)**. The PTY-typed-injection path that DOES cache (proven intra-spawn) is exactly the surface a persistent fork keeps open.

### A.3 Existing persistent/daemon/REPL/multi-turn capability — NONE

`--help` and SPEC confirm: no daemon, no REPL, no persistent/multi-prompt flag. Flags present: `--continue`/`--resume`/`--session-id` are *cross-spawn* resume (the pattern that loses cache), not in-process multi-turn. So the fork is net-new behavior, not a flag flip.

### A.4 Fork scope / risk

A persistent fork is a **targeted change, not a deep rewrite**, because the hard parts (PTY spawn, Ink probe answering, hook-FIFO plumbing, transcript drain, result framing) already exist and are reused verbatim. The delta:

| Change | Nature | Risk |
|---|---|---|
| **Don't `terminate()` after Stop** | delete/guard one call; return control to caller with the session handle held open | low |
| **Expose a "send next prompt" entry** (type prompt+Enter into the live PTY again) | reuse the existing SessionStart typing path, but triggered on demand, not off SessionStart | low–med |
| **Re-arm the turn-completion signal per turn** | SessionStart won't fire again (fires once/process). Stop *does* fire per assistant turn in interactive Claude Code, so the **Stop hook + FIFO is the per-turn boundary** — keep the FIFO open and read the *next* Stop instead of tearing down. | **med — the main uncertainty.** Need to confirm Stop re-fires cleanly on turn 2..N within one live process and the FIFO/relay survives (the intra-spawn agent-loop fixture already shows multiple Stop-bounded rounds in one process, which is strong corroboration). |
| **Frame one `result` per turn** | re-run the transcript-drain + emit per Stop, tracking a per-turn high-water mark in the (growing) JSONL so each turn emits only its new tail | med |
| **Lifecycle vs bridge abort/supersede** | the persistent process must SURVIVE a pi abort (abort cancels the in-flight turn, not the session) or be torn down + cold-rebooted on supersede/divergence. Today's bridge tears down per turn (D15 preserves router state). A persistent owner inverts that: PTY outlives the turn. | **med — design integration, not a claude-p blocker.** |
| Zig 0.15.2 toolchain to build the fork | build/CI | low |

**No SHOWSTOPPER found in the source.** The only structural constraint is the one already known and *favorable*: Claude Code is an agent loop whose sole host seam is the MCP-held-open round-trip (memory: structurally forced) — that is unchanged and works the same in a persistent process. The persistent design's real cost is in the BRIDGE (abort/supersede/concurrency around a long-lived PTY), not in claude-p itself.

**Verdict: FEASIBLE-WITH-CAVEATS.** Targeted fork (keep-alive past Stop, re-arm per-turn Stop read, per-turn result framing). Caveats are (1) confirm Stop re-fires per turn in one live process with FIFO intact, (2) per-turn transcript-tail framing, (3) bridge-side persistent-process lifecycle vs abort/supersede. None is a dead end; all are testable with a small spike on the fork.

---

## B. Cost / latency quantification

### B.1 Per-spawn cold-boot latency (the per-turn-spawn tax)

Fresh measurement, 3 sequential runs, concurrency 1, `claude-haiku-4-5`, trivial prompt `"Reply with exactly the word: pong"`, production-style stream-json argv. (`/tmp/g4-boot-probe.mjs`)

| metric | median | range |
|---|---|---|
| spawn → first stream event (**pure boot tax**) | **1091 ms** | 1017–1160 |
| spawn → first stream LINE | 1091 ms | 1017–1160 |
| model turn duration (`turn_duration` event) | 2410 ms | 1991–2455 |
| **full short-turn wall** | **4146 ms** | 3559–4191 |
| **non-model overhead per turn** (wall − model: boot + Ink render + transcript drain + teardown) | **1736 ms** | 1568–1736 |

Corroborating prior fixtures: README quotes "+50–200ms over `claude -p` for PTY+Ink startup"; G1/ExpC single-round walls were ~10–11s (with tool round-trips/larger prompts). The clean trivial-turn boot tax is ~1.0–1.2s; full per-turn fixed overhead a persistent process would AVOID after turn 1 is **~1.7s**.

### B.2 No-cache token-cost penalty (current per-turn-spawn cost / Option 3)

Model: cache_read = 0.1× input, cache_write(5m) = 1.25× input (the multipliers the task specifies; consistent with Anthropic's public caching pricing). Public input rates assumed: **Haiku 4.5 $1.00/M, Sonnet 4.x $3.00/M** (output unchanged either way, so input-only is the apples-to-apples comparison). Session grows linearly, ~2k context added per turn.

**Cumulative INPUT cost over a session:**

| session ctx target | turns | Haiku no-cache | Haiku cached | Sonnet no-cache | Sonnet cached | **cost multiplier** | savings |
|---|---|---|---|---|---|---|---|
| ~50k | 25 | $0.650 | $0.123 | $1.95 | $0.368 | **5.31×** | ~81% cheaper with cache |
| ~100k | 50 | $2.550 | $0.370 | $7.65 | $1.110 | **6.89×** | ~85% cheaper with cache |

**Recurring per-turn tail penalty** (the worst single turn — full ctx re-sent uncached every turn):

| ctx at turn | Haiku no-cache/turn | Haiku cached/turn | Sonnet no-cache/turn | Sonnet cached/turn | ratio |
|---|---|---|---|---|---|
| 50k | $0.050 | $0.0075 | $0.150 | $0.0225 | **6.7×** |
| 100k | $0.100 | $0.0125 | $0.300 | $0.0375 | **8.0×** |

This matches the measured G4 shape (input grows monotonically, cache_read=0) — i.e. **the bridge today pays the full no-cache column.** The growth is effectively O(N²) cumulative (each turn re-bills the whole accumulated prefix), so the multiplier *widens* as sessions get longer; 5.3× at 50k → 6.9× at 100k and rising.

**Latency side of no-cache:** uncached input must be re-processed (prefill) every turn, so **TTFT grows with the uncached prefix**. A warm cache_read skips prefill of the shared prefix → roughly-flat TTFT regardless of context depth; no-cache TTFT climbs as context grows. This compounds the B.1 boot tax: the per-turn-spawn pattern pays *both* the ~1.7s spawn overhead *and* full-prefix prefill every turn.

### B.3 What a persistent process saves

1. **Boot-once vs N boots:** ~1.7s non-model overhead (of which ~1.1s pure boot) saved on **every turn after the first**. Over a 25-turn session ≈ 24 × 1.7s ≈ **~41s of wall-clock removed**; 50-turn ≈ ~83s.
2. **Warm cache:** restores the intra-spawn caching proven in `g4-intraspawn-caching-reframe.md` (~14k cache_read/round, tiny creation) → the **~5.3×–6.9× input-cost reduction** and roughly-flat TTFT from B.2.
3. Net: a persistent process is the *only* interactive-surface option that gets BOTH the latency win (no per-turn boot) AND the cost/cache win, while preserving D26.

---

## C. Recommendation

Both options restore caching. The split is effort vs the D26 policy line.

| | Option 1: `claude -p --print --resume` | Option 2: persistent interactive claude-p (fork) |
|---|---|---|
| Caching | yes (control: ~90k warm read) | yes (intra-spawn proven; persistent keeps it live) |
| Boot tax | still per-turn spawn (~1.7s/turn) unless also persisted | **boots once** — best latency |
| Effort | **low** — flag/surface change, no fork | med — targeted fork + bridge lifecycle work |
| D26 ("never nominal `claude -p`") | **reverses it** | **preserves it** |
| Risk | low technical; policy reversal is the cost | med technical (3 caveats, all testable); no showstopper |

**Recommendation: pursue Option 2 (persistent interactive fork) IF the owner holds D26 as a hard line; fall back to Option 1 if D26 is precautionary.**

Rationale: Option 2 is the strictly-better *technical* outcome — it is the only path that wins on **both** axes (caches AND avoids the per-turn ~1.7s boot tax, saving ~40–80s/session) while keeping the subscription-blessed interactive surface. The source review found **no showstopper**: claude-p already keeps `claude` alive at its prompt and only kills it by choice, so the fork is "stop calling `terminate()`, re-read the next Stop, frame per-turn results" — a targeted change reusing all the hard machinery, not a rewrite. The genuine cost is bridge-side lifecycle (persistent PTY surviving abort / torn down on supersede), which is design work the bridge must do regardless if it wants warm caching on the interactive surface.

Option 1 is the correct choice ONLY if "never `-p`" is precautionary rather than a hard trust boundary — then it's strictly less work for the same caching, at the price of ~1.7s/turn boot tax it doesn't remove (unless `--print` is itself made persistent, which is its own fork-shaped effort and partially re-incurs the thing D26 was avoiding).

What I will NOT decide: whether D26 is hard policy or precaution. That gate is the owner's. This note gives them the numbers and the feasibility verdict to make it.

---

## Constraints honored

- No commits; no edits to `src/**` or `index.ts`. Only this file written (allowed).
- All real claude-p runs at concurrency **1** (sequential boot probe).
- `CLAUDE_CONFIG_DIR` / `HOME` NOT overridden (env passed through verbatim).
- Probe script: `/tmp/g4-boot-probe.mjs` (scratch, outside repo).

## Pricing sources

Public Claude API rates (June 2026): Haiku 4.5 $1.00/M in, Sonnet 4.x $3.00/M in; cache_read ≈ 0.1× input, cache_write(5m) ≈ 1.25× input. From platform.claude.com/docs pricing and 2026 pricing roundups (cloudzero, finout). Multipliers are the canonical Anthropic caching ratios used per the task brief.
