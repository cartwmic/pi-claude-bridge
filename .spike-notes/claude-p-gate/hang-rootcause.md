# claude-p turn HANG — root-cause diagnosis

**Date:** 2026-06-02 · claude-p 0.1.0 (npm, prebuilt darwin-arm64) · claude 2.1.159 ·
node 24.14.0 · darwin 23.3.0 · concurrency 1 (one claude-p at a time) ·
`CLAUDE_CONFIG_DIR`/`HOME` NOT overridden.

DIAGNOSIS ONLY — no `src` edits, nothing committed, `~/.claude` untouched.

Repro harness: `.spike-notes/claude-p-gate/hang-repro.mjs` (drives REAL claude-p
with the bridge's EXACT production flags — mirrors `src/driver/claudeP.ts`
`buildClaudePArgs` + `index.ts` — but `--timeout 45` instead of the bridge's 600s,
plus `--debug --output-format stream-json --verbose`). Per-turn logs + `summary.ndjson`
under the `hang-repro-<model>-<ts>/` dirs. Corroborating prior fixtures:
`g7-timeout-results.md` (held-tool `--timeout` semantics) and
`g9-concurrent-results.md` (contention failure-rate table).

---

## 1. CONFIRMED root cause (hypothesis CONFIRMED, with one important refinement)

The Phase-0 hypothesis is **CONFIRMED**: the "hang" is the claude-p hook-FIFO
**missed-lifecycle-event** mode. claude-p detects turn lifecycle via `SessionStart`
+ `Stop` hooks → a generated relay `hook.sh <event>` → a per-invocation named FIFO
in `$TMPDIR/claude-p-<pid>-<rand>/`. The emission of the terminal `result` line (and
process exit 0) is GATED on the `Stop` hook event arriving over that FIFO within
`--timeout`. When the event is missed, claude-p waits until `--timeout`, then exits
**code 2** with stderr **`claude-p: StopTimeout`** (or `SessionStartTimeout`), having
emitted **NO `result` line**.

### Why it LOOKS like a hang in the suite
The bridge sets `--timeout 600s` (`index.ts: CLAUDE_P_TIMEOUT_SECONDS = 600`). A
missed-event turn therefore sits silently for up to 600s before exiting 2 — far
longer than the int-test wall timeouts (`int-smoke.sh` 150s, the `.mjs` tests
120s). The TEST's `timeout`/`TEST_TIMEOUT` kills pi first, so the operator sees a
"hang with no output." **It is NOT an infinite hang in claude-p itself** — claude-p
*always* exits at its own `--timeout` (see §3). The hang is purely the gap between
claude-p's 600s budget and the test's ~150s budget.

### Real-world fingerprint already in the tree
`.test-output/provider--print-mode-responds.log` is **0 bytes** and the smoke run
recorded `provider: print mode responds … FAIL (exit 124)` — exit 124 is the SHELL
`timeout 150` wrapper in `int-smoke.sh` killing pi, not claude-p's own code. The
empty log = the turn produced no output for 150s = a wedged claude-p turn. That
test uses **claude-sonnet-4-6**.

### Quoted claude-p evidence (StopTimeout = exit 2, no result)
From `g7-timeout-results.md` (raw run log) and `g9-concurrent-results.md`:

```
[t=25s a1] EXIT code=2 signal=null wall=25464ms sawResult=false ...
[t=25s a1] STDERR claude-p: StopTimeout
...
run 1 spawn 0: stopReason=error exit=2 signal=null everRouted=false isolationOk=false
  - D33: RETRIABLE (no tools/call routed; exit=2 signal=null no-result)
  - stderr: claude-p: StopTimeout
```

The bridge's parser (`src/driver/stream.ts endOfStream`) sees an exit with no
terminal `result` line and emits a driver `error` →
`prematureMessage("claude-p stdout closed before a terminal \`result\` line
(premature termination); exit code 2")`. This is exactly the StopTimeout surfaced
to the bridge.

### REFINEMENT — which hook misses, and the SILENT sub-steps between them
The clean `--debug` lifecycle (captured this run, passing turn) is:

```
[claude-p +0ms]    hook harness ready (FIFO + relay script + --settings)
[claude-p +1ms]    zmux session spawned; child claude PID up, Ink booting
[claude-p +646ms]  SessionStart hook fired (Ink is up)
[claude-p +790ms]  Ink quiescent (output silent for 87ms) → typing prompt (51 bytes)
[claude-p +920ms]  prompt + Enter sent; waiting on claude API
[claude-p +949ms]  transcript opened for tailing after 5 attempt(s): ~/.claude/projects/.../<session>.jsonl
[claude-p +3586ms] Stop hook fired (assistant turn finished)
[claude-p +4430ms] result envelope emitted; stream done
```

Two findings sharpen the hypothesis:

1. **In the observed failures the missed event is the `Stop` hook (→ `StopTimeout`),
   not `SessionStart`.** Every quoted contention failure (g7, g9) is `StopTimeout`
   with `everRouted=false` — i.e. SessionStart fired and the prompt was typed, but
   the `Stop` event over the FIFO never arrived in time. `SessionStartTimeout` is
   the rarer earlier-boot variant the _NOTE.md saw historically (2 of 3 early FAILs);
   the dominant mode under our flags is **StopTimeout**.

2. **There is a SECOND, undocumented dependency the README/_NOTE.md don't stress:
   between SessionStart and Stop, claude-p must (a) detect Ink quiescence and type
   the prompt during it, and (b) open + tail the transcript file at
   `~/.claude/projects/<cwd-slug>/<session>.jsonl`.** The `--debug` shows the
   transcript is "not yet on disk; retrying" and only "opened for tailing after 5
   attempt(s)." So a missed `result` can come from FOUR silent failure points, not
   just the FIFO: (i) SessionStart FIFO event missed; (ii) prompt mistyped/dropped
   if Ink quiescence is misjudged under load; (iii) transcript file never appears /
   tail never opens; (iv) Stop FIFO event missed. All four manifest identically to
   the bridge: timeout → exit 2 → no `result`. The hooks are the documented gate;
   the transcript-tail is an equally load-bearing, equally silent second gate.

---

## 2. Failure RATE + haiku/sonnet + exits-vs-truly-hangs

### Concurrency 1 (the suite's stated mode) — SOLID today
| run | model | result |
|---|---|---|
| 30 sequential | claude-haiku-4-5 | **0/30 fail** — wall mean 3.12s (min 2.70, max 4.96) |
| 30 sequential | claude-sonnet-4-6 | **0/30 fail** — wall mean ~3.3s |
| 12 sequential UNDER 2× CPU saturation (16 busy-loops/8 cores) | claude-haiku-4-5 | **0/12 fail** — wall mean 3.24s, firstStreamLine only stretched ~1000→~1300ms |

**At concurrency 1 with a bare text turn, the isolated claude-p layer did NOT fail
in 72 turns**, and pure local CPU starvation did NOT trip it. So the intermittent
suite failures are NOT explained by isolated single-spawn claude-p flakiness; they
require an additional stressor.

### Concurrency > 1 — the trigger, but LOAD-WINDOW-DEPENDENT (not deterministic)
| concurrency | this run (2026-06-02) | g9 probe (2026-06-02 earlier, busier machine) |
|---|---|---|
| 2 | 0/16 fail | **2/3 fail** (StopTimeout) |
| 3 | — | **3/3 fail** (StopTimeout) |
| 4 | 0/20 fail | **3/3 fail** (StopTimeout) |
| 8 | 0/24 fail | — |

The SAME concurrency level swung from 3/3-fail (g9) to 0/20-fail (this run) on the
same machine/binary within a day. **The failure rate is a function of transient
system contention during concurrent claude-p *boot*, NOT a clean function of
concurrency count.** When multiple claude-p instances boot at once, their Ink
terminal-probe / hook-relay / FIFO-poll timings race for CPU and the OS scheduler;
on a loaded machine one or more miss their Stop window. On an idle machine they all
make it. This is precisely the _NOTE.md observation ("failures correlate with
heavier contention / transient conditions, NOT a hard incompatibility").

### haiku vs sonnet
No measurable RELIABILITY difference at concurrency 1 (both 0/30). The reason
`int-smoke.sh` (sonnet) is the test most often seen hanging is NOT that sonnet's
hooks miss more — it is that the smoke test is frequently run alongside the rest of
the suite (concurrent claude-p boots elsewhere) and its 150s shell `timeout` makes
a wedged 600s turn maximally visible. The model choice is incidental; the trigger
is concurrent-boot contention + the 600s-vs-150s budget gap.

### Process / fd leak across the loop?
**No leak correlated with turn count.** The harness's `ps` census stayed at the
baseline (1 unrelated pre-existing `claude` — the agent's own) after every
concurrency-1 turn. The "LEAK? census grew" lines in the concurrency runs are false
positives: they caught the *sibling* spawn in the same wave plus the agent's own
`claude`, and the count returned to baseline immediately after each wave — no
orphaned `claude`/zmux survived. Failure rate did **not** rise with turn count
(no resource exhaustion); failures are random within a bad contention window.

---

## 3. Does claude-p ever TRULY hang, or always exit at --timeout?

**It always EXITS — never an unbounded hang.** Every observed failure is exit 2
(`StopTimeout`/`SessionStartTimeout`) landing at ~`--timeout` wall. The repro's
backstop (kill at `--timeout + 30s` and record `TRUE_HANG`) **never fired** in any
run. The g7 SHORT spawns exited at exactly 25.5s for a 25s `--timeout`. So:

- claude-p's `--timeout` is a real, honored upper bound on the turn.
- The bridge's 600s value is what turns a fast (45s-equivalent) failure into a
  10-minute silent wait that READS as a hang.

**Decision input:** because claude-p reliably self-exits at `--timeout`, the question
of "idle-watchdog vs lower `--timeout`" is about WHEN to give up, not about rescuing
a process that never dies. An idle-watchdog and a lower `--timeout` are two ways to
shorten the same give-up window.

---

## 4. Fix-option assessment (evidence-based) + recommendation

### (a) Bridge idle-watchdog: no-output-for-N-sec → abort → D33 retry; held-round-aware
- **Pro:** Directly attacks the confirmed cause's *symptom* — a wedged turn emits
  nothing. An idle timer (reset on every stdout stream-json line) fires in ~N sec
  (e.g. 30–45s) instead of 600s, converts the silent wedge into a fast driver
  `error`, and D33 respawns it. The 0/72 concurrency-1 + g9-retry data show a
  respawn almost always lands clean (a fresh boot escapes the bad window).
- **Pro:** Held-round-aware is straightforward and CORRECT here because a healthy
  held tool still produces stream activity (the `tool_use`/`WaitForMcpServers`
  lines, then quiet during the hold) — the watchdog keys on "no NEW stream line for
  N sec AND not currently parked on a routed tool," so a legitimate 120s held tool
  (S8) does not trip it. This sidesteps the entire G7 tension (below).
- **Con:** Must be implemented carefully so the idle window during model think-time
  (haiku/sonnet can be silent ~2–3s mid-generation; longer for big prompts) doesn't
  false-positive. N must exceed the longest legitimate inter-line gap that is NOT a
  held tool — measurable (our firstStreamLine ~1s, inter-line gaps <3s on trivial
  turns; size for the real large system prompt).
- **Con:** It is a MITIGATION (faster detection + retry of a wedge), not a cure for
  the wedge itself.

### (b) Lower / derive claude-p --timeout
- **Pro:** Trivial. A 45s `--timeout` makes a wedged turn exit ~45s instead of 600s.
- **Con (DECISIVE, from g7):** **`--timeout` counts held-tool wall-time.** g7 proved a
  25s `--timeout` against a 40s held tool exits code 2 `StopTimeout` mid-hold —
  *killing a healthy turn*. And because that StopTimeout fires AFTER a `tools/call`
  routed (`everRoutedToolCall=true`), the D33 idempotency gate FORBIDS respawn ⇒
  **turn-fatal hard error to pi**. So `--timeout` CANNOT be globally short: it must
  stay ≥ the longest legitimate single-turn wall (all held rounds + think-time).
  The bridge's own `bash` tool default is 120s (`index.ts:471`); a turn with a
  couple of slow held rounds can approach minutes. A short global `--timeout`
  trades intermittent boot-wedges for deterministic held-tool kills — strictly
  worse. `--timeout` must remain a generous backstop, NOT the give-up mechanism.
- **Verdict:** Not viable as the primary fix. A *modest* reduction (e.g. 600→300) is
  harmless headroom-trimming but does not solve the visibility gap on its own.

### (c) Fork claude-p to harden hook detection
- **What would change:** (i) make the `Stop`/`SessionStart` FIFO wait more robust —
  e.g. a fallback that detects turn-end from the *transcript tail* (the `result`-
  equivalent assistant-final + the `Stop` payload's `last_assistant_message` are
  both already read) rather than ONLY the FIFO event, so a missed FIFO event still
  terminates the turn; (ii) widen/de-race the Ink-quiescence prompt-typing under
  load; (iii) make transcript-open retry/backoff more patient. The `--debug` shows
  claude-p already KNOWS the Stop payload arrived (it logs `hook: stop payload=…`)
  — the fragility is the in-process FIFO poll missing it under scheduler pressure.
- **Pro:** This is the only option that attacks the ROOT (the missed-event detection
  itself), and the repo already anticipates a fork (SCENARIO_RESULTS line ~128:
  "upstream/fork changes to claude-p").
- **Con:** Zig codebase, upstream is explicitly "educational / use at your own risk /
  API-unstable"; carrying a fork is real maintenance. Highest effort. The README
  itself frames hook-detection fragility as a "potential fragility point if hook
  behavior changes between versions."

### (d) Persistent process (one long-lived claude-p / session)
- **Pro:** The confirmed trigger is concurrent **boot** contention + per-turn hook
  CYCLES. A persistent interactive `claude` (driven over a stable PTY, multi-turn via
  stdin stream-json) would pay the Ink-boot + hook-registration cost ONCE, then run
  many turns without re-booting → it removes ~all the SessionStart/boot-race exposure
  and most Stop-cycle churn (fewer FIFO round-trips overall). _NOTE.md Exp B already
  proved a persistent `-p --input-format stream-json` session works (multi-turn, same
  session_id, cross-turn recall).
- **Con:** claude-p's README states it is "**single-turn … multi-turn driving is out
  of scope**"; the bridge currently gets multi-turn via `--resume` across fresh
  spawns (warm cache works, but re-boots every turn). A true persistent process is a
  larger architectural change (turn framing, abort/steer mid-session, the warm-resume
  re-echo handling, concurrency isolation for S14/S25 sub-spawns) — it touches the
  driver model, not just a wrapper. It also doesn't eliminate the Stop-FIFO
  dependency PER TURN; it reduces the *number* of boot/hook cycles and removes the
  boot race, which is the dominant trigger.
- **Verdict:** The strongest ROOT-CAUSE-reducing direction structurally, but the
  biggest change and partially against claude-p's design center.

### Recommendation
**Ship (a) the held-round-aware idle-watchdog now as the correct operational fix,
paired with a modest `--timeout` trim (b: 600→~300).** Reasoning tied to the
confirmed cause:
- The cause is a *silently wedged turn that always self-exits at `--timeout`*; the
  pain is purely the 600s-vs-150s visibility gap. An idle-watchdog closes that gap
  precisely (fast detection on the real symptom: no stream activity), and D33 retry
  exploits the proven fact that a fresh boot escapes the bad contention window. It
  is held-round-safe in a way a short `--timeout` is NOT (g7), so it does not
  regress slow tools.
- (b) alone is unsafe (g7 held-tool kill) and insufficient; keep `--timeout` only as
  a generous backstop, never the give-up path.
- **The PROPER root-cause fixes are (c) and (d); (a) is a mitigation.** Of the two,
  **(d) persistent-process is the structurally superior root-cause fix** because the
  dominant trigger is concurrent-BOOT contention and per-turn hook CYCLES — both of
  which a long-lived session largely eliminates — and Exp B already shows the
  mechanism is feasible. (c) is the narrower root fix (harden the FIFO/transcript
  turn-end detection) and is the right move IF the bridge stays on the
  spawn-per-turn model. Recommend: (a)+(b) immediately for suite stability; pursue
  (d) as the long-term architecture (with (c)-style detection hardening folded in if
  a fork is taken regardless).

---

## 5. Provenance / safety
- New files (this diagnosis only): `hang-repro.mjs`, `hang-rootcause.md`, and the
  `hang-repro-<model>-<ts>/` log dirs — all under `.spike-notes/claude-p-gate/`.
- **No `src/**`, `index.ts`, `convert.ts`, or `models.ts` edits** (`git status`
  confirmed clean for those paths).
- **Nothing committed.**
- **`CLAUDE_CONFIG_DIR` / `HOME` NOT overridden; `~/.claude` not written by the
  repro** (only `claude` itself writes its own session transcripts there, as it does
  in normal operation).
- Concurrency 1 for the baseline (one claude-p at a time); the >1 bursts are
  explicitly the contention-reproduction experiment and are labeled as such.
