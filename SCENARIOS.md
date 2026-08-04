# pi-claude-bridge — Validation Scenarios

Living feature-driven spec for real Pi TUI validation through both supported
inference drivers. Each scenario must pass with `claude-bridge` active and must
prove user-visible coherence, not only process survival.

## Binding dual-driver execution contract

`scripts/run-all-scenarios.sh` owns an explicit inventory: S0–S27 (including
S10b, S16a, and S16b), S31, and S32. It does not discover scripts by glob, so
legacy S28–S30 timeout experiments cannot silently become release gates.

```sh
npm run test:scenarios                         # default claude-print driver
CLAUDE_BRIDGE_DRIVER=claude-p npm run test:scenarios
npm run test:scenarios:drivers                 # claude-p + claude-print matrix
```

Every inventory entry runs once per selected driver with driver-qualified tmux,
bridge-log, pane-log, and result names. Missing/non-executable inventory entries
fail before execution. Exit `77` means an environment prerequisite is absent
(currently S22's optional pi-subagents extension); runner reports it as **SKIP**,
never **PASS**, and required runs exit nonzero. Exploratory local runs may opt
into `SCENARIO_ALLOW_SKIPS=1` without weakening release gates.

All scenario requirements apply equally to `claude-p` and `claude-print`:
main turns, multi-round and parallel held tools, capture, abort cleanup,
resume/cache, concurrency and nested overlap, native-tool isolation, large cold
prompts, and lifecycle coherence. Sole exception is S32: `claude-p` must render
the live read-only PTY overlay; `claude-print` must explicitly report that no
interactive PTY tail exists, open no overlay, and complete a following turn.

Older detailed rationale below may mention the removed Agent SDK as historical
context. For current behavior, "SDK query/session" maps to a selected-driver
spawn/resume hint; scripts and this execution contract are binding.

## Charter (constraints every scenario assumes)

1. **Claude Code is an inference provider only.** Tools, system prompt, and
   skills come from Pi; Pi executes all tools.
2. **All Pi features must work identically** to other providers (parity, not
   approximation).
3. **Conversation coherence is the real pass criterion.** A scenario passes
   only if, after the disruption (abort, steer, tool failure, etc.), Claude's
   *next response* demonstrates accurate recall of what happened. "We didn't
   crash" is not enough.

## Test harness shape (tmux-driven)

Each scenario follows the same shell:

```text
1. New tmux session, pane running pi against claude-bridge:
     pi --provider claude-bridge --model claude-bridge/claude-opus-4-6
2. Drive input via:    tmux send-keys -t <session>:0 '<text>' Enter
3. Capture output via: tmux capture-pane -t <session>:0 -p -S -2000
4. Apply assertions to capture (mechanical) AND read final assistant message (coherence)
5. Tear down session
```

**Key bindings (verified against pi `docs/keybindings.md`):**

| Action | Pi binding | tmux send-keys |
|---|---|---|
| Submit message | `Enter` | `Enter` |
| **Abort / cancel current turn** | **`Escape`** (`app.interrupt`) | `Escape` |
| Clear editor (NOT abort) | `Ctrl-C` (`app.clear`) | `C-c` |
| Exit pi (empty editor) | `Ctrl-D` (`app.exit`) | `C-d` |
| Queue follow-up while running | `Alt+Enter` (`app.message.followUp`) | `M-Enter` |

`Escape` and `Ctrl-C` are **different** — only `Escape` interrupts the model.
Tests must use `Escape` for aborts; using `Ctrl-C` will silently clear the
editor and never reach the bridge.

**tmux must be configured with extended keys** (`set -g extended-keys on` and
`set -g extended-keys-format csi-u`) per pi's `docs/tmux.md`, otherwise
modified-Enter and some control sequences collapse.

**Provider/model invocation** uses `provider/id` form. `--model` accepts
`claude-bridge/claude-opus-4-6` or `openai-codex/gpt-5.4` directly. Thinking
level can be appended as `:high` (e.g., `claude-bridge/claude-opus-4-6:high`).

`scripts/run-all-scenarios.sh` owns automated execution and writes
`.test-output/scenarios/SUMMARY.md` plus driver-qualified run logs.

## Canonicality decision: Pi is the source of truth

**Pi owns conversation history. A selected driver's Claude session id is a
typed, driver-bound cache hint with no semantic meaning to the bridge.** This is
the foundational architectural decision; every scenario below assumes it.

### Why pi-canonical (not Claude-canonical)

Pi's session schema is a **strict superset** of Claude's. Pi represents:
tree branching (`id`/`parentId`), `/fork`, `/tree`, `BranchSummaryEntry`,
`CompactionEntry` with `firstKeptEntryId`, `CustomMessageEntry`,
`ModelChangeEntry`, `ThinkingLevelChangeEntry`, `LabelEntry`,
`SessionInfoEntry`. None of these exist in Claude's JSONL, which is a flat
log of API calls.

If Claude were canonical we'd either lose those features or maintain a
parallel pi-side index — i.e., two sources of truth, the exact bug class
this refactor exists to eliminate. Syncing Claude's JSONL into pi's format
is worse than not syncing at all: pi's compaction (which calls the LLM with
`[system, summary, kept]` and writes a `CompactionEntry`) has no analog in
Claude's log, so any sync would have to fabricate entries that don't
correspond to anything Claude actually saw.

The constraint "we can't change how Claude behaves" does not imply
Claude-canonical. Pi supplies canonical history to the selected driver. On a
cold turn the bridge packs that history into the selected driver's prompt; on a
validated warm turn it supplies only new material with a driver-typed resume
hint. Claude Code's external transcript remains an implementation detail that
bridge code never reads or rewrites.

### Operational rules (non-negotiable)

- Pi sessions live at `~/.pi/agent/sessions/--<cwd>--/<ts>_<uuid>.jsonl`
  (v3 tree, owned by Pi's `SessionManager`).
- Claude Code owns its files under `~/.claude/`. Bridge code performs no
  transcript reads, cursor tracking, truncation, UUID rotation, or JSONL surgery.
- Every frame pins `claude-p` or `claude-print`; held results, capture, retries,
  nested work, diagnostics, and resume stay on that driver.
- Bridge may persist one content-free resume sidecar outside `~/.claude/`, keyed
  by literal cwd plus full Pi session id. It stores driver/version/session
  identifiers and one-way history fingerprints, never conversation content.
- Warm resume requires safe history-prefix extension, matching Claude version,
  and matching driver. Missing, malformed, divergent, stale, errored, or
  cross-driver hints are invalidated and canonical Pi history is replayed cold.
- Driver failure surfaces as that driver's error; bridge never falls back to the
  other driver for the same invocation.

### Compaction is Pi's job

Pi owns `/compact`, tree navigation, and branch summaries. These operations
change canonical history shape. Fingerprint divergence therefore invalidates the
resume hint and causes one cold replay; bridge code never edits Claude's
transcript to imitate Pi history.

### Cache contract (steady-state warm; bounded cold events)

Both drivers expose authoritative usage metadata. Expected outcomes:

| Event | Cache outcome |
|---|---|
| Steady-state same-driver turn | hot read |
| First turn without a valid hint | cache creation |
| Pi `/fork`, `/tree`, or `/compact` divergence | one cold replay, then warm |
| Bridge restart with valid same-driver sidecar | warm read |
| Bridge restart with invalid/missing/cross-driver sidecar | one cold replay, then warm |

Cache-creation tokens cost more than cache reads, so unexplained repeated cold
turns are regressions. Scenarios record `cache_creation_input_tokens` and
`cache_read_input_tokens` from normalized driver usage. Any bridge access to
Claude transcript files, plaintext in a resume sidecar, cross-driver resume, or
two-way transcript synchronization is a hard failure.

---

## Scenario catalog

### S0 — Baseline: text-only multi-turn

**Goal:** prove the inverted single-`query()` architecture handles the simplest
case before any tool wiring.

**Steps:**
1. Start Pi. Send: *"My favorite number is 137. Remember it."*
2. Wait for response.
3. Send: *"What two-digit number did I just give you, and is it prime?"*

**Pass:**
- Mechanical: both responses arrive without error; no duplicate or skipped
  messages in capture.
- **Coherence:** second response says "137" (or "thirty-seven" portion) and
  correctly identifies it as prime. Anything vague ("the number you mentioned")
  fails — model must recall the literal value.

---

### S1 — Single tool call round-trip

**Goal:** prove Pi's tool exec model works end-to-end. Claude requests a tool,
Pi runs it, result returns, Claude continues.

**Steps:**
1. Send: *"Use the `read` tool to read `package.json` from the current directory and tell me the value of the `name` field."*

**Pass:**
- Mechanical: exactly one `read` tool call observed in Pi's tool log; final
  assistant message contains the package name.
- **Coherence probe:** follow up with *"What did that file's `version` field say?"*
  — Claude must answer from the tool result it already has, NOT re-call the
  tool. (Tests that the tool_result is actually attached to history.)

---

### S2 — Multi-step tool plan (sequential)

**Goal:** prove the SDK's internal tool loop runs to completion in one
`query()` without bridge re-entry.

**Steps:**
1. Send: *"List the files in `src/`, then read the smallest one, then summarize it in one sentence."*

**Pass:**
- Mechanical: ≥2 tool calls in order (`list` → `read`). No interleaving with
  user input. No "I'll do that next turn" deferral.
- **Coherence probe:** *"What was the second file you considered but didn't read?"*
  — Claude must reference the listing it saw, not hallucinate.

---

### S3 — Long-running tool execution

**Goal:** prove the bridge does not time out, abort, or restart the SDK
generator while a single tool runs for >30s.

**Steps:**
1. Send: *"Run a shell command that sleeps for 45 seconds, then prints DONE-MARKER-9F2A. Confirm you saw the marker."*

**Pass:**
- Mechanical: Pi pane shows tool running for ≥45s; one tool call total; no
  reconnect/retry log lines from bridge; final assistant text contains
  `DONE-MARKER-9F2A`.
- **Coherence probe:** *"How long did that sleep take, roughly?"* — model
  should answer ~45s referencing the actual command, not guess.

---

### S4 — Tool failure handled gracefully

**Goal:** prove a tool error returns to Claude as a tool_result with
`isError: true` (or Pi's equivalent) and the model can recover.

**Steps:**
1. Send: *"Read the file `/nonexistent/path/definitely-not-here.txt` and tell me what's in it."*

**Pass:**
- Mechanical: exactly one tool call; tool_result reflects the failure; assistant
  message acknowledges the file does not exist. Bridge does not crash, does not
  silently retry, does not strip the error.
- **Coherence probe:** *"What error did you get when you tried to read it?"* —
  model should quote/paraphrase the actual error string from the tool_result.

---

### S5 — Steering mid-stream (user message arrives while assistant is responding)

**Goal:** prove the async-iterable prompt accepts a new user message during an
in-flight assistant turn and Claude integrates the steer.

**Steps:**
1. Send: *"Write me a long, detailed essay about the history of the printing press. Take your time."*
2. As soon as the first paragraph appears in the capture, send: *"Actually stop — make it about the typewriter instead."*

**Pass:**
- Mechanical: the printing-press output stops; new content about the typewriter
  begins; no duplicated tail of the original essay; conversation log shows both
  user messages.
- **Coherence probe (next turn):** *"Did I ever ask you about the printing press?"*
  — model must answer **yes** and explain it was redirected. (Tests that the
  steer didn't erase the abandoned topic from history.)

---

### S6 — Follow-up after natural completion

**Goal:** baseline multi-turn with intervening tool use.

**Steps:**
1. Send: *"Read README.md and tell me the project name."*
2. After response, send: *"Now describe the first sentence of that file in your own words."*

**Pass:**
- Mechanical: second turn either reuses cached tool result or calls `read` once
  more — both acceptable. No errors.
- **Coherence:** description matches the actual first sentence (verifiable
  from disk).

---

### S7 — User abort during text generation (Escape)

**Goal:** prove `query.interrupt()` cleanly cancels the in-flight turn and the
**next** user message produces a coherent response that knows the abort
happened. Pi's interrupt key is `Escape`, not `Ctrl-C`.

**Steps:**
1. Send: *"Count slowly from 1 to 500, one number per line."*
2. After ~10 numbers stream out, `tmux send-keys Escape`.
3. Wait 2s. Send: *"What number did you reach before I interrupted you?"*

**Pass:**
- Mechanical: counting halts; Pi shows interrupted state; new prompt accepts
  immediately (no "session busy" / no UUID rotation noise in bridge logs).
- **Coherence:** Claude reports a number ≤ what was actually displayed in the
  pane. Model knows it was interrupted. Bonus: if model says it doesn't
  remember exactly, it must still acknowledge the interruption occurred.

---

### S8 — User abort during tool execution

**Goal:** prove abort works even with a tool in flight, and Pi's tool process
is killed (no orphan).

**Steps:**
1. Send: *"Run a shell command that sleeps for 120 seconds then prints HELLO."*
2. After ~5s, `tmux send-keys Escape`.
3. Send: *"Did the sleep command finish? What did it print?"*

**Pass:**
- Mechanical: `ps` shows no orphan `sleep 120`. Bridge log shows no
  `pendingTruncateOffset` / no UUID rotation. Tool result either: (a) reaches
  Claude as an "interrupted" tool_result, or (b) is omitted with the assistant
  turn cleanly truncated — both are acceptable as long as next turn works.
- **Coherence:** Claude says the sleep did **not** finish and did **not**
  print HELLO. Must not fabricate a result.

---

### S9 — Abort then immediate steer (combined)

**Goal:** stress the boundary between abort cleanup and the next prompt.

**Steps:**
1. Send: *"Read every file in `src/` recursively and summarize each."*
2. After 2 tool calls have appeared, `tmux send-keys Escape`.
3. Within 1s, send: *"Forget that — just tell me how many files are in `src/` total."*

**Pass:**
- Mechanical: second prompt is accepted; Claude either reuses the listings it
  already has or makes a fresh `list` call. No errors. No deferred-message
  loss warnings (those should not exist after refactor).
- **Coherence:** answer reflects the actual file count; model acknowledges it
  abandoned the earlier task.

---

### S10 — Session resume across Pi restart

**Goal:** prove driver-qualified warm resume works when Pi exits and restarts.
Pi remains conversation authority; the bridge persists only a validated,
cwd-keyed resume sidecar outside `~/.claude/`. Missing, malformed, divergent,
or cross-driver hints fall back to canonical cold replay.

**Steps:**
1. Ask Claude to remember favorite number `137` and use Pi's `read` tool to
   report `package.json`'s package name.
2. Quit with `/quit` so Pi session JSONL and bridge sidecar flush cleanly.
3. Restart Pi with the saved session UUID and same selected driver.
4. Ask for both the package name and favorite number.

**Pass:**
- Mechanical: first turn is cold; restarted bridge validates its typed sidecar
  and spawns the same driver with `resume=<persisted-id>`. Pi's session JSONL
  remains untouched by bridge code; no Claude JSONL surgery occurs.
- **Coherence:** the response to the post-restart probe itself contains both
  `pi-claude-bridge` and `137` and does not disclaim memory.

### S10b — Session resume within the same pi process (warm cache)

**Goal:** counterpart to S10 that exercises the warm path — bridge stayed
alive, holds the CC session_id, and the next `query()` uses
`options.resume: <id>` to preserve cache.

**Steps:**
1. Send: *"My favorite color is octarine. Remember it."*
2. After response, send: *"What was my favorite color?"*

**Pass:**
- Mechanical: pi's token-usage display shows cache reads on turn 2 (warm
  resume). Only one Claude Code session_id observed in bridge logs across
  both turns.
- **Coherence:** answer is "octarine".

---

### S11 — Concurrent tool calls (if Pi emits parallel tool_use)

**Goal:** prove the bridge handles >1 tool_use in a single assistant message
without index-based race bugs.

**Steps:**
1. Send: *"Read both `package.json` and `tsconfig.json` in parallel and tell me one fact about each."*

**Pass:**
- Mechanical: two tool calls in one assistant message; both results delivered;
  no out-of-order matching errors. (Pre-refactor bridge fails this; this is
  the regression test for the index-based queue removal.)
- **Coherence:** Claude correctly attributes facts to the right file (no
  swap).

---

### S12 — Long conversation (cache + context behavior)

**Goal:** sanity-check that Pi's compaction/cache still works through the
bridge.

**Steps:**
1. Run 15+ turns mixing text and tool calls.
2. Mid-conversation, mention a specific token: *"My session token is XYZZY-7."*
3. After 10 more turns, send: *"What was my session token?"*

**Pass:**
- Mechanical: Pi's token-usage display shows cache hits on later turns. No
  context-overflow errors.
- **Coherence:** Claude returns `XYZZY-7` exactly.

---

### S13 — Rapid abort-and-retype (typo-fix pattern)

**Goal:** model the realistic "user fires off a message, notices a typo while
Claude is thinking/streaming, aborts, retypes, aborts again on a second
typo, retypes again." This stresses the abort path *and* the
async-iterable input path under fast back-to-back use.

**Steps:**
1. Send (with deliberate wrong content): *"List every file in `/etc` and read its contents."*
   *(intentionally over-broad — we want it to start working)*
2. As soon as Claude begins responding (thinking shown OR first text token OR
   first tool call), `tmux send-keys Escape`.
3. Within 500ms, send: *"Actually, just tell me how many files are in `src/` of this repo."*
4. As soon as Claude begins responding again, `tmux send-keys Escape`.
5. Within 500ms, send: *"Sorry — I meant: how many `.ts` files are in `src/` of this repo, and what's the largest one by line count?"*
6. Let this turn run to completion.

**Pass:**
- Mechanical:
  - Pi UI accepts both Escapes and both follow-ups without "session busy" or
    "still processing" errors.
  - Each abort observed in bridge logs as a `query.interrupt()` call (or V2
    equivalent) — not as UUID rotation, not as deferred-message replay.
  - No orphan tool subprocesses (e.g., a partial `find /etc` exec).
  - Final turn completes one or more tool calls and produces an answer.
- **Coherence probes (issue *after* step 6 finishes):**
  - *"What three different things did I ask you in this conversation?"* —
    Claude must list (a) the `/etc` listing, (b) the file-count question, and
    (c) the `.ts` file question, and acknowledge it abandoned the first two.
  - *"Did you ever read any files in `/etc`?"* — must be **no**, with no
    fabrication of contents.

This scenario is the regression test for the deferred-message-loss bug
(`index.ts:1347` in the pre-refactor bridge) and for the post-abort UUID
rotation race.

### S14 — Subagent: claude-bridge opus 4.6 → claude-bridge opus 4.6 worker

**Goal:** prove pi's `subagent` extension works when both parent and child use
the same claude-bridge model. This validates that nested `query()` instances
(or sequential session creation) don't trip the "shared session" / "single
in-flight handler" assumptions of the pre-refactor bridge.

**Setup:** parent pi launched with claude-bridge/claude-opus-4-6. The
`pi-subagents` package is already installed (verified in
`dot_pi/agent/settings.json.tmpl`).

**Steps:**
1. Send: *"Use the subagent tool to dispatch a worker (also on claude-bridge/claude-opus-4-6) to count the number of TypeScript files under `src/`. Have it write the count to `/tmp/s14-result.txt` and return the count in its message."*
2. Wait for completion.
3. Send: *"What did the subagent report, and does that match what's in `/tmp/s14-result.txt`?"*

**Pass:**
- Mechanical:
  - One `subagent` tool call observed; subagent runs to completion; returns
    a non-empty result. (Pre-existing pi-subagents bug: empty returns despite
    success — see basic-memory note `bug-pi-subagent-returns-empty-result`.
    This scenario also doubles as a regression check on whether the bridge
    contributes to that bug.)
  - Parent and subagent each have their own pi session JSONL; bridge tracks
    independent CC session_ids per `query()` instance.
  - No interleaving of parent and child stream events in the parent's UI.
- **Coherence:** the parent's answer correctly cites the subagent's reported
  number AND the file content matches.

### S15 — Subagent: claude-bridge opus 4.6 parent → openai-codex/gpt-5.4 child

**Goal:** prove that switching providers across the parent/child boundary
works — that the bridge handles the case where the SDK is only invoked for
the parent turn and the child runs on a completely different provider with no
shared cache, no shared JSONL, no shared anything.

**Steps:**
1. Send: *"Use the subagent tool to dispatch a worker on `openai-codex/gpt-5.4` to write a one-paragraph summary of what `index.ts` does in this repo. Tell it to write the summary to `/tmp/s15-summary.txt` and return the first sentence."*
2. Wait for completion.
3. Send: *"What was the first sentence the subagent returned, and which model wrote it?"*

**Pass:**
- Mechanical:
  - One `subagent` tool call; child uses `openai-codex/gpt-5.4` (verifiable
    in pi's session log: child JSONL has `provider: "openai-codex"`,
    `model: "gpt-5.4"`).
  - Bridge is **not** invoked for the child turn at all (no Claude Code
    `query()` opened for the child). If bridge logs show CC activity during
    the child run, that's a fail — bridge must only handle its own provider.
  - Parent (claude-bridge) resumes cleanly after subagent returns.
- **Coherence:** parent's answer correctly identifies the model as
  `openai-codex/gpt-5.4` (or a recognizable form like "gpt-5.4") and quotes
  the first sentence accurately.

### S16a — `/fork`: pi forks mid-conversation

**Goal:** prove the bridge correctly drops its cached CC session_id when pi
creates a fork via `/fork`. The pi tree now has two leaves; CC's flat
session can't represent both, so the bridge must replay the new leaf's
branch from scratch.

**Steps:**
1. Run S0 (favorite-number turn) and one more turn: *"And my favorite color is octarine."* Wait for response. Note the CC session_id from bridge logs.
2. In pi, run `/fork` (or trigger `app.session.fork`). This creates a new
   session file branched from the current leaf.
3. On the forked session, send: *"What did I tell you about myself?"*

**Pass:**
- Mechanical:
  - Pi creates a new session file (visible under
    `~/.pi/agent/sessions/`) with a `parentSession` field in its header
    pointing to the original.
  - Bridge issues a fresh `query()` for the forked session. Either: (a) the
    cached CC session_id is reused and works (acceptable — the message
    history up to fork point is identical, so cache may transparently
    apply), or (b) bridge cache-misses and starts fresh. Both are correct;
    what's incorrect is the bridge pre-emptively writing or rotating
    anything in `~/.claude/sessions/`.
- **Coherence:** answer mentions both the favorite number (137) and color
  (octarine) — fork preserved the full history up to the fork point.

### S16b — `/tree`: navigate to an earlier branch leaf

**Goal:** prove the bridge handles pi's `/tree` navigation. Unlike `/fork`,
`/tree` keeps the same session file but moves the leaf to a different
position in the tree. The bridge sees a different (possibly shorter or
sideways) history on the next turn.

**Steps:**
1. Run a 3-turn conversation:
   - Turn 1: *"My pet's name is Fizzgig."*
   - Turn 2: *"And my pet is a fremen mouse."*
   - Turn 3: *"What's my pet's name and species?"* (verify Claude answers correctly)
2. In pi, open `/tree` and navigate the leaf back to the entry **just
   after Turn 1's response** (so Turn 2 and Turn 3 are no longer on the
   active branch). Save/exit the tree picker.
3. On the new leaf, send: *"What's my pet's species?"*

**Pass:**
- Mechanical:
  - Pi may emit a `BranchSummaryEntry` describing the abandoned branch
    (Turns 2–3) — that's pi's job, not the bridge's.
  - Bridge replays only the active branch (Turn 1 and any
    `BranchSummaryEntry` content pi includes). Cache miss is expected;
    no error.
- **Coherence:** Claude either says it doesn't know the species (correct,
  since Turn 2 is no longer on this branch) OR — if pi's
  `BranchSummaryEntry` includes the fact — answers "fremen mouse" while
  acknowledging the source is the branch summary. Either is acceptable.
  What's NOT acceptable: confidently answering "fremen mouse" with no
  reference to the branch state, which would indicate the bridge fed a
  stale CC session id and Claude is responding from cached context that
  doesn't match pi's current leaf.

### S17 — Compaction (pi-driven)

**Goal:** prove the bridge requires zero compaction-specific code. Pi
compacts; pi feeds the bridge a shorter `[system, summary, kept]` history;
bridge replays it; everything works.

**Steps:**
1. Run a long enough conversation to trip pi's compaction threshold, OR
   manually trigger `/compact`. (Easiest path: 15-turn conversation with
   verbose tool output, then `/compact`.)
2. Within the conversation, place a known fact early enough that it
   ends up in the compacted region: *"The launch code is RUSTED-PHOENIX-7."*
3. Trigger `/compact`. Wait for pi to write the `CompactionEntry` (visible
   in pi's log; UI shows compaction completed).
4. Send: *"What was the launch code?"*

**Pass:**
- Mechanical:
  - Pi writes a `CompactionEntry` with non-empty `summary` and a valid
    `firstKeptEntryId`. The summary was generated by calling the bridge
    (claude-bridge as the LLM) — verifiable in pi's session log: there's
    an `assistant` message attributed to claude-bridge that produced the
    summary.
  - On step 4, the bridge issues a fresh `query()` with the post-compaction
    history. **No special-case code path for compaction in the bridge.**
    If you grep the bridge for "compact" / "compaction" and find handler
    code, that's a regression.
  - Cache miss is expected (history changed substantially).
- **Coherence:** Claude answers `RUSTED-PHOENIX-7` based on the summary
  (pi's summary should preserve specific tokens like the launch code).
  If pi's summary lost the fact, that's a pi bug, not a bridge bug — flag
  it but don't fail the bridge scenario unless the bridge interfered with
  pi's compaction LLM call.

### S23 — `/reload` preserves working provider registration

**Goal:** prove that `/reload` doesn't leave pi with no provider for the
bridge's models. Pi's `agent-session.reload()` calls `resetApiProviders()`
between `session_shutdown` and the re-run of extensions; the bridge must
re-register on the second module init.

**Regression class:** silent hang after `/reload`. User input is "submitted"
in the TUI, but pi has no provider for the model and never starts inference.
Originally caused by a `globalThis` Symbol guard that survived reload and
caused `pi.registerProvider` to be skipped on re-load.

**Steps:**
1. Send a normal turn; assert it produces a marker pre-reload.
2. Send `/reload`. Wait for the bridge log to show a second
   `provider: registered` line.
3. Send another turn after reload.

**Pass:**
- Mechanical:
  - `provider: registered` appears at least 2× in the bridge log.
  - `provider: skipping re-registration` is **not** present after reload.
  - A new `streamSimple: fresh query` line appears after reload.
- **Coherence:** the post-reload turn produces the requested marker token
  (proves inference actually fired, not just that the provider was wired).

### S25 — Capture call during in-flight user turn

**Goal:** prove that a pi-ai.complete() call using a single capture tool (`submit_digest`) can run concurrently with a normal user turn that has a long-running MCP tool (SlowTool, 10 s) mid-execution, without aborting or corrupting either call.

**Model:** `claude-bridge/claude-haiku-4-5`

**Extensions loaded:** `slow-tool-extension.ts` (registers `SlowTool`) + `fire-capture-extension.ts` (registers `/fire-capture` slash command whose handler calls `complete()` with `tools: [submitDigestTool]`).

**Steps:**
1. Send a prompt that causes the model to invoke `SlowTool` with `seconds=10`.
2. Once the bridge log shows `mcp handler: SlowTool [toolu_…] — awaiting pi`, issue `/fire-capture` via tmux send-keys.
3. Wait for the capture call to complete (bridge log `runCaptureQuery: done`).
4. Wait for the original user turn to complete (`SlowTool completed` in pane + `caching session=` count increments).
5. Send a second normal user prompt; assert warm-resume (`streamSimple: fresh query … resume=<session1-id>`).

**Asserted behaviors:**
- `A1` — SlowTool reaches awaiting-pi state before capture fires.
- `A2` — Capture call completes (`runCaptureQuery: done` in bridge log).
- `A3` — Zero `streamSimple: superseding active frame` lines — capture did NOT abort the user turn.
- `A4` — Exactly ONE new `caching session=` line (only from the user turn; capture path leaves `cachedSessionId` untouched).
- `A5` — Original user turn completes normally (`SlowTool completed` visible in pane).
- `A6` — Second user turn warm-resumes on the same CC session_id as turn 1.
- `A7` — Second user turn produces the requested response token (coherence: bridge still functional after concurrent capture).

### S24 — `/new` preserves working provider registration

**Goal:** prove that `/new` doesn't drop the bridge from the rebuilt
ModelRegistry. Pi's `createAgentSessionServices` builds a **fresh**
`ModelRegistry` on every session change (new, resume, fork, reload), then
re-runs extensions to populate it via `pendingProviderRegistrations`.

**Regression class:** silent fallback. After `/new`, pi falls back to the
next-available provider (e.g. `openai-codex/gpt-5.4`) instead of the
configured `claude-bridge` default — same root cause as S23 but a
different code path. The `globalThis` Symbol guard skips
`pi.registerProvider`, the new registry never receives claude-bridge
models, and `findInitialModel` falls through to `defaultModelPerProvider`.

**Steps:**
1. Send a normal turn; assert it produces a marker.
2. Send `/new`. Wait for a second `provider: registered` line.
3. Verify pi's bottom status line still shows `(claude-bridge) <model>`.
4. Send another turn; verify the bridge handles it (not a different provider).

**Pass:**
- Mechanical:
  - `provider: registered` appears at least 2× in the bridge log.
  - Post-`/new` pane shows `(claude-bridge)` as the active provider.
  - A new `streamSimple: fresh query` line appears post-`/new`.
- **Coherence:** post-`/new` turn produces the requested marker token.

**Implementation note (S23 + S24):** the fix lives in the bridge's
`session_shutdown` handler — unconditionally drop
`Symbol.for("claude-bridge:active")` so the next module init re-registers
the provider into pi's freshly-built `ModelRegistry`.

### S26 — Sustained warm prompt-cache across many turns (driver-swap regression guard)

**Goal:** prove that the claude-p driver preserves Anthropic prompt-cache
**reads** turn-over-turn, i.e. that spawning a fresh `claude-p` process per pi
turn does NOT cause a prompt-cache cold-start (cache-creation) every turn. The
prompt cache is server-side and prefix-keyed, so `--resume <id>` SHOULD yield
cache-reads across process boundaries; the risk is that claude-p's per-spawn
interactive injections (skill-listing/`attachment`, `ai-title`,
`file-history-snapshot`, dynamic system-prompt sections) perturb the cached
prefix and force creation each turn. This scenario is the regression guard for
that failure mode. **It is a NEW acceptance scenario added in the
replace-sdk-with-claude-p change; it maps to gate G4.**

**Steps:**
1. Send turn 1: *"My favorite number is 137. Acknowledge."* (cold — cache-creation expected).
2. Send turns 2–6: five short follow-ups within the cache TTL (each <5 min apart), e.g. *"and my favorite color is octarine"*, *"and my pet is a fremen mouse"*, etc.
3. Send turn 7: *"List the three facts I told you."*

**Pass:**
- Mechanical: turns 2–7 each log `cache_read_input_tokens > 0` AND
  `cache_creation_input_tokens` ≈ only the new-suffix tokens (NOT a full-prefix
  re-creation). A turn whose `cache_creation` ≈ the full running prefix while
  `cache_read` ≈ 0 is a **FAIL** — it means claude-p busted the cache prefix.
- The per-turn `(creation, read)` series must match the steady-state warm shape
  (creation on T1, reads on T2..N) — identical to what the SDK era produced.
- **Coherence:** turn 7 lists all three facts (137, octarine, fremen mouse).

**Disposition if it FAILS:** a per-turn cache-creation regression is **NOT
acceptable** (cost + latency). It triggers the claude-p fork (change task T4.10)
to pin/strip the cache-perturbing injections, OR — if unfixable — blocks the
driver swap. This is recorded as gate G4 in the change and is part of the
"all scenarios pass or documented exemption" completion bar.

### S27 — Tool-surface isolation: only pi's tools are callable, no native CC tools (tenet T4)

**Goal:** prove the bridge exposes to Claude **exactly** the tools pi passed
(`mcp__custom-tools__*`) and **no native Claude Code built-in** (Read/Write/Edit/
Bash/Glob/Grep/WebFetch/WebSearch/Task*/Skill/ToolSearch/…) can EXECUTE or reach
pi. **NEW scenario added in the replace-sdk-with-claude-p change; maps to gate G2.**

**Why this scenario is framed by introspection + non-execution, NOT by model
observation:** you cannot prove a *negative* by watching one model run — the model
emits built-in `tool_use` blocks on instinct regardless (verified historically: see
`index.ts` "built-in tool_use observed … skipping queue push", and S19), and
claude-p's own `WaitForMcpServers` built-in fires every turn. So the invariant is
**"no native tool is routed/executed or surfaced to pi"**, NOT "the model never
emits one." Asserting "zero built-in tool_use" is WRONG and will false-fail.

**Steps:**
1. Start pi with claude-bridge and a known pi tool set (e.g. just `read`).
2. Send a prompt that *tempts* a native tool: *"Use your built-in Bash tool to run `id`, and your built-in file reader to read /etc/hosts."*
3. Send a normal pi-tool turn: *"Now use the read tool to read package.json's name field."* (control — pi's tool must still work.)

**Pass:**
- **Deterministic surface check (primary):** the driver's advertised MCP `tools/list`
  for the spawn is EXACTLY `mcp__custom-tools__*` (the closed set pi passed) — no
  native tool, no user-global MCP tool. (Asserted via the bridge's introspection,
  the same check as gate G2; NOT via asking the model.)
- **Non-execution (primary):** no native tool executes — the bridge log shows zero
  `mcp handler:` invocations for any non-pi name, no file under the sandbox is
  read/written by a native tool, and `id`/`/etc/hosts` content does NOT appear from a
  native execution. If the model emitted a `Bash`/native `tool_use`, it was **dropped
  (not routed, not executed)** — that is a PASS, not a fail.
- **Housekeeping allowance:** claude-p's `WaitForMcpServers` (and equivalent CC
  internal built-ins) MAY appear in the stream; they are not surfaced to pi and do
  not count as a violation.
- **Control:** the `read` turn succeeds (pi's actual tool still works).
- **Coherence:** the model either declines the native-tool request or routes only
  through pi's `read` — and the bridge never executed a native tool.

**Disposition:** a native tool that EXECUTES or reaches pi is a tenet-T4
violation → hard fail → triggers the claude-p fork (T4.10) per gate G2. This
scenario makes the G2 guarantee visible at the pi-TUI/acceptance-bar level.

### S28 — Held tool round has no upstream idle cutoff

**Goal:** prove a long-running held tool round remains alive until Pi delivers
its result. Both drivers set `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0`; bridge adds
no inference watchdog and `claude-p` receives no `--timeout`.

**Steps:** invoke one deterministic held tool whose execution exceeds the old
idle window, then wait for its sentinel result.

**Pass:** exactly one held round routes, no watchdog/wedge/timeout machinery
appears, result is delivered, turn finalizes, and model echoes the sentinel.

### S29 — Caller abort during held tool closes cleanly and Pi recovers

**Goal:** prove selected-driver death during a held round cannot leave Pi on an
infinite spinner. Current trigger is caller-driven `Escape`; no liveness timeout
is reintroduced.

**Steps:** park one 25-second `SlowTool`, abort while it runs, wait for terminal
aborted/error evidence, then send an exact-token recovery prompt.

**Pass:** selected driver process group is signalled, dead/aborted frame closes
Pi's stream terminally, no phantom tool success appears, and recovery turn
completes coherently.

### S32 — /claude-peek live overlay (claude-peek-overlay capability)

**Goal:** prove driver-specific peek behavior without affecting inference.
For `claude-p`, the read-only PiP toggles, shows idle/live states, advances,
keeps editor focus, and never pollutes NDJSON. For `claude-print`, the command
reports explicit no-PTY-tail unavailability, opens no overlay, and a following
main turn succeeds through the direct driver.

**Setup:** `CLAUDE_BRIDGE_PEEK_DIR` pointed at a scenario-private dir (also
proves the env override), haiku, default timeouts.

**Steps:**
1. `/claude-peek` → assert overlay marker + explicit idle header.
2. Submit arithmetic prompt (`--no-wait`); poll pane for the `live` header;
   take two mid-turn captures and assert overlay content advanced.
3. Wait for the answer; assert coherence positive (correct product) +
   negative (no refusal).
4. Assert a non-trivial `*.raw` mirror file exists under the peek dir.
5. Wait on the bridge LOG for `caching session=` (turn completed + cached —
   finalize lands after the pane answer; instant grep is a false-negative).
6. `/claude-peek` again → assert overlay removed.

**Pass:** all mechanical assertions + the coherence pair. ACs:
`claude-peek-overlay.overlay-toggle-command`,
`claude-peek-overlay.live-screen-during-main-provider-turn`,
`claude-peek-overlay.explicit-idle-and-error-states`,
`claude-p-fork.write-only-pty-output-mirror`.

**Disposition:** overlay stealing focus, a garbled/stale grid presented as
live, NDJSON pollution, direct-mode overlay creation, or unusable inference
after the direct-mode notice → hard fail.

### S31 — Large cold-start prompt accepted end-to-end

**Goal:** prove a fresh `pi --no-session` session can deliver a first user
prompt above 801 bytes through either selected driver and receive a coherent
answer. On `claude-p` this retains the Ink paste-collapse regression guard for
`PromptNotAccepted`; on `claude-print` it proves large stdin frame integrity and
startup-readiness ordering.

**Setup:** default model pinned to opus for exact sentinel compliance;
`SCENARIO_MODEL` may override it. The prompt is built at runtime with a unique
`S31_SENTINEL_*` token and is the first submitted turn after `scn_pi_start`.

**Steps:**
1. Start Pi fresh with the local bridge (`pi --no-session -ne -e <repo>`).
2. Submit one large first prompt (>800 bytes, normally ~1500+ bytes) containing
   the sentinel and instructing an exact sentinel-only reply.

**Pass:**
- **Mechanical:** bridge log contains zero `PromptNotAccepted` matches.
- **Mechanical:** bridge log shows the selected driver, a cold
  `fresh spawn ... resume=no`, and at least one `caching session=` line.
- **Mechanical:** no bridge error path is recorded for the turn.
- **Coherence:** `scn_assert_response` checks the assistant response after the
  final prompt marker contains the sentinel and does NOT contain a non-delivery
  disclaimer such as "did not receive", "cannot see", or "no prompt".

**Disposition:** any failure is a hard selected-driver delivery regression. For
`claude-p`, inspect the fork's paste-collapse patch/pin; for `claude-print`,
inspect readiness gating and stream-json stdin framing.

### S33 — Direct-driver reasoning selection and visible thinking

**Goal:** prove Pi reasoning selection reaches `claude-print` as Claude CLI
`--effort`, Claude emits a thinking block, and Pi renders that block before a
distinct final answer.

**Scope:** `claude-print` only. Matrix scheduling excludes this entry for
`claude-p` so the required suite does not manufacture a known-inapplicable
skip. Direct invocation under `claude-p` exits 77 explicitly.

**Setup:** isolated `PI_CODING_AGENT_DIR` with `hideThinkingBlock=false`; model
suffix forced to `:high`; fresh private tmux server and local extension build.

**Steps:**
1. Start Pi and assert footer exposes selected `high` reasoning.
2. Submit an arithmetic prompt requiring visible calculation steps in thinking
   and a separate exact final-answer marker.
3. Wait on normal completion signal; capture pane and bridge log.

**Pass:**
- **Mechanical:** pane response contains calculation thinking before exact
  final answer; bridge log records `effort=high`, `thinking started`, selected
  `claude-print` spawn, and clean completion.
- **Coherence:** exact arithmetic marker appears as its own final answer and no
  refusal/missing-reasoning disclaimer appears.

**Disposition:** missing effort evidence, absent thinking event, hidden/dropped
thinking content, merged/out-of-order final content, or wrong driver is hard
failure.

## Per-scenario cache profile (expected cache shape)

Every scenario records `(cache_creation_tokens, cache_read_tokens)` per
turn. Expected shapes — deviations are regressions:

| Scenario | Expected cache shape (turn-by-turn) |
|---|---|
| S0 multi-turn text | T1: creation; T2: read |
| S1 single tool | T1: creation; tool-result turn: read |
| S2 multi-step tools | T1: creation; subsequent tool turns: read |
| S3 long tool | T1: creation; resume after tool: read (no cache expiry on a single 45s tool because TTL is 5 min) |
| S4 tool failure | T1: creation; recovery turn: read |
| S5 mid-stream steer | T1: creation; steer turn: read OR creation if SDK can't merge interrupted history mid-stream — note observed behavior |
| S6 follow-up | T1: creation; T2: read |
| S7 abort during text | T1: creation; post-abort turn: read (history is just the aborted assistant prefix + new user msg) |
| S8 abort during tool | T1: creation; post-abort turn: read |
| S9 abort + immediate steer | T1: creation; steer turn: read |
| S10 durable restart | first turn: creation; restarted process resumes typed sidecar and reads cache |
| S10b warm | T1: creation; T2: read |
| S11 parallel tool_use | T1: creation; result turn: read |
| S12 long convo (15+ turns) | T1: creation; T2..N: all reads (TTL must hold across turns) |
| S13 rapid abort-retype | T1: creation; both retype turns: read |
| S14 same-model subagent | parent T1: creation; subagent run is its own query → its own creation; parent resume after subagent: read |
| S15 cross-provider subagent | parent T1: creation; subagent runs on openai-codex (no CC cache involvement); parent resume: read |
| S16a /fork | turns before fork: creation→read; first turn after fork: **creation** (expected); subsequent: read |
| S16b /tree to old branch | turns on original branch: creation→read; first turn after navigate: **creation** (expected); subsequent: read |
| S17 /compact | turns before compact: creation→read; pi's summarization call: read (uses existing cache); first turn after compact: **creation** (expected); subsequent: read |
| S31 large cold-start prompt | T1: creation; response must include sentinel; no warm turns |
| S33 direct reasoning/thinking | T1: creation; response must expose thinking before exact final answer |

A scenario's cache profile is recorded in `SCENARIO_RESULTS.md` as part of
the result entry. Mismatches block the scenario from passing even if
mechanical and coherence checks succeed.

## Cross-cutting invariants (every scenario must also pass)

- **No bridge crash.** Bridge process stays up across all scenarios in a single pi session.
- **No silent message loss.** Every user message either gets a response or surfaces an error to pi's UI.
- **Pi's session JSONL stays valid.** After each scenario, pi's `~/.pi/agent/sessions/...jsonl` is replayable and parses cleanly under v3 schema.
- **Bridge writes nothing to `~/.claude/sessions/`.** Claude Code manages its own files; bridge MUST NOT read, rewrite, or truncate them.
- **Resume hints are typed cache hints, not transcript authority.** Bridge may persist its cwd-keyed sidecar outside `~/.claude/`; malformed, divergent, stale, or cross-driver hints are invalidated and canonical Pi history is replayed cold.
- **No orphan subprocesses.** `ps` shows nothing left behind from aborted tools.
- **Bridge logs are quiet.** No stack traces; no `DIAG` warnings about deferred messages, cursor regressions, UUID rotations, or `pendingTruncateOffset` (all of those code paths should be **deleted**, not silenced).
- **Use `Escape` for aborts.** `Ctrl-C` clears pi's editor and never reaches the bridge — any test using `Ctrl-C` for abort is malformed.
- **Cache health.** Every turn's `cache_read_input_tokens` and `cache_creation_input_tokens` are logged. Cache-creation events occur **only** at the events listed in the cache contract table (cold start, fork, tree, compact, restart). Any unexplained cache-creation is a bug and must be investigated, not silenced.

## How to record results

For each scenario, append to `SCENARIO_RESULTS.md` (created at first run):

```markdown
## S<N> — <name> — <YYYY-MM-DD HH:MM>
- Bridge commit: <sha>
- Pi version: <ver>
- Model: <id>
- Mechanical: PASS | FAIL — <one-line reason>
- Coherence:  PASS | FAIL — <quote of model's coherence-probe answer>
- Cache:      PASS | FAIL — <turn-by-turn (creation,read) tokens vs expected>
  - T1: (creation=N, read=M)
  - T2: (creation=N, read=M)
  - ...
- Notes: <anything weird>
```

## Scope deliberately not covered (yet)

- pi-mobile / remote scenarios
- Performance / latency targets (qualitative only for now)
