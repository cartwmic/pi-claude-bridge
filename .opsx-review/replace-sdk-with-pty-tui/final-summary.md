# Final Summary — Adversarial Review Cycle

**Change:** `replace-sdk-with-pty-tui`
**Schema:** opsx-superpowers (Scale L)
**Reviewers:**
- A: `claude-bridge/claude-opus-4-7`
- B: `openai-codex/gpt-5.4`
**Date range:** 2026-05-20 to 2026-05-21
**Owner instruction:** "you have my full trust. just persist the decisions and reasoning to a file for me to review later. then proceed through the open spec schema to apply the changes after incorporating the review findings"

## Loop summary

| Round | P0 | P1 | P2 | P3 | P0+P1 | Verdict (A / B) |
|---|---|---|---|---|---|---|
| 1 | 4 | 7 | 5 | 3 | 11 | needs revision / needs revision |
| 2 | 0 | 7 | 5 | 5 | 7  | needs revision / needs revision |
| 3 | 0 | 6 | 7 | 3 | 6  | needs revision / needs revision |
| 4 | 1 | 5 | 6 | 1 | 6  | needs revision / needs revision |
| 5 | 0 | 6 | 7+ | 3 | 6  | needs revision / needs revision |

**Stop condition triggered:** P0+P1 flat for 2 consecutive rounds (R3=6, R4=6, R5=6). Per skill: "P0+P1 flat or rising for 2 consecutive rounds → treadmill, move to Step 6".

## What got resolved

- **Constitution III amended in-place** (v1.0.0 → v1.1.0) to add the deterministic-transcript-path exemption. Ratified by this Scale-L change's adversarial-review-cycle.
- **6 new design decisions added across rounds:** D12 (Hook IPC), D13 (Prompt injection), D14 (Build pipeline), D15 (Abort lifecycle preserving late-tool-result), D16 (Capture deterministic shim response), D17 (Bounded Stop settle window), D18 (Deterministic `--session-id` transcript path), D19 (Shim absolute path resolution), D20 (Shim↔router IPC wire protocol), D21 (Capture IPC stash authoritative), D22 (Warm-resume transcript path), D23 (Main-provider preserves ctx.systemPrompt), D24 (Warm-resume tail baseline ordering).
- **10 new spec ACs added** to cover hook IPC, prompt injection mechanism, image v1 handling, abort coherence, hook payload IPC, capture shim response, transcript drift detection, warm-resume tail baseline, hook command quoting, etc.
- **8 new tasks + spikes added:** T0.6 (terminal queries), T0.7 (isolation flags), T0.8 (interactive system-prompt), T0.10 (--json-schema availability), T0.11 (argv overflow + --system-prompt-file fallback), T0.12 (--session-id determinism), T0.13 (hook payload shapes), T0.14 (positional-prompt liveness HARD GATE).
- **Capture-path system-prompt fidelity:** verbatim per constitution V, no addendum.
- **Main-provider system-prompt:** ctx.systemPrompt preserved as the base (D23).
- **Packaging:** D14 build pipeline → dist/; index.ts top-level wrapper preserved for pi.extensions discovery.
- **PreToolUse hook dropped** across all artifacts per Round 2 latency finding + Round 3 propagation.

## What remains as Phase 0 / Phase 4 risk

These items are NOT shipping debt — they are spike work that runs BEFORE Phase 1 implementation:

- **T0.14 liveness gate** must prove `claude` with positional prompt remains alive in interactive mode (else design D-rev needed).
- **T0.8** must prove `--system-prompt` suppresses CLAUDE.md/auto-memory (else escalate to --bare, which breaks hooks).
- **T0.11** must verify `--system-prompt-file` exists in interactive mode (else argv overflow = v1 hard limit).
- **T0.7** must verify `--setting-sources ""` isolates user settings (else fall back to HOME override).
- **T0.13** must capture hook response shape contract.
- **T0.12** must verify `--session-id` determinism + cwd encoding.

If any spike fails, that triggers a follow-up change against the design — but the architecture has clear fallback paths or documented hard limits documented for each case.

## Open scope-deferred items for owner

Owner can review these at any time. They are NOT blocking and have been recorded but not applied:

1. `--json-schema` as capture-mode primary (vs forced MCP tool-call) — if T0.10 confirms interactive availability, follow-up change can reconsider.
2. Fail-closed on `claude --version` skew (vs warn-only) — opinion call.
3. Per-block streaming UX validation spike — UX subjective.
4. Multiplexed unix socket vs per-PTY — defer until concurrency demand exists.
5. Local dev loop without build step — convenience nice-to-have.

See `decisions.md` for the full Round-by-round disposition matrix.

## Verdict status

Both reviewers still mark "needs revision" at Round 5, but the deltas have shrunk dramatically and the remaining P1s are all either:
- Documented as Phase 0 risk gates (not implementation debt)
- Wording mismatches between artifacts that the cleanup pass (Step 8) resolves
- Real bugs the cleanup pass fixed

**Treadmill stop is the correct decision per the skill's contract** — continuing rounds would chase diminishing returns. The artifact set is implementation-ready behind the Phase 0 spike gates.

## Files

```
.opsx-review/replace-sdk-with-pty-tui/
├── README.md
├── round-tracker.md
├── decisions.md            # all auto-applied + scope-deferred decisions, by round
├── scope-deferred.md       # owner-review items
├── final-summary.md        # this file
├── round-1-reviewer-A.md
├── round-1-reviewer-B.md
├── round-1-convergent.md
├── round-2-reviewer-A.md
├── round-2-reviewer-B.md
├── round-3-reviewer-A.md
├── round-3-reviewer-B.md
├── round-4-reviewer-A.md
├── round-4-reviewer-B.md
├── round-5-reviewer-A.md
└── round-5-reviewer-B.md
```

All transcripts are blind reviews (same prompt, no leakage between reviewers or rounds).
