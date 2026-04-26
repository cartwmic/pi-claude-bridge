# pi-claude-bridge — Refactor Validation Scenarios

Living spec for the `refactor/sdk-native-inference-only` branch. Each scenario is
**feature-driven**: a concrete user story we must pass against the real Pi TUI
running in tmux, with `claude-bridge` as the active provider.

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

A future `scripts/run-scenarios.sh` will own automation; for now, scenarios are
executed by hand and findings recorded inline.

## Canonicality decision: Pi is the source of truth

**Pi owns conversation history. The Claude Code SDK session is an opaque
cache hint with no semantic meaning to the bridge.** This is the foundational
architectural decision; every scenario below assumes it.

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

The constraint "we can't change how Claude behaves" is true but doesn't
imply Claude-canonical — the SDK's input is an `AsyncIterable<SDKUserMessage>`
we control completely. On each `query()` we tell the SDK exactly what
history to consider. The SDK's JSONL is its own internal write; we never
have to read it.

### Operational rules (non-negotiable)

- Pi sessions live at `~/.pi/agent/sessions/--<cwd>--/<ts>_<uuid>.jsonl`
  (v3 tree, owned by pi's `SessionManager`).
- The Claude Code SDK manages its own JSONL under `~/.claude/sessions/`
  with a separate UUID. **The bridge never reads or writes that directory.**
  No `cc-session-io`, no cursor tracking, no JSONL surgery, no UUID
  rotation, no `pendingTruncateOffset`.
- The bridge keeps the SDK's `session_id` **in memory only**, passing it as
  `options.resume` on the next `query()` to preserve prompt cache.
- On any cache miss — fork, branch, compaction, restart, or `resume` failure
  for any reason — the bridge silently starts a fresh `query()` and replays
  pi's current branch as the async-iterable prompt. Cost: one cold turn.
- The bridge owns no on-disk state. Restart pi → bridge starts empty →
  first turn is a cold-resume from pi's JSONL → caches a new CC session_id
  → warm thereafter.

### Compaction is pi's job; the SDK does not auto-compact

**Verified against `code.claude.com/docs/en/agent-sdk/*` (April 2026):** the
Claude Agent SDK does **not** perform automatic conversation compaction at
the SDK level. There is no `disableAutoCompact` / `compaction` option to
configure because nothing fires by default. (Compaction at the
Messages-API level — `compact_20260112` strategy — is a separate feature
you'd opt into via the raw Anthropic SDK; the Agent SDK does not enable
it.)

This means **CC will not silently mutate our context behind our back.**
The transcript the bridge sends in is the transcript the SDK uses; what
the SDK writes to its own JSONL is exactly what we passed plus the
assistant's reply.

Pi, on the other hand, **does** auto-compact when
`contextTokens > contextWindow - reserveTokens` (or on `/compact`). Pi
generates the summary by calling the active provider (claude-bridge
included) and writes a `CompactionEntry` with `firstKeptEntryId`. After
compaction, pi feeds the LLM `[system, summary, kept messages]` — the LLM
never knows compaction happened.

The bridge handles this by accident: it just replays whatever pi gives it.
The CC session_id from before compaction will not match the new (shorter)
history, so the bridge will cold-replay once (cache-creation event), then
the new session_id is warm thereafter. **The bridge requires zero
compaction-specific code.** Any code path that special-cases compaction is
a regression.

### Cache contract (steady-state warm; bounded cold events)

The SDK uses prompt caching automatically (5-min TTL, 1h via
`ENABLE_PROMPT_CACHING_1H` env var). Cache hit/miss is determined by the
session transcript on disk in `~/.claude/sessions/`, which **the SDK owns
exclusively** (the bridge never reads or writes it).

Documented call shape for cache hits:

- **Steady-state turn:** `query({ prompt: <only new user message>, options: { resume: <cachedSessionId> } })`. The SDK loads prior turns from its own JSONL and appends. Cache-read.
- **Cold start / divergence event:** `query({ prompt: <asyncIterable replaying current pi branch>, options: {} })`. Generates a new session_id; cache-creation on the prefix. Subsequent turns on that id are warm.

Cold events are predicted exactly by user-visible pi events:

| Event | Cache outcome |
|---|---|
| Steady-state turn | hot read |
| First turn of a pi session | cache-creation (one-time) |
| Pi `/fork` | cache-creation on new branch (one-time) |
| Pi `/tree` to a different leaf | cache-creation on new active branch |
| Pi `/compact` | cache-creation on new compacted prefix |
| Bridge process restart | cache-creation on first turn after restart |

Cache-creation tokens cost 1.25× base; cache-read tokens cost 0.1× base —
"cold then warm" is a small, finite premium per divergence event, not a
per-turn regression. **Any cache-creation event NOT tied to one of the
above is a bug** and must be investigated.

Cache observability surfaces (used by every scenario below):

- TS SDK exposes per-turn `cache_read_input_tokens` and
  `cache_creation_input_tokens` on the `result` and `assistant` messages
  (`message.modelUsage[modelName].cacheReadInputTokens` /
  `.cacheCreationInputTokens`).
- Pi's TUI token-usage display (from the `pi-token-usage` package, already
  installed) renders these per turn.
- The bridge MUST log them per turn at INFO level so a scenario run can be
  graphed post-hoc.

There is no documented way to introspect *why* a cache miss occurred —
only the post-hoc token counts. This is fine because cold events are
predicted by the table above; any deviation is the regression signal.

Any scenario that shows the bridge writing to `~/.claude/sessions/`,
maintaining a session-id index file, or attempting two-way sync between pi
and CC sessions is a **fail**, regardless of whether visible behavior
looked correct.

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

**Goal:** prove SDK-native session resume works when Pi exits and restarts.
This validates the **session reconciliation principle**: pi owns history, CC
session_id is just a cache hint, and resume must work even if the cached CC
session_id is gone (cold-resume case).

**Steps:**
1. Run S1 (single tool call). Note the package name from the response.
2. Note pi's session UUID (visible in `~/.pi/agent/sessions/--<cwd>--/`).
3. `tmux send-keys 'C-d'` to quit pi (must be on empty editor — `app.exit`).
4. Restart pi: `pi --provider claude-bridge --model claude-bridge/claude-opus-4-6 --session <uuid-prefix>`
   (or `pi -c` to continue most recent in this cwd).
5. Send: *"What was the package `name` value from earlier?"*

**Pass:**
- Mechanical: pi resumes from its own JSONL; bridge starts a fresh `query()`
  and replays pi's branch as the async-iterable prompt (cold-resume — its
  in-memory CC session_id was lost when the process died, so cache miss is
  expected on the first turn). No bridge-managed JSONL is read or written.
  No errors.
- **Coherence:** Claude answers with the same package name from step 1.

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
| S10 cold restart | first turn on new pi process: creation (new session_id); T2: read |
| S10b warm | T1: creation; T2: read |
| S11 parallel tool_use | T1: creation; result turn: read |
| S12 long convo (15+ turns) | T1: creation; T2..N: all reads (TTL must hold across turns) |
| S13 rapid abort-retype | T1: creation; both retype turns: read |
| S14 same-model subagent | parent T1: creation; subagent run is its own query → its own creation; parent resume after subagent: read |
| S15 cross-provider subagent | parent T1: creation; subagent runs on openai-codex (no CC cache involvement); parent resume: read |
| S16a /fork | turns before fork: creation→read; first turn after fork: **creation** (expected); subsequent: read |
| S16b /tree to old branch | turns on original branch: creation→read; first turn after navigate: **creation** (expected); subsequent: read |
| S17 /compact | turns before compact: creation→read; pi's summarization call: read (uses existing cache); first turn after compact: **creation** (expected); subsequent: read |

A scenario's cache profile is recorded in `SCENARIO_RESULTS.md` as part of
the result entry. Mismatches block the scenario from passing even if
mechanical and coherence checks succeed.

## Cross-cutting invariants (every scenario must also pass)

- **No bridge crash.** Bridge process stays up across all scenarios in a single pi session.
- **No silent message loss.** Every user message either gets a response or surfaces an error to pi's UI.
- **Pi's session JSONL stays valid.** After each scenario, pi's `~/.pi/agent/sessions/...jsonl` is replayable and parses cleanly under v3 schema.
- **Bridge writes nothing to `~/.claude/sessions/`.** SDK manages its own files; the bridge MUST NOT read or write them. (Verifiable: stat the directory before and after; bridge process should not appear in lsof on those files.)
- **CC session_id is in-memory only.** No persistence across pi restarts beyond what the SDK itself writes. Bridge must not maintain its own session-id index file.
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

- Subagent / nested `query()` reentrance (separate spec)
- Multi-model handoff inside one Pi session
- pi-mobile / remote scenarios
- Performance / latency targets (qualitative only for now)
