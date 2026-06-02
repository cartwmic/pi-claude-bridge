# Capability: claude-p-driver

Subprocess invocation of the `smithersai/claude-p` interactive-TUI driver. Owns
process lifecycle (spawn, abort, kill), claude-p flag assembly, and the
externally-observable contract between pi turns and `claude-p` invocations. The
bridge NEVER invokes the nominal `claude -p` (`--print`) surface itself —
claude-p emulates it by driving the interactive TUI in its own PTY. The bridge
delegates PTY management, ANSI terminal-probe responses, the workspace-trust
dialog, hook registration, and prompt-typing to claude-p, and reads nothing
under `~/.claude/` (events arrive on claude-p's stdout; see `transcript-stream`).

## ADDED Requirements

### Requirement: claude-p spawn with model selection

WHEN the bridge starts a fresh turn for a model registered under provider `claude-bridge`, THE driver SHALL spawn the `claude-p` binary as a subprocess whose arguments include the resolved model id via `--model`, the system prompt for this path via `--system-prompt <text>` (or `--input-file <path>` when the assembled prompt is large or multiline; verbatim on the capture path, pi-combined on the main-provider path), `--mcp-config <inline-json-or-path>` pointing at the bridge's stdio MCP shim, `--disallowedTools <native-tool-list>` enforcing constitution principle IV, isolation flags `--strict-mcp-config` and `--setting-sources ""` (forwarded to `claude`), `--permission-mode bypassPermissions`, `--session-id <pre-generated-uuid>` (fresh turns) or `--resume <cached-id>` (warm resume), `--output-format stream-json`, `--verbose`, and a `--timeout` large enough to accommodate the longest expected tool round. THE driver SHALL NOT pass `--settings` (claude-p reserves it) and SHALL NOT pass `-p`/`--print`.

#### Scenario: Fresh turn spawns one claude-p subprocess with bridged tool surface
- **WHEN** `streamSimple` enters a fresh-turn path for model `claude-sonnet-4-6`
- **THEN** the driver spawns the `claude-p` executable as a subprocess
- **AND** the arguments include `--mcp-config` pointing at the bridge's stdio MCP shim
- **AND** the arguments include `--disallowedTools` carrying the native built-in disallow set
- **AND** the arguments include `--strict-mcp-config` and `--setting-sources ""` (preventing user-global MCP servers and settings from contributing tools)
- **AND** the arguments include `--permission-mode bypassPermissions`
- **AND** the arguments include `--system-prompt <text>` (or `--input-file <path>`) with the path-appropriate system prompt content
- **AND** the arguments include `--output-format stream-json` and `--verbose`
- **AND** the arguments do NOT include `--settings`, `-p`, or `--print`
- **AND** the pi user prompt is delivered via claude-p's positional argument or `--input-file` (text content only; image content per the "Image content handling in v1" requirement)

#### Scenario: User-global MCP server isolated from the spawned driver
- **WHEN** the user has a globally-configured MCP server in `~/.claude/settings.json` (e.g. `mcp__user-tool__*`)
- **AND** the driver spawns claude-p for a pi turn
- **THEN** the spawned `claude` does not expose any `mcp__user-tool__*` tool to the model (verified by deterministic `tools/list` MCP introspection against the shim's advertised set)

#### Scenario: User-global `permissions.allow` cannot re-enable a disallowed tool
- **WHEN** the user has `~/.claude/settings.json` containing `permissions.allow: ["Bash(*)"]`
- **AND** the driver spawns claude-p for a pi turn
- **THEN** the spawned `claude` still blocks `Bash` (because `--disallowedTools` denies it AND `--setting-sources ""` excludes user settings)

### Requirement: Native tool emission is blocked via `--disallowedTools`

THE driver SHALL configure every claude-p spawn with `--disallowedTools` enumerating the bridge's native-tool disallow list, such that the bridged MCP namespace (`mcp__custom-tools__*`) is the only callable tool surface. Because claude-p reserves `--settings`, the disallow set is expressed via the `--disallowedTools` flag (forwarded to `claude`) rather than inline settings `permissions.deny`. Per constitution IV (reconciled 2026-05-31), the binding guarantee is **non-routing/non-execution**, NOT "the model never emits a native `tool_use`": the model may emit a built-in tool_use on instinct, and claude-p may emit housekeeping built-ins (`WaitForMcpServers`) — these MUST be dropped (never routed to a handler, executed, or surfaced to pi), and the advertised surface MUST be exactly the closed `mcp__custom-tools__*` set. Verified by gate G2 and surfaced at the pi-TUI level by scenario S27.

#### Scenario: Disallow list is non-empty and includes documented set
- **WHEN** the driver builds claude-p arguments for a spawn
- **THEN** the `--disallowedTools` value forbids at least `Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, `WebFetch`, `WebSearch`, `NotebookEdit`, `Agent`, `Task`, `Skill`, `ToolSearch`, `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode`, `EnterWorktree`, `ExitWorktree`, `TodoWrite`, `TaskCreate`, `TaskGet`, `TaskList`, `TaskUpdate`, `TaskOutput`, `TaskStop`, `BashOutput`, `Monitor`, `Workflow`, `ScheduleWakeup`, `CronCreate`, `CronDelete`, `CronList`, `PushNotification`, and `RemoteTrigger` (the set that empirically closes the claude 2.1.159 `system/init` roster; G2 verified — must be re-audited per claude version, task T4.7)
- **AND** the disallow set MUST NOT include any token that matches the bridge's own `mcp__custom-tools__*` namespace under `claude`'s tool-name matching (notably a bare `Mcp`/`mcp__*` entry that could suppress the bridged surface and deadlock every tool round) — the held-open MCP surface MUST survive the disallow set
- **AND** the model's only callable tool surface is EXACTLY `mcp__custom-tools__*` (closed-set; G2/T1.12 assert both that natives are refused AND that the bridged surface survives)

#### Scenario: Built-in `WaitForMcpServers` is not surfaced to pi
- **WHEN** the model emits a built-in `WaitForMcpServers` tool_use during MCP-server startup (observed in claude-p's stream)
- **THEN** the driver/stream layer does NOT surface it to pi as a tool call
- **AND** no pi tool execution is triggered for it

#### Scenario: Native-tool block is verified by emission refusal, not just `tools/list` (hard gate G2)
- **GIVEN** a user-global `~/.claude/settings.json` with `permissions.allow: ["Bash(*)"]` AND a user-global MCP server configured
- **WHEN** a turn is spawned through claude-p with the bridge's `--disallowedTools` + `--strict-mcp-config` + `--setting-sources ""`, and the model is explicitly asked to run a `Bash` command
- **THEN** deterministic `tools/list` introspection shows ONLY `mcp__custom-tools__*` (no `Bash`, no user MCP tools)
- **AND** the model's attempt to emit a `Bash` tool_use is refused (no native execution occurs)
- **AND** IF either assertion fails, constitution IV is violated and the claude-p fork (task 4.10) is required before cut-over

### Requirement: Prompt injection via claude-p input

WHEN a fresh claude-p subprocess is spawned for a pi user turn, THE driver SHALL deliver the pi user prompt to claude-p via its positional argument, `--input-file`, or stdin (text content). On cold-start (no cached driver session id), the delivered prompt carries the flattened pi history per the bridge's existing `buildColdStartPrompt` conversion contract. On warm-resume (cached driver session id valid), it carries only the new user message. For large or multiline prompts THE driver SHALL use `--input-file <path>` (a temp file under `os.tmpdir()`, cleaned up on subprocess exit) rather than the positional argument, to avoid argv limits and shell-escaping fragility.

#### Scenario: Cold-start replay
- **WHEN** the driver starts a turn with no cached driver session id
- **THEN** claude-p receives the full pi history flattened to text per the bridge's existing conversion contract
- **AND** when that text exceeds the implementation-defined size threshold (default **50 KB**, conservative vs the ~256 KB macOS argv ceiling at which the historical spike saw the prompt silently dropped) it is delivered via `--input-file <tempfile>` rather than the positional argument
- **AND** that claude-p actually accepts `--input-file` (and `--system-prompt-file` if used) is gate **G-resume-flags** — verified through claude-p, not assumed from raw `claude`

#### Scenario: Warm-resume injection
- **WHEN** the driver starts a turn with a cached driver session id matching the current pi cwd and message-hash chain
- **THEN** claude-p is spawned with `--resume <cached-session-id>` (without `--session-id`)
- **AND** the delivered prompt contains only the new user message
- **AND** no historical pi messages are re-sent

### Requirement: Cached driver session is a hint only

THE driver SHALL treat the cached driver session id as an in-memory cache hint and SHALL drop the cache on cwd change, pi history divergence (per the bridge's existing hash-chain check), `/fork`, `/compact`, restart, or any pi lifecycle event pi exposes as a divergence signal.

#### Scenario: Cwd change drops cache
- **WHEN** a new turn arrives with `context.cwd` different from the cached cwd
- **THEN** the cached driver session id is cleared
- **AND** the next claude-p spawn does not pass `--resume`

#### Scenario: History divergence drops cache
- **WHEN** the bridge detects pi history-hash divergence at the start of a turn
- **THEN** the cached driver session id is cleared and a structured log entry records the drop

### Requirement: Abort propagates to the claude-p subprocess

WHEN pi signals abort on the current turn's `AbortSignal`, THE driver SHALL deliver `SIGINT` to the claude-p **process group** (not just the claude-p pid), SHALL prevent further inference progress, and SHALL escalate to `SIGKILL` after an implementation-defined grace window if the group has not exited. Because claude-p tears down its own child via SIGTERM→SIGKILL without a graceful `/exit` and its child `claude` PTY group may survive a bare claude-p SIGKILL (per claude-p REPORT.md), THE driver SHALL target the process group and SHALL verify (and reap) that no orphaned `claude`/zmux descendant survives the abort (the "no orphan subprocesses" cross-cutting invariant; S8).

#### Scenario: Abort during model output
- **WHEN** pi aborts mid-turn while the model is streaming text
- **THEN** the driver sends `SIGINT` to the claude-p subprocess
- **AND** the active stream pushes a `done` event with `reason: "aborted"`
- **AND** the claude-p subprocess is reaped (SIGKILL after grace if needed) before the next turn starts

### Requirement: Driver never reads or writes user-global Claude config

THE driver SHALL NOT read or write any path under `~/.claude/` — including `~/.claude/settings.json`, `~/.claude/sessions/`, `~/.claude/projects/` (transcripts), `~/.claude/skills/`, `~/.claude/plugins/`, or any other subdirectory. All per-turn observation flows through claude-p's stdout (`transcript-stream`); any transcript reading is performed internally by claude-p, which the bridge treats as a black box. (This satisfies constitution III more strongly than the prior in-house-PTY plan, where the bridge read the transcript file directly under exemption (b).)

#### Scenario: Flags-and-stdout only
- **WHEN** the driver needs to configure or observe a spawn
- **THEN** configuration is passed via claude-p CLI flags and the MCP shim's `--mcp-config`
- **AND** observation is read from claude-p's stdout
- **AND** no file under `~/.claude/` is opened for read or write by the bridge

### Requirement: Unexpected driver exit surfaces as error

IF the claude-p subprocess exits with a non-success code while a turn is in flight and no terminal `result` line has been emitted on its stdout, OR IF claude-p emits an unrecoverable error (including its own `--timeout` expiry exit 124, or `SessionStartTimeout`/`StopTimeout`), THEN the driver SHALL — per the resilience layer (design D33) — bounded-retry by respawning (default ≤2 retries, short backoff, each logged at warn) since nothing was streamed to pi yet; and ONLY after retries are exhausted SHALL it push an `error` event on the active pi stream whose `errorMessage` names the exit cause and emit a structured log entry. THE driver SHALL NOT retry SILENTLY (every retry logs) and SHALL NOT retry once a `tools/call` has been routed to pi for this turn — because a side-effecting tool may have already executed, a respawn+cold-replay would re-run it; a failure after the first routed tool call falls through to the abort/late-tool-result path (D15), not the retry path. (Streaming assistant text alone does not block retry; routing a tool call does.)

#### Scenario: Transient claude-p hook-timeout is retried, not surfaced
- **WHEN** a claude-p spawn exits with `SessionStartTimeout`/`StopTimeout` (or non-zero without a terminal `result`) before any output reached pi
- **THEN** the driver respawns (bounded retries) and logs each attempt at warn
- **AND** pi sees a normal turn if a retry succeeds; only on exhausted retries does pi receive `stopReason: "error"`

#### Scenario: Driver binary missing
- **IF** `claude-p` (or the `claude` binary it requires) is not available at spawn time
- **THEN** the driver pushes an `error` event whose `errorMessage` references the missing binary
- **AND** `complete()` resolves with `stopReason === "error"`

#### Scenario: claude-p exits non-zero mid-turn
- **IF** the claude-p subprocess exits with a non-success, non-130 code while a turn is in flight and no terminal `result` line has been emitted
- **THEN** the driver pushes an `error` event whose `errorMessage` includes the exit code (e.g. 2 wrapper failure, 124 timeout)
- **AND** any cached driver session id is cleared so the next turn cold-starts

### Requirement: `--timeout` must not trip on a held tool round

THE driver SHALL set claude-p's `--timeout` such that it cannot expire while an MCP tool call is held open awaiting pi's tool execution. Because the inference driver blocks inline on the held MCP response, the wall-time of a long pi tool (S3 ≥45s, S8 120s) counts against claude-p's `--timeout` (exit 124). THE driver SHALL derive `--timeout` to exceed the maximum expected pi-tool latency plus interactive-boot overhead, OR drive abort/cancellation through pi's `AbortSignal` rather than claude-p's wall-timer. Hard gate G7 confirms whether claude-p's `--timeout` counts held-call time.

#### Scenario: Long held tool round does not trip claude-p timeout
- **WHEN** a turn runs a pi tool that takes ≥45s (S3) while the MCP call is held open
- **THEN** claude-p does NOT exit 124 (timeout) mid-tool
- **AND** the turn completes once pi delivers the tool result

---

### Requirement: Image content handling in v1

IF a pi turn's `Context.messages` contains image content blocks intended for the main-provider path, THEN the driver SHALL strip the image blocks from the delivered prompt, SHALL emit a `warn`-level log entry naming the dropped block count, AND SHALL proceed with text-only content. IF a capture-shape `complete()` call's prompt contains image content blocks, THEN the driver SHALL reject the call pre-spawn with `stopReason: "error"` and an `errorMessage` naming the v1 limitation (interactive `claude` driven via claude-p has no documented programmatic mechanism for inline image injection).

#### Scenario: Main-provider turn with image content
- **WHEN** `complete()` is invoked on the main-provider path with `context.messages` containing an image block
- **THEN** the bridge strips the image block from the delivered prompt before spawning claude-p
- **AND** a warn-level log entry records the dropped block count
- **AND** the turn proceeds with text-only content

#### Scenario: Capture call with image content
- **WHEN** `complete()` is invoked on the capture path with `context.messages` containing an image block
- **THEN** the bridge does not spawn claude-p
- **AND** the pi-ai stream emits `start` then `error` whose `errorMessage` references the v1 no-image-on-capture limitation
- **AND** `complete()` resolves with `stopReason === "error"`

### Requirement: Abort lifecycle is decoupled from claude-p completion

WHEN pi signals abort while a turn is in flight, THE driver SHALL transition the stream to `aborted` mode immediately (drain buffered complete stream-json lines, emit `done` with `reason: "aborted"`, stop reading claude-p's stdout). The driver SHALL NOT require claude-p to emit a terminal `result` before resolving the abort. IF claude-p subsequently emits output post-abort, the driver SHALL ignore it. A post-abort claude-p exit, regardless of exit code or signal, SHALL be classified as the expected termination path for that turn and SHALL NOT trigger the "unexpected driver exit" error path.

#### Scenario: Abort completes without terminal `result`
- **WHEN** pi aborts a turn and the claude-p subprocess exits via SIGINT (exit 130) without emitting a terminal `result`
- **THEN** the pi-ai stream emits `done` with `reason: "aborted"`
- **AND** the driver does NOT push an `error` event citing unexpected driver exit

#### Scenario: Late output after abort is ignored
- **WHEN** pi aborts and the stream has already emitted `done` with `reason: "aborted"`
- **AND** claude-p emits further stdout lines before exiting
- **THEN** the driver logs the late output at info level and takes no further action on the pi-ai stream

### Requirement: Abort preserves late-tool-result coherence with pi

WHEN pi signals abort while a turn is mid-tool-round (an MCP tool call is parked awaiting pi to deliver a `tool_result`), THE driver SHALL tear down the claude-p subprocess + shim per the abort lifecycle above BUT SHALL keep the bridge-side router state for that frame ALIVE (the `pendingResolvers` and `pendingResults` maps preserved) until pi's next event resolves the ambiguity. IF pi subsequently delivers a real `tool_result` for the aborted frame via the next `streamSimple()` call, THE bridge SHALL stash that result on the frame for inclusion in the next turn's cold-start replay material. IF pi sends a new user message, THE bridge SHALL drain the frame's pending resolvers synthetically and pop the frame from the active stack. IF a `clearSession` event fires before either of the above, THE bridge SHALL drain synthetically and discard. (Cold-replay reconciles an aborted mid-tool turn; the bridge never resumes a dangling-tool-use session.)

#### Scenario: Pi delivers tool_result after abort
- **WHEN** pi aborts mid-tool-round and the claude-p subprocess + shim are torn down
- **AND** pi's tool executor finishes the tool 200ms later and calls `streamSimple()` with the `tool_result`
- **THEN** the bridge captures the result in the aborted frame's `pendingResults` map
- **AND** logs the capture at info level
- **AND** the next turn's cold-start replay includes the captured `tool_result` in pi's history

#### Scenario: Pi sends new user message after abort
- **WHEN** pi aborts and the claude-p subprocess + shim are torn down
- **AND** before any `tool_result` arrives, pi sends a new user message via `streamSimple()`
- **THEN** the bridge drains the aborted frame's `pendingResolvers` synthetically (per ABORTED_TOOL_RESULT_TEXT in today's index.ts)
- **AND** pops the aborted frame from the active stack
- **AND** the new turn proceeds as a fresh-turn dispatch

### Requirement: Abort preserves the interrupted partial for next-turn recall

The SDK era recovered the interrupted-partial recall (S7 "what number did you reach before I interrupted you?", S13 enumeration) by keeping the cached session and `--resume`-ing the driver session whose JSONL retained the partial assistant message (`index.ts:1265-1313`). The claude-p replan drops the cache on abort and cold-replays pi history, which carries the aborted `AssistantMessage` but NOT necessarily the literal partial text. THEREFORE, on abort, THE bridge SHALL commit the assistant text (and any tool-call blocks) streamed so far into the aborted-turn `AssistantMessage` it hands pi, so the abandoned prefix survives in pi history and is available to the next turn's cold-replay. THIS requirement is a hard gate (G5): it SHALL be proven against the live S7 and S13 scenarios before Phase-3 SDK deletion. IF cold-replay with the committed partial still fails the coherence probe, the disposition escalates (preserve additional context, or a documented exemption per the acceptance bar).

#### Scenario: Interrupted-partial recall survives abort
- **WHEN** pi aborts a turn after the model has streamed partial text (e.g. "1, 2, 3, …")
- **THEN** the aborted `AssistantMessage` the bridge resolves to pi contains the partial text streamed so far
- **AND** the next turn's cold-replay includes that partial in pi history
- **AND** the model's next response can reference what it had reached before the interruption (S7 / S13 coherence)

### Requirement: Concurrent spawns are fully isolated (capture AND nested subagents)

WHEN two or more claude-p spawns are alive at the same time — whether a capture spawn running while a main turn's tool is parked (S25), OR a nested same-provider **subagent** where a claude-bridge parent turn is parked on a `subagent` tool-call while a claude-bridge child turn runs concurrently (S14) — EACH spawn SHALL have its OWN independent claude-p subprocess, MCP shim, in-process router state, unix socket, and `WaitForMcpServers` startup. No two concurrent spawns SHALL share a router map, socket, or correlation domain. The model `toolu_…` → parked-resolver correlation of D32 is scoped PER spawn/frame, so identical tool names+args across two concurrent frames cannot collide. (The SDK era expressed this via the per-frame `QueryFrame` context stack, `index.ts:264-299`; the claude-p replan preserves the stack but each frame now owns a full driver+shim+socket+router instance.)

#### Scenario: Nested same-provider subagent (S14) — two concurrent main spawns
- **WHEN** a claude-bridge parent turn is parked on a `subagent` tool-call and a claude-bridge child turn spawns its own claude-p concurrently
- **THEN** parent and child each have a disjoint claude-p subprocess + shim + socket + router
- **AND** neither frame's stream events nor tool-call correlations leak into the other
- **AND** both frames complete; the parent resumes correctly after the child returns

### Requirement: Respawn does not race the dying subprocess's stdout reader

WHEN the driver aborts an in-flight spawn and immediately dispatches a fresh turn (supersede / S9 abort-then-steer / S13 rapid retype), THE driver SHALL NOT spawn the replacement claude-p process until the prior subprocess's stdout reader is fully detached and its frame's `done`/abort handling has completed. The two subprocesses' stdout streams SHALL NOT interleave into the bridge's parser. (The SDK's `query.interrupt()` was synchronous; SIGINT-a-subprocess + stop-reading is asynchronous, so ordering must be explicit.)

#### Scenario: Abort-then-immediate-steer does not interleave streams
- **WHEN** pi aborts and within milliseconds sends a new user message (S9 / S13)
- **THEN** the driver detaches the aborted subprocess's stdout reader and emits its `done(aborted)` before spawning the replacement
- **AND** no event from the dying subprocess is attributed to the new turn

### Requirement: Mid-stream steer is handled by abort-and-respawn

WHEN pi delivers a new user message while a main-provider turn is still in flight (the steering scenario, S5), THE driver SHALL abort the in-flight claude-p subprocess (per the abort lifecycle above) and dispatch the steering message as a fresh turn. Because pi owns conversation history, both the abandoned-turn prefix and the steering message remain in pi's session, so the next response can accurately recall the redirection. claude-p exposes no mid-turn input channel; injecting a second message into a live TUI turn is NOT supported in v1 without a claude-p fork. IF Phase 1 finds abort-and-respawn fails S5's coherence probe against the live scenario, the disposition escalates to a claude-p fork OR a documented architectural exemption per the acceptance bar (design D-S5).

#### Scenario: Steer during text generation
- **WHEN** a main-provider turn is streaming and pi delivers a new user message before the turn completes
- **THEN** the driver aborts the in-flight claude-p subprocess
- **AND** dispatches the steering message as a fresh turn
- **AND** the next assistant response can reference both the abandoned topic and the redirection (pi history retains both user messages)

---

## Acceptance criterion quality checklist

| AC ID | Testable | Solution-free | Unambiguous | Consistent | Complete |
|---|---|---|---|---|---|
| claude-p-driver.claude-p-spawn-with-model-selection | [ ] | [ ] | [ ] | [ ] | [ ] |
| claude-p-driver.native-tool-emission-is-blocked-via-disallowedtools | [ ] | [ ] | [ ] | [ ] | [ ] |
| claude-p-driver.prompt-injection-via-claude-p-input | [ ] | [ ] | [ ] | [ ] | [ ] |
| claude-p-driver.cached-driver-session-is-a-hint-only | [ ] | [ ] | [ ] | [ ] | [ ] |
| claude-p-driver.abort-propagates-to-the-claude-p-subprocess | [ ] | [ ] | [ ] | [ ] | [ ] |
| claude-p-driver.driver-never-reads-or-writes-user-global-claude-config | [ ] | [ ] | [ ] | [ ] | [ ] |
| claude-p-driver.unexpected-driver-exit-surfaces-as-error | [ ] | [ ] | [ ] | [ ] | [ ] |
| claude-p-driver.image-content-handling-in-v1 | [ ] | [ ] | [ ] | [ ] | [ ] |
| claude-p-driver.abort-lifecycle-is-decoupled-from-claude-p-completion | [ ] | [ ] | [ ] | [ ] | [ ] |
| claude-p-driver.abort-preserves-late-tool-result-coherence-with-pi | [ ] | [ ] | [ ] | [ ] | [ ] |
| claude-p-driver.abort-preserves-the-interrupted-partial-for-next-turn-recall | [ ] | [ ] | [ ] | [ ] | [ ] |
| claude-p-driver.concurrent-spawns-are-fully-isolated-capture-and-nested-subagents | [ ] | [ ] | [ ] | [ ] | [ ] |
| claude-p-driver.respawn-does-not-race-the-dying-subprocesss-stdout-reader | [ ] | [ ] | [ ] | [ ] | [ ] |
| claude-p-driver.timeout-must-not-trip-on-a-held-tool-round | [ ] | [ ] | [ ] | [ ] | [ ] |
| claude-p-driver.mid-stream-steer-is-handled-by-abort-and-respawn | [ ] | [ ] | [ ] | [ ] | [ ] |
