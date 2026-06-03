## Context

The `claude-p` driver wedges under concurrent-boot CPU contention: it types the pi
prompt into the `claude` Ink TUI before input is ready, the keystrokes drop, no turn
starts, the `Stop` hook never fires, and it waits the full `--timeout` (600s) before
exit 2 `StopTimeout`. Proven in `.spike-notes/claude-p-gate/stoptimeout-rootcause-PROVEN.md`
(2/60 reproduced under load, 0/30 idle). The fix is a small fork patch.

Respects constitution **III** (no `~/.claude` writes) and **IV** (native-tool disallow
forwarded) — both unaffected and re-verified. The no-nominal-`claude -p` guarantee (prior
change D26) holds: the patch changes only *when* keystrokes commit.

## Goals / Non-Goals

**Goals:** make one boot reliably deliver its prompt; fail fast + retriably when it
can't; run the patched binary on this branch; prove it with `stoptimeout-proof.mjs`.

**Non-Goals:** multi-platform CI/release pipeline (follow-up); bridge-side concurrency
cap + idle-watchdog (separate change); hardening end-of-turn `Stop` delivery (not the
failing step); persistent-process driving.

## Decisions

### D1: Echo-confirm-before-Enter is the fix mechanism

**Choice:** In `src/driver.zig`, replace the blind `ink_enter_debounce_ms` sleep between
`session.send(prompt,false)` and `session.send("",true)` with a loop that confirms the
prompt echoed into `SharedState.recent` before sending Enter; clear-line + retype on
miss; fail fast if never confirmed.

**Alternatives:** longer/smarter quiescence window (still a proxy — starvation-silence
is indistinguishable from ready-silence; adds latency); detect the rendered prompt box
(render ≠ input-ready, version-fragile); bridge-side only (can't see the PTY — only
re-rolls or reduces the race).

**Rationale:** observes the actual effect (did keystrokes land?) not a readiness proxy;
reuses existing machinery (`recent` is already populated and already used for
trust-dialog detection; the send/Enter seam already exists). ~30 lines.

**4-point test:** 4/4 → **ADR candidate: YES.**

### D2: Binary provisioning — build for the dev platform + repoint; identity check; CI pipeline deferred

**Choice:** Build the patched binary with Zig 0.15.2 for the dev/CI platform, repoint
the bridge `package.json` `claude-p` dependency to the fork, and add a patched-binary
identity check (extend `checkClaudePVersionsOnce`) that warns on a stock-binary fallback.
A multi-platform CI/release pipeline (mirroring upstream's `install.js` prebuilt-download
model) is a **follow-up**, not part of this change.

**Alternatives:** full multi-platform CI pipeline now (gold-plating for an S change —
deferred); vendor a prebuilt binary in the bridge repo (binary-in-git, single-platform).

**Rationale:** the immediate goal is to land + validate the fix on this branch; a
single-platform build + repoint + identity guard is sufficient and small. The identity
check prevents silently running the unpatched binary.

**4-point test:** multiple approaches ✓ · lasting ✓ · disagreement ~ · constrains future ~
→ ADR candidate: borderline (the eventual provisioning model is, but that's the deferred
follow-up).

### D3: Patch details — `PromptNotAccepted` error, ANSI-token match, bounded budget

**Choice:** Add `RunError.PromptNotAccepted` (gets a distinct stderr name via `main.zig`'s
existing generic handler — keep exit 2; the bridge classifies on stderr). Match a
distinctive ANSI-stripped token of the prompt over bytes appended after the send (D4-style,
clarify A1). Bound confirmation by a per-attempt echo window AND a max attempt count
(start ~750ms × 3; tuned in the spike). Clear-line (Ctrl-U) precedes each retype.

**Rationale:** minimal patch surface; distinct + classifiable failure; robust match;
bounded worst case ~3s vs 600s, with D33 respawn re-rolling after fail-fast.

**4-point test:** ≤2/4 → ADR candidate: NO (tactical).

### D4: Validation gate G-echo

**Choice:** Promote `stoptimeout-proof.mjs` to a committed reliability check. Gate
**G-echo**: under the same 16-worker/concurrency-10 saturation that gave 2/60 `StopTimeout`
on the stock binary, the patched binary MUST give 0 dropped-prompt failures (unrelated
transient API errors classified separately). Record a before/after fixture.

**Rationale:** the bug is load-dependent; the only credible proof is the same harness at
the same load flipping 2/60 → 0.

**4-point test:** 4/4 → **ADR candidate: YES.**

## Risks / Trade-offs

| # | Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|---|
| R1 | Echo-token false positive/negative under exotic Ink renders | Medium | Medium | ANSI-strip + distinctive token + scan only post-send bytes; validate in spike |
| R2 | Upstream `claude`/Ink change breaks the patch on upgrade | Medium | Medium | Patch confined to the input step; identity check; `sync-custom-forks` review before adopting upstream |
| R3 | Double-submit (Enter sent when input not clean) | Low | High | Confirm-before-Enter invariant; at-most-one-Enter AC + test |
| R4 | Provisioning silently leaves the stock binary → fix inactive | Medium | High | Identity check warns; install fails loudly if the platform binary is absent |
| R5 | Zig 0.15.2 toolchain availability | Low | Low | Pin the version; the build is for the dev/CI platform only this change |
| R6 | Clear-line doesn't fully reset a partially-filled Ink input (clarify) | Low | Medium | Spike-confirm Ctrl-U; escalate clear strategy if needed |

## Migration Plan

1. Fork + patch + local build (darwin-arm64), `custom:` commit on the fork default branch.
2. Repoint `package.json`, wire `resolveClaudePBin` + identity check, run G-echo → confirm
   2/60 → 0.
3. Wire G-echo into the suite; re-verify constitution III/IV.

**Rollback:** revert `package.json` to `claude-p@0.1.0` (one line) — the patch is isolated;
the existing D33 retry remains as a mitigation, so rollback degrades gracefully.

## Open Questions

- Budget tuning (D3): finalize per-attempt window / max attempts from spike data.
- clarify: confirm clear-line fully resets a partially-filled Ink input.
