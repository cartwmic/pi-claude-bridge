# Scenario validation results

Branch: `refactor/sdk-native-inference-only`. Run via
`bash scripts/run-all-scenarios.sh`. Each scenario has a deterministic
tmux wrapper in `scripts/run-scenario-s<N>.sh` plus shared helpers in
`scripts/scenario-lib.sh`.

## Final status — 2026-04-25 (post-honesty-review)

```
Passed: 20/20  (with strict probe-response assertions)
```

After the user challenged "are tests artificially passing because you want them to pass?", I reviewed the prior 16/20 PASS run and discovered **3 fake-passes** (S5, S7, S13) where the assertion grepped the entire pane (including my own prompt text and abandoned model output) instead of the model's actual response to the coherence probe. Those tests "passed" while the model was actually saying *"I don't have any previous context"* and *"I wasn't interrupted"*.

The fake-passes pointed to **two real bridge bugs**:
1. **Abort dropped `cachedSessionId`**, so the next turn cold-started with no context — model truly didn't know about the abort. Fix: keep the cached session_id across abort; the SDK's session JSONL retains the interrupted partial.
2. **Cold-start sent only the new user message**, discarding pi's full conversation history — model truly had no prior context after pi restart. Fix: `buildColdStartPrompt` embeds pi's prior conversation as a `<conversation_history>` block when no resume is available.

Plus a **third bug** discovered while testing `/tree`:
3. **No history-shape divergence detection** — when pi navigates the tree to a different leaf or compacts, the SDK's resumed transcript still has the old "extra" content. Fix: `lastSentMessageHashes` + `detectHistoryDivergence` checks for prefix-mismatch and forces cold-start when divergence is detected.

| # | Scenario | Status | What the model actually said (probe response) |
|---|---|---|---|
| S0 | text multi-turn | **PASS** | recalls "137" + identifies as prime |
| S1 | single tool round-trip | **PASS** | T2 reused tool result, no re-call (`mcp handler: read [...] — early result, returning` confirms cache reuse path) |
| S2 | multi-step sequential tools | **PASS** | model referenced specific files from listing; 3 mcp handler invocations in 1 query |
| S3 | long-running tool (30s) | **PASS** | model quoted exact `DONE-MARKER-9F2A` from tool output |
| S4 | tool failure | **PASS** | model acknowledged "/nonexistent/path/definitely-not-here-9F2A.txt does not exist", quoted the actual error |
| S5 | mid-stream steering | **PASS** | model affirmed: *"1. First message: Write a long, detailed essay about the history of the printing press"* — REAL recall of abandoned topic |
| S6 | follow-up multi-turn | **PASS** | warm cache resume; cross-turn coherence on README content |
| S7 | abort during text (Escape) | **PASS** | model affirmed: *"The user interrupted me after I had written the meditative reflections for numbers 1-4"* |
| S8 | abort during tool | **PASS** | model affirmed: *"MCP error -32001: AbortError: The operation was aborted"* — quoted exact error |
| S9 | abort + immediate steer | **PASS** | model enumerated both: *"Original: Read every .ts file... Switched to: count the total .ts files"* |
| S10 | session resume across pi restart | **PASS** | model recalled BOTH facts after restart: *"Package name: pi-claude-bridge, Your favorite number: 137"* |
| S10b | warm cache resume (same process) | **PASS** | model recalled "octarine" |
| S11 | parallel tool_use | **PASS** | ≥2 reads; FIFO toolUseId match; both files referenced |
| S12 | long convo (8+ turns + token recall) | **PASS** | exact `XYZZY-7` recalled across 8 filler turns; 1 cold + ≥6 warm |
| S13 | rapid abort-retype (typo-fix) | **PASS** | model enumerated all three: */etc, src/, .ts files* — REAL recall |
| S14 | subagent: claude-bridge → claude-bridge | **PASS** | subagent wrote /tmp/s14-result.txt with count `3` |
| S15 | subagent: claude-bridge → openai-codex | **PASS** | parent attributed result to gpt-5.4; bridge owned only parent's session |
| S16a | pi `/fork` | **PASS** | forked branch recalled BOTH 137 + octarine — history preserved through fork |
| S16b | pi `/tree` (leaf navigation) | **PASS** | model correctly does NOT know `fremen mouse` after navigation away; `history divergence detected` log fires |
| S17 | pi `/compact` | **PASS** | exact `RUSTED-PHOENIX-7` recalled after pi-driven compaction |

## Architectural fixes that this validation forced

1. **`onAbort` no longer drops `cachedSessionId`.** Interrupted history is preserved in the SDK's session — the next turn resumes and the model sees the abort point in its transcript. Without this, S5/S7/S13 fake-pass.

2. **`startFreshQuery` calls `buildColdStartPrompt` when there's no cached session.** Pi's full prior conversation is embedded as a `<conversation_history>` block. Without this, S10 (cold restart) and S16a (fork) silently work mechanically but the model has no context.

3. **`startFreshQuery` runs `detectHistoryDivergence` before deciding `useResume`.** Per-message content hashes from the last sent context are compared as a prefix to the current context. If any prior position differs, we drop the cached session_id. Without this, S16b (`/tree`) silently leaks abandoned-branch content from the SDK's stale transcript.

4. **`session_id` capture happens in `consumeQuery`'s `system: init` handler**, not at end of stream. This is needed so a mid-flight supersession (S5 steer) can resume into the just-started session. Without this, fast sequential aborts lose context.

## S25 — Capture call during in-flight user turn — 2026-05-05
- Bridge commit: main
- Pi version: v0.73.0
- Model: claude-bridge/claude-haiku-4-5
- Mechanical: PASS — all 7 assertions passed
- Coherence: PASS — model reported SlowTool result accurately; turn 2 produced `WARM-RESUME-S25`
- Cache:
  - T1 (SlowTool turn, cold start): (creation=5562, read=0)
  - Capture call (independent fresh query): (creation=174, read=5562)
  - T2 (warm resume): (creation=94, read=5736)
- Notes:
  - `[Capture done] stopReason=toolUse` notification was visible in the pane (not just bridge log)
  - Capture ran concurrently with SlowTool's 10 s block; both completed normally
  - No `superseding active frame` logged — user turn unaffected
  - `caching session=3e196239` appeared only once (from T1); capture path emitted zero `caching session=` lines
  - T2 warm-resumed on `session=3e196239` confirming `cachedSessionId` was not mutated by the capture call

```
A1: PASS — SlowTool mid-execution observed (mcp handler: SlowTool.*awaiting pi)
A2: PASS — capture call completed (runCaptureQuery: done in bridge log)
A3: PASS — no 'superseding active frame'
A4: PASS — exactly 1 new caching session= line
A5: PASS — original user turn completed normally
A6: PASS — turn 2 warm-resumed on session=3e196239
A7: PASS — turn 2 produced WARM-RESUME-S25
```

## S26 — claude-p warm-resume cache shape (HARD GATE G4) — 2026-06-01 — **FAIL**
- Branch: `replan-driver-from-phase-0`
- Driver: claude-p 0.1.0 (interactive-PTY, design D26) · claude 2.1.159 · model claude-haiku-4-5
- Method: 6 sequential claude-p spawns (concurrency 1), pinned ~5KB `--system-prompt`,
  production isolation flags (`--strict-mcp-config`, `--setting-sources ""`,
  `--disallowedTools …`), real env (CLAUDE_CONFIG_DIR/HOME NOT overridden). Turn 1
  fresh `--session-id`; turns 2–6 `--resume` same id, only the new user msg each turn.
  Built via real `buildClaudePArgs`; usage parsed by real `ClaudePStreamParser`.
- **Mechanical: PASS** — 6/6 turns clean `result`, usage on every turn, zero flakes
  (each turn succeeded on attempt 1; `--resume` 100% reliable here).
- **Coherence: PASS** — turn 2 recalled `4242`; `--resume` restored the conversation.
- **Cache: FAIL (the gate)** — `cache_creation`=0 AND `cache_read`=0 on EVERY turn;
  `input_tokens` grew monotonically 3802→7656→11556→15496→19472→23494 (full
  transcript re-sent uncached each turn).

| turn | input | cache_creation | cache_read | output |
|------|-------|----------------|------------|--------|
| 1 (fresh)  | 3802  | 0 | 0 | 204 |
| 2 (resume) | 7656  | 0 | 0 | 332 |
| 3 (resume) | 11556 | 0 | 0 | 444 |
| 4 (resume) | 15496 | 0 | 0 | 564 |
| 5 (resume) | 19472 | 0 | 0 | 708 |
| 6 (resume) | 23494 | 0 | 0 | 828 |

- **Root cause (control experiments):** the SAME native `claude` binary engages
  prompt caching when run as `claude -p`/`--print` — `cache_creation`=50015 with
  `--model` only, and =26336 with the bridge's exact isolation flags + pinned
  system prompt. It does NOT cache when driven by claude-p's **interactive PTY**
  session. The differentiator is interactive-vs-`--print` mode — NOT the isolation
  flags and NOT the per-spawn injections (attachment/ai-title/file-history-snapshot).
- **Does NOT mandate the T4.10 fork** (strip/pin injections): injections are not the
  cause, so stripping them won't restore caching. This is a **structural blocker**:
  claude-p interactive mode emits no `cache_control` breakpoints. Fix requires
  upstream/fork changes to claude-p, OR abandoning interactive-PTY for `claude -p`
  (forbidden by D26 / constitution IV, and blocked by the T0.14 workspace-trust gate).
- **Regression vs SDK era:** S25 (SDK path) showed warm `cache_read`=5736 / delta
  `cache_creation`=94 on resume; the claude-p path loses that entirely → an O(N²)
  token-cost + latency blow-up on long sessions. **G4 blocks the cut-over.**
- Fixtures: `.spike-notes/claude-p-gate/g4-resume-cache-probe.mjs` (probe),
  `g4-cache-results.md` (full analysis + control table), `g4-cache-stream.jsonl`
  (raw 6-turn transcript with the `result.usage` lines).

## How to reproduce

```bash
cd /Users/cartwmic/git/pi-claude-bridge
git checkout refactor/sdk-native-inference-only

# Single scenario:
bash scripts/run-scenario-s7.sh

# Full battery (~25–30 minutes):
SCENARIO_TIMEOUT=240 bash scripts/run-all-scenarios.sh

# Output:
#   .test-output/scenarios/SUMMARY.md  — per-scenario PASS/FAIL with last 40 log lines on failure
#   .test-output/scenarios/sN.run.log  — full stdout/stderr per scenario
#   .test-output/scenarios/sN.bridge.log — bridge debug log (DIAG-style markers per turn)
#   .test-output/scenarios/sN.pane.log  — full tmux pane capture per scenario
```

## Honest assertion methodology

`scripts/scenario-lib.sh` provides:
- `scn_probe_response "<prompt-substring>"` — extracts ONLY the model's response to a specific probe prompt, NOT the entire pane. Uses awk to find the last occurrence of the prompt and capture the lines immediately after, stopping at pi's visual separator.
- `scn_assert_response "<prompt>" "<positive-regex>" "<negative-regex>" "<descr>"` — asserts that the response contains the positive pattern AND does NOT contain the negative pattern. Negative match short-circuits to FAIL with a quoted excerpt of the offending text. Avoids false-passes from "I wasn't interrupted" matching the word "interrupt".

## Cross-cutting invariants — verified

- **No bridge crash** across all 20 scenarios in the truth-battery run.
- **Bridge writes nothing to `~/.claude/sessions/`** — bridge has no `cc-session-io` import, no `fs.write` to that directory; verified by grepping the new `index.ts`.
- **CC `session_id` is in-memory only** — only `cachedSessionId: string | null` lives at module scope; resets on `clearSession` events, drops on detected divergence.
- **No orphan subprocesses on abort** — S8 explicitly checks `pgrep -f "sleep 120"` before/after the abort; PASS.
- **No legacy abort-surgery** — no `DIAG`, no `pendingTruncate`, no `UUID rotation` strings in any scenario's bridge log; verified by `grep -lE`.
- **Cache health** — every PASSing scenario shows the documented profile: cold-start on first turn or post-divergence event, warm-resume thereafter; cache-creation events tied 1:1 to user-visible pi events (fork, /tree, /compact, restart).

## Architecture invariants enforced by the new index.ts (post-truth-fixes)

1. No `cc-session-io` dependency.
2. No `query-state.ts`, no two-Map+index queue, no `processAssistantMessage` fallback.
3. No `syncSharedSession` Cases, no `pendingTruncate`, no UUID rotation, no `deferredUserMessages` replay.
4. **NEW: `onAbort` preserves `cachedSessionId`** — abort doesn't lose context.
5. **NEW: `buildColdStartPrompt` replays pi history** when no resume is available.
6. **NEW: `detectHistoryDivergence` cold-starts** on `/tree` / `/fork` / `/compact`.
7. **NEW: mid-flight `session_id` capture** in `consumeQuery` enables steer-then-resume.
