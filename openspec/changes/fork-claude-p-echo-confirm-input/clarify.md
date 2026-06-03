# Clarify Findings

Scale = S → **ambiguity pass only** (passes 2–3 skipped per schema). Findings
answered inline with sensible defaults; one item carried to the Phase-0 spike.

## Pass 1 — Ambiguity (semantic-entropy lite)

| # | AC ref | Question | Option A (keep) | Option B (change) | Status | Resolution |
|---|---|---|---|---|---|---|
| A1 | claude-p-fork.echo-confirmed-prompt-commit | What counts as "the prompt echo" — full text or a substring? | Require the full typed string in `recent` | Match a distinctive ASCII token of the prompt, ANSI-stripped, to survive Ink wrapping/escapes | **answered** | B — full-string is brittle under Ink redraw; match a distinctive token after ANSI-stripping, scanning only bytes appended after the send. |
| A2 | claude-p-fork.bounded-retype-on-dropped-prompt | Is the budget a count, a time, or both? | One dimension | Both: per-attempt echo window AND max attempt count | **answered** | B — bound by both so neither a fast-fail nor a slow render runs unbounded. Concrete values tuned in the spike (start ~750ms × 3). |
| A3 | claude-p-driver.driver-runs-the-patched-claude-p-binary | How is "the patch is present" confirmed? | Spec stays solution-free | Pin a mechanism in the spec | **answered** | A — spec stays solution-free; design picks the mechanism (prefer a fork version/identity string; else a behavioral probe). |

## Carried to Phase-0 spike

- **Clear-line reset (risk R6):** confirm Ctrl-U fully empties a partially-filled Ink
  input before retype (so retype can't concatenate into a corrupted prompt). Empirical
  — validate against the real binary, not a spec ambiguity.

## In-scope confirmations (no new ACs needed)

- Echo-confirm applies to **any** turn where claude-p types a prompt — fresh and
  `--resume` alike (the fork ACs are written over "WHEN claude-p types the prompt").
- The **capture** sub-spawn inherits the fix automatically — it runs the same patched
  binary (`claude-p-driver.driver-runs-the-patched-claude-p-binary`).
