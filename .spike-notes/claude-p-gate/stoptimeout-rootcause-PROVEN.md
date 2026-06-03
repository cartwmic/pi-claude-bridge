# claude-p StopTimeout "hang" — ROOT CAUSE, PROVEN (source + runtime)

**Date:** 2026-06-02 · claude-p 0.1.0 (prebuilt darwin-arm64) · claude 2.1.159 ·
node 24.14.0 · darwin 23.3.0 · model claude-haiku-4-5.
Harness: `stoptimeout-proof.mjs` (drives REAL claude-p with the bridge's exact
production flags; reads claude's OWN transcript JSONL as independent ground truth).
DIAGNOSIS ONLY — no `src` edits, nothing committed, `~/.claude` not written by us.

This SUPERSEDES the inferred portion of `hang-rootcause.md` §1 (which hedged across
four candidate sub-steps). The actual failing step is now proven and is NOT the
2000ms quiescence cap.

---

## The proven root cause (one paragraph)

claude-p drives the **interactive `claude` TUI** (Ink) inside a PTY and decides when
to type the prompt from two signals: the `SessionStart` hook firing **and** the PTY
output going quiet for ≥80 ms (`src/driver.zig` `waitForInkQuiescent`,
`ink_quiescence_ms=80`, cap `ink_max_wait_ms=2000`). **Neither signal proves the
child `claude`'s Ink *input pipeline* is actually ready to receive keystrokes.**
Under concurrent-boot CPU contention, `claude` fires `SessionStart` early and then is
descheduled; the PTY is "quiet" only because the process is starved, not because it
finished wiring input. claude-p types the prompt into this not-yet-ready TUI, the
keystrokes are dropped, and `claude` never registers a submitted prompt — so it
**never creates the session transcript, never runs a turn, and never fires the `Stop`
hook**. Turn-end is gated on `Stop`; with no `Stop`, claude-p waits the full
`--timeout` and exits **code 2 / `claude-p: StopTimeout`** with no `result`. The
bridge sets `--timeout 600s`, so the dropped-input turn sits silent for up to 10
minutes = the apparent "hang."

---

## Proof chain

### 1. Algorithm (from claude-p source, verbatim)
`src/driver.zig` — state machine `waiting_for_ready → awaiting_stop`:
```zig
.session_start => {
    waitForInkQuiescent(...);          // wait ≥80ms PTY-quiet, capped 2000ms, then type ANYWAY
    session.send(opts.prompt, false);  // type prompt
    sleep(ink_enter_debounce_ms);      // 120ms
    session.send("", true);            // Enter
    state = .awaiting_stop;
}
// timeout: waiting_for_ready → SessionStartTimeout ; awaiting_stop → StopTimeout
```
`src/main.zig` — any error → `claude-p: <ErrName>` + `std.process.exit(2)`.
⇒ A `StopTimeout` (exit 2) **proves SessionStart already fired and the prompt was
already typed** (state had advanced to `awaiting_stop`). The failure is *after typing*.

### 2. Runtime reproduction (the wedge)
60 concurrent-boot spawns (concurrency 10) under 16 CPU-saturation workers on 8 cores.
**2/60 failed; both identical:**

| spawn | SessionStart | quiescence | prompt typed | transcript on disk | Stop | exit |
|---|---|---|---|---|---|---|
| w2-s1 | fired @+3538ms | `silent 273ms, waited 0ms total` | yes (+3665ms) | **ABSENT (verified on disk)** | never | 2 / StopTimeout @60s |
| w2-s7 | fired @+3560ms | `silent 168ms, waited 0ms total` | yes (+3681ms) | **ABSENT (verified on disk)** | never | 2 / StopTimeout @60s |

`typedAnyway=false` on both ⇒ the **2000ms cap was NOT hit** (prior inference wrong).
The transcript JSONL named in claude's own `SessionStart` payload was **never created**
(confirmed `ABSENT` by direct `ls` of `~/.claude/projects/<slug>/<id>.jsonl`) ⇒ claude
never registered a submitted prompt ⇒ no turn ⇒ no `Stop`.

### 3. The race (why passing runs in the SAME wave succeed)
`w2-s0`, same wave/load, also typed at `waited 0ms total` (silent 439ms) — but its
transcript **did** appear (`opened for tailing after 246 attempt(s)` @+5215ms), `Stop`
fired @+5767ms, `result` @+6587ms ⇒ PASS. So prompt-typing under load is a **race on
input-readiness**: sometimes the keystrokes land, sometimes they're dropped.

### 4. Contention is the trigger
Same harness, **no** added load: **0/30** failures (boots ~4s, all transcripts written,
all `Stop` fired). With saturation: 2/60. Matches the g9 probe (idle 0/16 vs busy 2/3
at concurrency 2). The trigger is transient CPU starvation during concurrent **boot**,
not turn count, not a leak, not the model.

### Ruled out (by the above)
- ❌ 2000ms quiescence cap ("typing anyway") — `typedAnyway=false` on every failure.
- ❌ Stop-FIFO *delivery* failure — `Stop` legitimately never fired because the turn
  never started; there was nothing to deliver.
- ❌ transcript-tail open failure — there was no transcript to tail (never created).
- ❌ SessionStart missed — it fired on every failure.
- ❌ claude "frozen 60s" — same-load passing runs wrote transcripts in 5–7s; a dropped
  turn writes **no** transcript at all, not a late one.

### Only un-instrumented step
We cannot photograph Ink's screen to literally show the empty prompt box (the prebuilt
binary exposes only byte counts, not content). But "claude fired SessionStart and kept
emitting PTY output, yet never created a transcript or ran a turn" has exactly one
explanation consistent with the passing-run race: **the typed input did not register.**

---

## Fix implications (sharper than hang-rootcause.md §4)

- **Concurrency cap (boots ≤1–2):** directly removes the trigger — no concurrent boot
  ⇒ claude isn't starved while wiring input ⇒ the prompt lands. Strongest cheap fix.
- **Idle-watchdog + D33 retry:** a respawn re-rolls the input-readiness race; a fresh
  boot almost always lands. Correct mitigation for the 600s→~30s visibility gap.
- **Fork (now surgically targetable):** after typing, claude-p should **confirm the
  prompt landed** (transcript created / user message present) within a short window and
  RE-TYPE or fail-fast — instead of blindly waiting `--timeout` for a `Stop` that can
  never come. Far narrower than "harden FIFO detection."
- **Persistent-process:** types each turn into an already-established, input-ready
  session — removes the per-turn boot/input-readiness race entirely (the cause here).
  Caveat unchanged: its only feasibility evidence (Exp B) used nominal `claude -p`
  (forbidden by D26); the allowed variant is persistent **interactive-TUI** driving.
