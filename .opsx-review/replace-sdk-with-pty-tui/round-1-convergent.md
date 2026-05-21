# Round 1 — Convergent Findings

Both reviewers' findings classified with severity and convergence.

## Counts

| Severity | Reviewer A | Reviewer B | Total | Convergent (both raised) |
|---|---|---|---|---|
| P0 | 4 | 0 | 4 | 0 (direct) — but B's P1#3 echoes A's broader capture-mode concern |
| P1 | 3 | 4 | 7 | 1 strong convergence: capture-mode completion semantics |
| P2 | 4 | 1 | 5 | 1 convergence: constitution V tension (resolved during this round — see decisions.md) |
| P3 | 3 | 0 | 3 | — |
| **TOTAL** | 14 | 5 | 19 | — |

## Findings table

| # | Reviewer | Severity | Title | Convergent? | Classification | Disposition |
|---|---|---|---|---|---|---|
| 1 | A | P0 | Hook execution model unspecified (hooks are subprocesses, not callbacks) | partial (B's P1#2 echoes) | bug fix / design gap | auto-apply: add D12 (hook IPC) + spec ACs |
| 2 | A | P0 | Prompt injection mechanism unspecified | no | bug fix / design gap | auto-apply: pin CLI positional arg for v1; image rejected with `stopReason: error` |
| 3 | A | P0 | Cold-start history flattened — regression vs SDK | no | **FALSE POSITIVE** (current code already flattens via `buildColdStartPrompt`) | document as not-a-regression in resolution log; no edit |
| 4 | A | P0 | Transcript JSONL path wrong (`~/.claude/sessions/` → real is `~/.claude/projects/`) | no | bug fix | auto-apply: global path correction across all artifacts |
| 5 | A | P1 | `--strict-mcp-config` missing → user MCP servers leak | no | bug fix | auto-apply: add to D1 + ACs |
| 6 | A | P1 | `--setting-sources` missing → user settings override bridge config | no | bug fix | auto-apply: add to D1 + ACs |
| 7 | A | P1 | `--permission-mode` missing → interactive permission dialogs may block PTY | no | bug fix | auto-apply: pin `bypassPermissions` |
| 8 | B | P1 | PTY terminal-query handling unaddressed (DEC/XTVERSION etc per claude-p) | no | design gap | auto-apply: add Phase 0 spike T0.7; design note in D2 |
| 9 | B | P1 | Abort without `Stop` hook — Stop reportedly doesn't fire on user interrupt | partial (related to A#1 hook lifecycle) | design gap | auto-apply: add D15 + AC for abort-without-Stop classification |
| 10 | B | P1 | Capture-mode MCP completion semantics undefined → hang risk | yes (convergent with A's broader capture concerns) | design gap | auto-apply: add D16 + shim AC for deterministic capture-tool response |
| 11 | B | P1 | Packaging broken — `files` whitelist doesn't include `src/`; no TS build for shim bin | no | bug fix | auto-apply: add D14 (build step → `dist/`); tasks for build pipeline; update `files` |
| 12 | A | P2 | Rollback asymmetric post-Phase-3 | no | docs | auto-apply: clarify rollback story in design + CHANGELOG note |
| 13 | A | P2 | No hook-payload schema drift detection | no | design gap | auto-apply: add transcript-stream AC for unknown JSONL types |
| 14 | A | P2 | Capture-mode tension with constitution V (no flag replaces system prompt) | yes (with B's P2) | **RESOLVED at review-time** by verifying `--system-prompt` exists | auto-apply: pin D7-final to `--system-prompt`; close constitution V partial-compliance |
| 15 | A | P2 | Clarify A9 resolution mis-attributes schema validation layer | no | minor wording | auto-apply: update clarify A9 resolution |
| 16 | A | P2 | Transcript JSONL flush cadence unmeasured | no | spike | auto-apply: ensure Phase 0 T0.4 measures flush cadence; revise R6 |
| 17 | A | P2 | Operationalize Constitution IV audit on upgrades | no | design gap | auto-apply: add CI check task in Phase 4 |
| 18 | B | P2 | D7 fallback would violate constitution V (no stop gate) | yes (with A#14) | **RESOLVED** — D7 has clean answer | as above |
| 19 | A | P3 | RTK truncation cosmetic concern | no | non-issue | document, no edit |
| 20 | A | P3 | D11 actually has three layers, named two | no | wording | auto-apply: restate D11 to enumerate 3 layers |
| 21 | A | P3 | Compat envelope overclaim | no | wording | auto-apply: reword |

## Round summary

- Strong convergence on **capture-mode completion semantics** (B#10 raises hang risk; A repeatedly touches the same area in challenged assumptions and stronger alternatives).
- Strong convergence on **constitution V tension** (A#14 + B#18) — both raised; this turn's `claude --help` verification reveals `--system-prompt` is a real flag that REPLACES the default, dissolving the tension.
- A is heavier on factual/operational gaps (4 P0s); B is more focused (no P0s but 4 sharp P1s).
- Both agree the proposal needs revision before implementation.
- One reviewer-A finding (#3, cold-start regression) is a false positive — current code already flattens history.

## Verdicts

- A: **needs revision** (P0 issues block proceeding)
- B: **needs revision** (operational gaps; P1 packaging issue is showstopper for shipping)
- Approvals: 0/2 → continue to Step 4 (apply revisions) → Step 5 (loop into Round 2)
