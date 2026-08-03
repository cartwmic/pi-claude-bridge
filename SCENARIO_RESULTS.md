# Scenario validation results

## Authoritative dual-driver validation — 2026-08-02

Branch: `opsx/add-claude-print-driver` at base `adba413` plus current
uncommitted implementation.

Environment:

- `claude-p@0.1.0` with Claude Code `2.1.159` from
  `/tmp/claude-2.1.159-bin/claude`
- direct `claude-print` executable `/Users/cartwmic/.local/bin/claude`
  (Claude Code `2.1.220`)
- authenticated model `claude-opus-4-6` where integration override applied
- serial scenario execution (`SCENARIO_PARALLEL=1`)

Required 32-entry inventory ran once under each selected driver:

```text
claude-p:     32 PASS, 0 SKIP, 0 FAIL, 0 TIMEOUT
claude-print: 32 PASS, 0 SKIP, 0 FAIL, 0 TIMEOUT
TOTAL:        64 PASS, 0 SKIP, 0 FAIL, 0 TIMEOUT
```

Command:

```sh
PATH=/tmp/claude-2.1.159-bin:$PATH \
CLAUDE_BIN=/Users/cartwmic/.local/bin/claude \
SCENARIO_DRIVERS='claude-p claude-print' \
SCENARIO_PARALLEL=1 SCENARIO_TIMEOUT=300 \
  scripts/run-all-scenarios.sh
```

Run completed at approximately `2026-08-02T19:29:30Z`; driver-qualified
pane, bridge, run, stderr, and debug evidence remains under
`.test-output/scenarios/`. Required environment skips were zero. A later
post-review focused S10 run passed under both drivers after strengthening its
coherence assertion to inspect only the post-restart model response.

Authenticated dual-driver RPC/lifecycle integration also passed: main text and
warm resume, multiple direct text deltas, sequential held tool, caller
abort/exact-descendant cleanup plus dangling-session warm recovery, capture
success and absent-call failure, S28 unlimited held-round idle, S29 mid-held
abort and recovery, plus 28 selected live scenario bindings including S2 and
S8. Deterministic final results: typecheck PASS, unit `497/497` PASS, full
`npm test` PASS, and build PASS. Strict OpenSpec CLI validation was
intentionally not invoked because this
change was completed under an explicit no-OpenSpec-tooling instruction; the
required manifest command remains wired in `openspec/opsx-gates.yaml`.

Historical scenario records below predate this dual-driver change and are
retained as provenance; they are not current release status.

---

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

## S26 — claude-p warm-resume cache shape (HARD GATE G4) — 2026-06-01 — **PASS** (this earlier FAIL run was a test artifact — see correction at end)

> **CORRECTION (2026-06-01):** the FAIL below was caused by an UNDERSIZED ~1.26k-token
> system prompt (the "~5KB" pinned prompt was ~1.26k tokens), BELOW Anthropic's minimum
> cacheable prefix → `claude` set no `cache_control` breakpoint. With a realistically
> LARGE stable prefix (the real bridge's pi system prompt + MCP tool defs), single-shot
> interactive claude-p `--resume` DOES cache: `cache_creation=83090` cold, `cache_read=166344`
> on a resume turn, recall OK. Control E3 (trivial prompt + tools) reproduces `cache_read=0`,
> isolating prefix SIZE as the cause. S26 = PASS provided the bridge pins a large stable
> system prompt (it does). Evidence: `.spike-notes/claude-p-gate/g4-singleshot-caching.md`.
> The original FAIL analysis below is retained for provenance but SUPERSEDED.

### [SUPERSEDED] original FAIL run (undersized prompt)
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

---

## HARD GATE G5 — abort coherence (S7/S8/S13) + T1.13/T1.14 — 2026-06-02

- Bridge commit: `0650d49` (branch `replan-driver-from-phase-0`)
- Pi version: 0.75.5
- Driver: `CLAUDE_BRIDGE_DRIVER=claude-p`; claude-p 0.1.0; model `claude-bridge/claude-haiku-4-5`
- Concurrency 1; `CLAUDE_CONFIG_DIR`/`HOME` NOT overridden; nothing committed.
- Tests: `tests/int-claude-p-abort.{sh,mjs}` (T1.13),
  `tests/int-claude-p-abort-late-tool-result.{sh,mjs}` (T1.14),
  `tests/int-claude-p-abort-coherence.mjs` (G5 / S7 / S8).

### T1.13 — abort mid-turn (mechanics) — **PASS**

- The driver SIGINTs the claude-p subprocess: debug log shows
  `onAbort[claude-p]` → `claudeP.lifecycle.abort` ("aborting claude-p (SIGINT to
  group)") → `finalizeClaudePFrame: caching session=… (aborted)`.
- The pi turn resolves **promptly** as aborted **without** waiting for a
  terminal claude-p `result`: measured `resolve-after-abort` = **7–12 ms** across
  runs (the 600 s `CLAUDE_P_TIMEOUT_SECONDS` is never approached).
- **No orphan** claude-p / claude process after the abort (ps diff vs baseline,
  20×500 ms grace).
- Stable across 2+ runs.

### G5(a) / S7 — interrupted text-partial recall — **MECHANICS PASS; PARTIAL-RECALL ESCALATED (design gap, NOT a quick fix)**

The literal S7 claim — *next turn recalls the interrupted TEXT partial (the
number it reached)* — is **NOT exercisable on the claude-p driver**. Two
empirically-pinned causes:

1. **claude-p buffers text.** `claude -p --output-format stream-json` emits the
   ENTIRE assistant turn text in ~one buffered burst. A "count to 5000" turn
   yields `highest=5000` even when aborted **0 ms after the first `text_delta`**;
   aborting at a fixed wall-clock **before** the first delta yields `highest=0`
   (empty). There is **no middle ground** — you cannot capture "reached 42 of
   500". (Probe: only **3** `text_delta` lines for a 5000-number count.) The SDK
   era streamed token-by-token, so `interrupt()` truncated a genuine partial;
   claude-p cannot.
2. **Warm-resume re-echo.** On `--resume`, claude-p replays the prior assistant
   message(s) as fresh `assistant` lines. `src/driver/stream.ts`
   `handleAssistant()` turns every `assistant`-line `text` block into a
   `text-delta` (stream.ts ~L291-295) and **cannot distinguish a replayed-history
   line from the new turn's line**, so the bridge prepends stale prior text to the
   new turn (observed: `T1="READY"`, `T2="READYNoted: 137…"`, …). When an aborted
   turn is then warm-resumed, the committed "partial" is the **stale prior text**
   (e.g. `"READY."`), and the model frequently emits `"No response requested."` /
   declines — corrupting any partial-recall probe.

The load-bearing `commitAbortedPartial` mechanism itself is **correct and
unit-proven** (`tests/unit-abort-partial.mjs`, T1.14a) and works end-to-end for
the held-TOOL case (S8). What does NOT carry over from the SDK era is
*interrupted-TEXT-partial recall via session-resume*.

The S7 test verifies the abort **mechanics that ARE achievable** for a text turn:
clean SIGINT, prompt resolves aborted (the abort itself is solid EVERY run),
next turn fresh-dispatches a marker, no orphan, no crash. The unachievable
partial-recall assertion is kept VISIBLE as a `it.skip(... [ESCALATED] ...)` so
it is not silently dropped. **Mostly-stable but occasionally flaky** (~1/4 runs
the post-abort *marker* turn hits the same warm-resume "No response requested"
degeneracy / "Agent is already processing" race and exhausts its retries) —
again the same re-echo root cause; the abort mechanics underneath never fail.

> **ESCALATION:** post-abort interrupted-TEXT-partial recall is a genuine
> capability regression vs the SDK era, rooted in (1) claude-p print-mode
> buffering and (2) the warm-resume re-echo in `src/driver/stream.ts`. A fix
> would require the driver to stream text incrementally AND to suppress the
> replayed-history assistant lines on `--resume` (or to force a **cold-replay**
> on the turn following an abort instead of warm-resuming the SIGINT-killed
> session). This is a design decision for the main agent, not a test fix.

### G5(b) / S8 — abort while blocked on a held tool — **FLAKY: ~2/3 of runs PASS, fails OUTRIGHT otherwise — shares S7's escalation**

Observed over 6 runs: **4 PASS / 2 FAIL**. Do NOT read a green S8 as
"abort-coherence is solid".

- The held-tool abort is **deterministic**: the wall-clock delay lives in pi's
  `SlowTool` (sleep 10 s), so the SIGINT lands while the model is genuinely
  blocked, no text in flight. `stopReason=aborted`, `sawToolExec=true`. **No
  orphan**; `claudeP.lifecycle.abort` present. The *mechanics* are solid every
  run — only the next-turn *coherence* is flaky.
- When it PASSes, the model conveys **non-completion** — e.g. *"No, the tool
  never ran because I did not actually invoke it."*, *"SlowTool did not
  complete—I called WaitForMcpServers instead."*, *"SlowTool is not available …
  so it never ran."*
- When it FAILs (~1/3 of runs), the warm-resume re-echo makes the model
  **FABRICATE** completion — e.g. *"SlowTool completed successfully after 10
  seconds. … SlowTool finished and returned a result after 10 seconds."* — often
  with a self-correcting clause later. The test's `fabricated` check catches this
  and fails the attempt (no fake-pass); the 5-attempt internal retry lands a
  clean attempt ~2/3 of the time and otherwise the whole test FAILS. Same root
  cause as S7 (warm-resume re-echo). Recorded as part of the G5 escalation —
  the proposed cold-replay-after-abort src fix (option b) is expected to
  stabilize this.

### T1.14 — late tool-result after abort — **PASS**

- Abort mid-tool-round (SlowTool held), then pi delivers the real tool_result via
  the next `streamSimple()`. The **Case-1 late-delivery capture** path (index.ts
  ~L1033–L1099) **was exercised** (log marker observed: the aborted-frame
  resolver matched / stream closed with "real tool result captured for next-turn
  resume").
- The capture path **does not crash** (no stack trace in the bridge log), and the
  **next user turn fresh-dispatches** and produces its marker.
- **No orphan**. Stable across 2+ runs.

### G5 cache-shape disposition (acceptance-bar record)

**Disposition: "read OR creation (cold-replay)" exemption — documented.**

On the turn following a SIGINT abort, the bridge KEEPS `cachedSessionId`
(`onAbort` deliberately does not drop it) and the next turn issues
`--resume <aborted-session-id>`. Observed: the resume **does** reuse the session
(debug: `streamSimple[claude-p]: fresh spawn … resume=<id>` with
`cache_read_input_tokens > 0` on the probe turns), i.e. it **stays warm** at the
prompt-cache level. HOWEVER, warm-resuming a SIGINT-aborted session is
**semantically degenerate** (the re-echo / "No response requested" behavior
above): the cache stays warm but the *content* is corrupted. The acceptance-bar
disposition is therefore the documented **"read OR creation (cold-replay)"
exemption**: a clean post-abort turn would require forcing a cold-replay
(cache-creation) instead of warm-resuming the aborted session — which is exactly
the escalation fix proposed for S7/S8. No unexplained cache-creation occurred;
no bridge writes to `~/.claude/sessions/`.

### How to reproduce

```bash
cd /Volumes/Workshop/git/pi-claude-bridge
npm run build
bash tests/int-claude-p-abort.sh                      # T1.13
bash tests/int-claude-p-abort-late-tool-result.sh     # T1.14
node --test tests/int-claude-p-abort-coherence.mjs    # G5 / S7 / S8
```

---

## T4.1 — pi-TUI scenario GATE (S0–S27) on claude-p — 2026-06-02 (post MCP-startup-race fix; S26+S27 added)

Branch `replan-driver-from-phase-0`. Driver = **claude-p**
(`CLAUDE_BRIDGE_DRIVER=claude-p`; claude-p concurrency 1). `npm run build` first.
`SCENARIO_TIMEOUT=480 SCENARIO_PARALLEL=1 bash scripts/run-all-scenarios.sh`.
Models: haiku-4-5 default; opus-4-7 via override (s5/s13/s14/s20). Real env —
`CLAUDE_CONFIG_DIR`/`HOME` NOT overridden, `~/.claude` untouched. NEW scripts this
run: `scripts/run-scenario-s26.sh` (G4 sustained warm-cache) +
`scripts/run-scenario-s27.sh` (G2/constitution-IV tool-surface isolation), both
auto-discovered by the runner's `run-scenario-s*.sh` glob, both cross-driver.

**The bar — EVERY scenario PASS or documented-EXEMPT — is MET.** S14 and S25 now
pass (the prior `BRIDGE-BUG` disposition is SUPERSEDED — the MCP-startup-race fix
exposes the bridge's `mcp__custom-tools__*` extension tools as callable; `tools=N`
advertised and the model routes `subagent`/`SlowTool` via `onRouterPark`).

First batch run: 24 PASS / 6 FAIL (s3, s4, s14, s20, s25, s7). Triage:
- **s3, s4, s14, s20 — FLAKE → PASS on retry-1.** All four hit a *time-clustered*
  claude-p "zero-output spawn" window (≈15:41–15:50Z): the `fresh spawn` line
  logged, then the `claude` subprocess emitted NO stream events (no usage, no
  `onRouterPark`, no `result`) for the whole scenario timeout. Once the window
  cleared (s5/s6/s8/s9 at the tail all PASSED), each FAIL re-ran clean in isolation
  on the first retry: s3 bash marker quoted (1 routing); s4 missing-file ack (1
  read); **s14 subagent routed 3× (`onRouterPark name=subagent`) + `tool-result
  delivery` — the driver-swap subagent path WORKS**; s20 FM1/FM3/no-fabrication all
  green. Transient claude-p/API spawn stall, not a bridge defect.
- **s25 — FLAKY A2 (capture sub-spawn MCP race) → PASS on retry-3 of 3.** A1/A3/A4/
  A5/A6/A7 PASS every run (capture isolation core is solid: no supersession, 1
  caching line, warm-resume on the original session, `WARM-RESUME-S25` produced).
  A2 (`runClaudePCapture: success`) is intermittent: the single-shot capture spawn
  on haiku sometimes ends in ~5s with `model did not call capture tool
  "submit_digest"` (raced the MCP attach despite the `WaitForMcpServers` preamble),
  sometimes runs ~9s and stashes the toolCall cleanly. Passed within the 3-attempt
  budget (clean run: `runClaudePCapture: success — stash synthesized toolCall …`,
  in=5988 out=1172). Watch item — see flakiness note below.
- **s7 — documented EXEMPT (exact-number recall).** Abort MECHANICS all PASS
  (`onAbort[claude-p]`, session preserved `caching session=… (aborted)`, post-abort
  warm-resume `resume=8…`); only the literal reached-number coherence fails because
  `claude --print` buffers the whole turn — no streamed "current number" to recall.

### FINAL matrix (S0–S27) — every row PASS or EXEMPT

| Scenario | Verdict | Evidence |
|---|---|---|
| S0 text multi-turn | PASS | recalls 137 + prime |
| S1 single tool round-trip | PASS | read routed (`onRouterPark name=read`); T2 reuses result |
| S2 multi-step sequential tools | PASS | referenced specific .ts files |
| S3 long-running tool (30s) | PASS (retry-1) | quoted exact `DONE-MARKER-9F2A`; 1 bash routing |
| S4 tool failure | PASS (retry-1) | acknowledged missing file; 1 read; no re-call |
| S5 mid-stream steer | PASS | onAbort; affirmed prior printing-press topic |
| S6 follow-up multi-turn | PASS | warm resume; cross-turn coherence |
| S7 abort during text (Escape) | **EXEMPT** | abort mechanics PASS; exact-number recall exempt (`--print` buffering — task-designated) |
| S8 abort during tool | PASS | onAbort; no orphan; model conveys non-completion |
| S9 abort + immediate steer | PASS | onAbort; both topics enumerated |
| S10 resume across pi restart | PASS | recalled pkg name + 137 after restart |
| S10b warm cache resume | PASS | recalled octarine |
| S11 parallel tool_use | PASS | ≥2 reads; FIFO id match |
| S12 long convo (8 turns) | PASS | 1 cold + ≥6 warm; exact `XYZZY-7` recalled |
| S13 rapid abort-retype | PASS | enumerated all three topics |
| S14 subagent claude-bridge→claude-bridge | PASS (retry-1) | subagent routed 3× via `onRouterPark name=subagent`; `tool-result delivery`; `tools=5` advertised — **prior BRIDGE-BUG SUPERSEDED** |
| S15 subagent claude-bridge→openai-codex | PASS | child dispatched; parent attributed to gpt-5.4 |
| S16a pi `/fork` | PASS | forked branch recalled 137 + octarine |
| S16b pi `/tree` navigation | PASS | `history divergence detected`; correctly forgot fremen mouse |
| S17 pi `/compact` | PASS | exact `RUSTED-PHOENIX-7` recalled |
| S18 basic-tools smoke | PASS | bash/read/write/edit each invoked; files written |
| S19 tool-id queue integrity | PASS | id↔name cross-check, 0 mismatches |
| S20 abort visibility (TDD guard) | PASS (retry-1) | onAbort + FM1 + FM3 (real post-abort tool_result) + no fabrication |
| S21 (investigate) steer during long tool | PASS (diagnostic exit-0) | bash routes; steer-without-Escape recorded non-gating |
| S22 (investigate) steer during non-bridge subagent | PASS (diagnostic exit-0) | investigation-mode dump |
| S23 `/reload` provider re-registration | PASS | provider re-registered; `POST-RELOAD-9F4` |
| S24 `/new` provider re-registration | PASS | provider re-registered; `POST-NEW-9F4` |
| S25 capture during in-flight turn | PASS (retry-3) | A1–A7 all PASS on the clean attempt; A2 capture-sub-spawn MCP race is flaky (watch item) |
| **S26 sustained warm prompt-cache (G4)** | **PASS** | NEW. 1 cold + 6 warm on 1 session; `cacheRead>0` on all 7 turns; steady-state warm shape: creation 1204→3020 (new-suffix only), read 12782→103686; turn 7 recalled all three facts (137, octarine, fremen mouse). NOT a per-turn cold re-creation. |
| **S27 tool-surface isolation (G2/const-IV)** | **PASS** | NEW. 0 native tools routed/executed (`Bash`/`Read`/… never in `onRouterPark`); model's shell request routed through pi's OWN bridged `bash` (`onRouterPark name=bash`, lowercase = `mcp__custom-tools__bash`), never native CC `Bash`; `WaitForMcpServers` not routed; no `/etc/hosts` content leaked; control `read` returned the real package name. Emission-then-dropped = PASS. |

### S26 + S27 — what they assert + claude-p verdict

**S26 (`scripts/run-scenario-s26.sh`) — G4 sustained warm prompt-cache.** Drives 1
cold + 6 sequential warm-resume turns (3 fact-plants + fillers + a recall probe)
through the bridge's real large system prompt. Asserts from the bridge log:
1 `cold-start` + ≥5 warm resumes on a SINGLE cached session id; ≥5 `usage:` lines
with `cacheRead>0` (counted via `cacheRead=[1-9][0-9]*`); coherence = turn 7 recalls
all three facts. **claude-p verdict: PASS.** Cache series (creation,read):
(1204,12782)(2454,27098)(2504,42664)(2568,58280)(2628,73960)(2688,89700)
(3020,103686) — creation tracks only the new suffix, reads grow monotonically =
prompt-cache READ sustained across process boundaries, NOT cold re-creation. This
is the pi-TUI-level G4 guarantee.

**S27 (`scripts/run-scenario-s27.sh`) — G2/constitution-IV tool-surface isolation.**
Turn 1 TEMPTS native tools ("use your built-in Bash tool to run `echo hi` … built-in
file reader to read /etc/hosts"); turn 2 is the control (pi `read` on package.json).
Asserts (cross-driver): ZERO routed/executed tools carry a native built-in name
(`Bash|Read|Write|Edit|Glob|Grep|WebFetch|WebSearch|Task|Skill|ToolSearch|…`) on
either `onRouterPark` (claude-p) or `mcp handler:` (SDK); every routed tool is a pi
tool; `WaitForMcpServers` is NOT routed to pi; no `/etc/hosts` loopback content
surfaces (non-execution); control `read` returns `pi-claude-bridge`. **claude-p
verdict: PASS** — native_routed=0, total routings=3 all pi tools. Isolation
evidence: the model's shell-command request was routed through pi's OWN bridged
`bash` tool (`onRouterPark … "name":"bash"`, lowercase, = `mcp__custom-tools__bash`),
NOT the native CC `Bash` built-in — the closed `mcp__custom-tools__*` surface held.
Emission-then-dropped of a native `tool_use` is a PASS by design (per SCENARIOS.md
S27 framing — you cannot prove the negative by watching one model run).

### Flakiness summary (this gate run)
- **Time-clustered zero-output claude-p spawns** (≈15:41–15:50Z) failed s3/s4/s14/s20
  in the batch; ALL passed clean on retry-1 once the window cleared. Symptom: `fresh
  spawn` logged, then no stream events at all until the scenario timeout. Transient
  claude-p/API spawn stall (no orphan, no bridge stack trace) — not a defect. Re-run
  any zero-output-spawn FAIL once.
- **S25 A2 capture-sub-spawn MCP race**: ~1-in-3 the single-shot capture spawn on
  haiku ends before calling `submit_digest` ("model did not call capture tool").
  Capture-isolation core (A1/A3–A7) is rock-solid. Passes within the 2-retry budget;
  flagged as a watch item, not a blocker.
- S7 fails deterministically on exact-number coherence (the documented exemption);
  its abort mechanics never fail.
- No StopTimeouts / no orphan subprocesses (PARALLEL=1). `~/.claude` untouched.

### S26/S27 watch item (capture path, non-blocking)
The S25 A2 flake is the only intermittent claude-p behavior left. It lives in the
single-shot CAPTURE path (`src/capture.ts runClaudePCapture` → `spawnClaudeP`, no
PTY re-type retry), which races the capture shim's `mcp__custom-tools__*` attach
despite the `mcpWaitPreamble` (`WaitForMcpServers`) guard. The MAIN path has a PTY
prompt re-type retry (`pty: prompt re-type attempt N`) that the capture single-shot
path lacks; adding an equivalent "no-toolcall-yet → re-prompt/extend" guard on the
capture spawn would likely stabilize A2. NOT fixed here (src untouched) — flagged
for the main agent as a hardening item, not a gate blocker.

---

## FULL pi-TUI scenario suite on the claude-p driver — 2026-06-02

Branch `replan-driver-from-phase-0`. Driver = **claude-p** (interactive-PTY,
`CLAUDE_BRIDGE_DRIVER=claude-p`). Models: haiku-4-5 default; opus-4-7 where the
override file pins it (s5/s13/s20) or where reliable tool-calling is needed.
`SCENARIO_PARALLEL=1`, real env (CLAUDE_CONFIG_DIR/HOME NOT overridden).
Bridge logs: `.test-output/scenarios/<name>.bridge.log`.

### Result matrix (S0–S27)

| Scenario | claude-p status | What the model/probe actually did |
|---|---|---|
| S0 text multi-turn | **PASS** | recalls 137 + prime; 1 cached session; cacheRead surfaced (see cache note) |
| S1 single tool round-trip | **PASS** | read routed via `onRouterPark` (name=read); T2 reused result; warm cache read=30628 |
| S2 multi-step sequential tools | **PASS** | 3 tool routings in 1 turn; referenced specific .ts files |
| S3 long-running tool (30s) | **PASS** | quoted exact `DONE-MARKER-9F2A`; no timeout |
| S4 tool failure | **PASS** | acknowledged missing file; 1 read; no re-call |
| S5 mid-stream steer | **PASS** | onAbort fired; model affirmed prior printing-press request ("Yes.") — NOT exempt; claude-p abort-and-respawn preserves the interrupted session and the model recalls the abandoned topic |
| S6 follow-up multi-turn | **PASS** | warm resume; 1 read; cross-turn coherence |
| S7 abort during text (Escape) | **EXEMPT (exact-number only)** | abort MECHANICS PASS: onAbort fired mid-turn, session preserved (`caching session=… (aborted)`), post-abort warm resume. Exact "what number did you reach" recall is exempt — claude-p `--print` buffers the whole turn into one burst, so the aborted partial has no streamed "current number" to recall |
| S8 abort during tool | **PASS** | onAbort fired; no orphan sleep subprocs (poll-for-reap fix); model knew sleep aborted, no fabricated HELLO-S8 |
| S9 abort + immediate steer | **PASS** | onAbort fired; enumerated both abandoned + current task |
| S10 resume across pi restart | **PASS** | 2 cold-starts (initial + post-restart); recalled pkg name + 137 after `--session` restart |
| S10b warm cache resume | **PASS** | 1 cold + 1 warm; recalled "octarine" |
| S11 parallel tool_use | **PASS** | 2 reads; FIFO held; both files referenced |
| S12 long convo (8 turns) | **PASS** | 1 cold + 7 warm; exact `XYZZY-7` recalled |
| S13 rapid abort-retype | **PASS** | 2 onAbort events; enumerated all three topics (/etc, src, .ts) |
| S14 subagent claude-bridge→claude-bridge | **BRIDGE-BUG** | model emits the subagent tool-call as *literal text JSON* instead of invoking it; bridge router never sees it (0 routings). Extension-registered tools not exposed as callable on claude-p (see Bridge Bug below). SDK path PASSES identically. |
| S15 subagent claude-bridge→openai-codex | **PASS** | subagent dispatched (wrote /tmp/s15-summary.txt), parent attributed to gpt-5.4, bridge owned only the parent's 1 session. (Functionally works because the child ran outside the bridge.) |
| S16a pi `/fork` | **PASS** | 2 session files; forked branch recalled BOTH 137 + octarine |
| S16b pi `/tree` navigation | **PASS** | `history divergence detected` fired; ≥2 cold-starts; model correctly did NOT claim "fremen mouse" |
| S17 pi `/compact` | **PASS** | exact `RUSTED-PHOENIX-7` recalled after compaction; no compaction-specific bridge code |
| S18 basic-tools smoke | **PASS** | bash/read/write/edit each invoked once; files written; 1 session |
| S19 tool-id queue integrity | **PASS** | 2 routed calls cross-checked against pi's id↔name JSONL (via `onRouterPark` piId+name); 0 mismatches |
| S20 abort visibility (TDD guard) | **PASS** | onAbort + FM1 (`pushAbortedError[claude-p]: pi was awaiting tool result`) + FM3 (real post-abort tool_result) + no fabrication; coherence accepts the claude-p "command never ran" framing |
| S21 (investigate) steer during long tool | **PASS (diagnostic, exit 0)** | investigation-mode timeline dump; bash tool (builtin) routes fine; steer-without-Escape produced no onAbort on claude-p (recorded, non-gating) |
| S22 (investigate) steer during non-bridge subagent | **BLOCKED (setup)** | hits the same subagent custom-tool bug as S14 — parent can't dispatch the subagent through the bridge, so the repro setup never reaches `awaiting pi` and the script early-exits 0. Investigation-mode; assertions could not be exercised on claude-p |
| S23 `/reload` provider re-registration | **PASS** | provider re-registered (count=2); post-reload turn produced `POST-RELOAD-9F4` |
| S24 `/new` provider re-registration | **PASS** | provider re-registered; active provider still claude-bridge; produced `POST-NEW-9F4` |
| S25 capture during in-flight turn | **BRIDGE-BUG (A1/A5)** | capture-isolation core PASSES on claude-p: A2 (`runClaudePCapture: success`), A3 (no supersession), A4 (1 caching line — cachedSessionId not mutated), A6 (warm-resume on original session), A7 (`WARM-RESUME-S25`). A1/A5 fail because the SlowTool (extension-registered) is not exposed as callable on claude-p — model reports "No SlowTool available" — same root cause as S14. SDK path PASSES all 7. |

S26/S27 are not part of the scenario `scripts/` set (S26 documented separately above as the G4 cache gate). The script suite runs S0–S25 + s21/s22-investigate.

### Tally
- **PASS: 22** — S0,S1,S2,S3,S4,S5,S6,S8,S9,S10,S10b,S11,S12,S13,S15,S16a,S16b,S17,S18,S19,S20,S23,S24
- **PASS (diagnostic exit-0): S21-investigate**
- **EXEMPT (documented): S7** (exact-number recall only — abort mechanics pass)
- **BRIDGE-BUG: S14, S25** (+ **S22-investigate** blocked by the same bug) — extension-registered custom tools not exposed as callable on the claude-p path

### EXEMPTIONS (rationale)

**S7 — exact-number recall after mid-text abort.** claude-p drives `claude --print`,
which buffers the entire turn and emits it as one burst at completion (the bridge's
`usage:` line appears only at turn-end, never mid-stream — confirmed in s7.bridge.log:
the single `usage:` line lands ~56s after spawn, after out=11094 tokens). The abort
MECHANICS work fully (onAbort fires mid-turn, the session is preserved as
`caching session=… (aborted)`, and the next turn warm-resumes on it). But because the
model never *streamed* an incremental "current number" to the user before the buffered
burst was cut, there is no specific reached-number for it to recall on the resume turn.
The "was I interrupted" coherence is acceptable; only the literal exact-number recall is
exempt. This is a fundamental property of the `--print` buffering surface, not a bridge
defect. (Task-designated exemption — confirmed.)

**S5 — NOT exempt.** Although claude-p has no mid-turn injection (a steer = abort +
respawn, no in-flight steering), the architectural assertions AND the coherence probe
both PASS: onAbort fires, no deferred-replay, and the post-abort turn warm-resumes the
interrupted session so the model affirms the abandoned printing-press topic. The
abort-and-respawn model satisfies S5's acceptance bar on claude-p, so no exemption is
needed.

### Cache note (S0)
On claude-p, cacheRead across separate `claude --resume` spawns is variable for *tiny*
text turns (a small stable prefix can miss Anthropic's 5-min prompt-cache window across
process boundaries — observed cacheRead=0 on one S0 run, 38035 on another). The bridge
faithfully surfaces whatever claude reports (verified against the transcript's
`cache_read_input_tokens`). Tool-using / larger-context turns reliably cache
(S1 read=30628/45362, S0 warm run read=38035). S0's `cacheRead>0` assertion can flake on
a cold prompt-cache; re-running warms it. Not a bridge plumbing defect.

### BRIDGE BUG — extension-registered custom tools not callable on claude-p (blocks S14, S25; setup-blocks S22-investigate)

**Symptom.** On the claude-p driver the model does NOT invoke pi tools that were
registered by an *extension* (`pi.registerTool`) — specifically `SlowTool`
(slow-tool-extension.ts) and `subagent` (pi-subagents). pi's *built-in* tools
(bash/read/write/edit) work fine (they route via `mcp__custom-tools__<name>` → the
bridge router → `onRouterPark`). On the **SDK** driver the very same scenarios, fixtures,
and models invoke those tools correctly (S14 SDK: `mcp handler: subagent [toolu_…] —
awaiting pi`, result delivered; S25 SDK: all 7 assertions PASS).

**Evidence (reproducible, isolated to the driver):**
- S14 claude-p (opus): 0 bridge routings; the model printed the tool call as *literal
  text* —
  `{"name":"subagent","arguments":{"agent":"builtin/general","model":"claude-bridge/claude-haiku-4-5",...}}` —
  instead of issuing a real tool call. S14 SDK (opus): `subagent invocations: 1`, PASS.
- S25 claude-p (haiku & opus): model responds "No SlowTool available. Tools I have:
  bash, read, write, edit, subagent". S25 SDK (haiku): A1 `mcp handler: SlowTool … —
  awaiting pi`, all 7 PASS.
- Tool-visibility probe (claude-p, pi-subagents loaded): asking the model to list its
  callable tools returns `mcp__custom-tools__{bash,edit,write,read,ls,grep,…}` PLUS
  `mcp__pi-subagents__subagent` and `mcp__mcp-memory__*` — i.e. the model "sees"
  extension tools under *foreign* MCP-server namespaces, not the bridge's
  `mcp__custom-tools__` server, even though the bridge passes `--strict-mcp-config` +
  `--setting-sources ""` (src/driver/claudeP.ts:209-210). Either (a) extension-registered
  tools are not being collected into the bridge's `context.tools` / `resolveMcpTools`
  toolDefs (index.ts:925-938, 1847-1851) the way the SDK collects them, so they never
  reach the bridge's MCP server; and/or (b) `--strict-mcp-config` is not isolating
  claude from the user's globally-configured MCP servers in interactive `--print` mode,
  so the model partially "knows" about pi-subagents/mcp-memory but cannot reliably call
  them through the bridge.

**Suspected src locations (for the main agent — NOT touched here):**
- `index.ts:925-938` `resolveMcpTools` / `index.ts:1847-1851` `toolDefs` construction
  (claude-p path) — confirm extension-registered tools are present in `context.tools`
  for the claude-p frame the same as the SDK frame.
- `src/driver/claudeP.ts:209-210` `--strict-mcp-config` + `--setting-sources ""` — verify
  these actually isolate interactive `--print` from `~/.claude` MCP servers; the probe
  suggests foreign MCP namespaces are visible.
- `index.ts:437` `extractAppendSystem` tool-notice hardcodes only
  `bash/read/write/edit/subagent` as example bare names — if the model is relying on this
  list (it echoed it verbatim as "tools I have"), the notice should enumerate the actual
  advertised tool set rather than a fixed example list.

This is the only blocker to an all-green claude-p suite. Built-in-tool, text, abort,
resume, fork, tree, compact, reload/new, capture-isolation, and tool-id-queue behavior
are all sound on claude-p.

### Scenario-script edits made (cross-driver; SDK path preserved via alternation)
- `scenario-lib.sh`: added `scn_tool_count_any`, `scn_tool_count_named <tool>`,
  `scn_warm_resume_count`, `scn_cold_count` — count tool routings / cold / warm across
  EITHER driver (SDK `mcp handler: <tool> [` ∪ claude-p `onRouterPark … "name":"<tool>"`;
  SDK `fresh query … resume=` ∪ claude-p `fresh spawn … resume=`).
- Tool-count asserts switched to the helpers: s1, s2, s3, s4, s6, s11, s14, s18.
- Cold/warm asserts switched to helpers: s6, s10, s10b, s12, s16b, s17.
- `onAbort:` greps → `onAbort` (matches both `onAbort:` and `onAbort[claude-p]:`): s5,
  s7, s8, s9, s13, s20, s21-investigate, s22-investigate.
- `fresh query` greps → `fresh (query|spawn)` alternation: s7, s23, s24, s25.
- `pushAbortedError: …` → `pushAbortedError(\[claude-p\])?: …` (s20).
- `runCaptureQuery: done` → `runCaptureQuery: done|runClaudePCapture: success` (s25, A2).
- S20 coherence positive regex widened to accept truthful "never ran / not executed"
  non-completion framing (valid for SDK too).
- S7 abort window now triggers off `fresh spawn|fresh query` + settle when no mid-stream
  `usage:` line exists (claude-p buffers), bailing if `caching session=` already landed.
- S8 orphan-subprocess check polls up to ~12s for the async abort-teardown reap instead
  of asserting after a fixed 2s (was racing the reap → spurious orphan FAIL).
- `|| echo 0` shell-bug (`grep -c` → "0\n0" under pipefail) replaced with `scn_grep_count`
  in: s1, s2, s3, s4, s6, s10, s10b, s11, s12, s14, s15, s17.
- S19 Python id↔name cross-check extended to the claude-p dialect (reads `piId`+`name`
  JSON fields off `onRouterPark` lines, in addition to SDK `mcp handler: <name> [<id>]`).

All alternations keep the SDK path passing (verified: S14 + S25 still PASS on
`CLAUDE_BRIDGE_DRIVER=sdk`).

### Flakiness / retries
- S0 cacheRead>0: flaked once (read=0 cold prompt-cache), passed on re-run (read=38035).
- S1: first run scn_send timed out on a slow turn-1 spawn (read count 0); clean PASS on
  re-run. Turn-1 cold-spawn latency on claude-p can exceed the warn threshold.
- S25: retried 2× — A2/A6/A7 stabilized; A1/A5 remained blocked by the custom-tool bug.
- S14: retried 1× — consistent (custom-tool bug, not a flake).
- No contention StopTimeouts observed (PARALLEL=1).

### Constraints honored
Only `scripts/**` (+ this file) edited. No `src/**` or `index.ts` changes. No commits.
`~/.claude` untouched (CLAUDE_CONFIG_DIR/HOME not overridden). `npm run build` run first.

## S5 — mid-stream steering (G6 / D-S5 disposition) — 2026-06-02 — **PASS (not an exemption)**
- Driver: claude-p (default). The in-flight spawn is aborted on the steer, the steering
  message dispatches as a FRESH turn, and the next response recalls BOTH the abandoned
  topic and the redirection (pi history retains both user messages). Verified in the
  reworked `tests/int-claude-p-abort-coherence.mjs` / scenario run.
- Disposition: **abort-and-respawn is sufficient** — no claude-p fork, no documented
  exemption needed. (D-S5.) Cache-shape on the abandoned turn is creation (cold), which
  is acceptable per the bar and inherent to abort-and-respawn.

## Completion bar — reliability note (2026-06-02)
- **Hard, deterministic gate: `npm run test:unit` (285 tests) — green, no real claude-p.**
  This is the CI gate.
- **Acceptance bar: the S0–S27 scenario suite — green-or-exempt** (S7 exact-number recall
  is the one documented exemption; all else PASS). The scenario harness retries claude-p's
  intermittent turns (`SCENARIO_PARALLEL=1` + retries), as designed.
- **Each real-claude-p integration test passes in isolation.**
- The full sequential `npm test` real-claude-p chain is subject to **claude-p 0.1.0's
  documented runtime flakiness** (missed-`Stop`-hook → StopTimeout/empty-turn; root cause
  in `.spike-notes/claude-p-gate/hang-rootcause.md`; trigger = concurrent boots, mitigated
  by `--test-concurrency=1` + per-test retries). This is the RUNTIME's limitation, not a
  bridge defect (the bridge faithfully surfaces what claude-p produces; D33 retries the
  recoverable cases). The PROPER fix is the **persistent-process** follow-up (one
  long-lived session → no per-turn boot/hook cycle); the idle-watchdog + concurrency-cap
  are optional resilience mitigations. Tracked in design.md.
