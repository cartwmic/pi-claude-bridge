# claude-p-driver Specification

## Purpose

Subprocess invocation of the `smithersai/claude-p` interactive-TUI driver.
Owns process lifecycle, flag assembly, PTY-backed prompt delivery, held-tool
rounds, abort behavior, and normalized stream events when `claude-p` is
selected. This remains default driver; direct print-mode behavior belongs to
`claude-print-driver`. Bridge reads nothing under `~/.claude/`.
## Requirements
### Requirement: claude-p spawn with model selection

WHERE `claude-p` is selected, WHEN the bridge starts a fresh turn for a `claude-bridge` model, THE driver SHALL spawn maintained `claude-p` with resolved model via `--model`, path-appropriate system prompt via `--system-prompt` or large/multiline `--system-prompt-file`, explicit shim `--mcp-config`, `--disallowedTools`, `--strict-mcp-config`, `--setting-sources ""`, `--permission-mode bypassPermissions`, `--session-id <uuid>` or `--resume <cached-id>`, `--output-format stream-json`, `--verbose`, and bridge-owned `--debug-file`; it SHALL NOT pass `--settings`, `-p`, `--print`, or `--timeout`.

#### Scenario: Fresh turn spawns one claude-p subprocess with bridged tool surface
- **WHEN** selected driver is `claude-p` and fresh turn starts
- **THEN** one `claude-p` process starts with `--mcp-config`, `--disallowedTools`, `--strict-mcp-config`, `--setting-sources ""`, `--permission-mode bypassPermissions`, model, path-appropriate prompt, session id, stream-json output, verbose, and default-on bridge-owned debug file unless documented disable env is set
- **AND** args omit `--settings`, `-p`, `--print`, and `--timeout`
- **AND** user prompt is delivered by positional argument or input file under existing text/image contract

#### Scenario: User-global MCP server isolated from interactive driver
- **WHEN** user has globally configured MCP server and selected driver is `claude-p`
- **THEN** spawned Claude exposes only bridge shim tools and no user-global MCP tools

#### Scenario: User permissions cannot re-enable disallowed native tool
- **WHEN** user settings allow a native tool and selected driver is `claude-p`
- **THEN** `--disallowedTools` plus `--setting-sources ""` keep that tool unavailable

#### Scenario: Direct selection does not spawn interactive driver
- **WHEN** selected driver is `claude-print`
- **THEN** this requirement causes no `claude-p` process to spawn

### Requirement: Native tool emission is blocked via `--disallowedTools`

THE interactive driver SHALL configure every `claude-p` spawn with `--disallowedTools` including at least `Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, `WebFetch`, `WebSearch`, `NotebookEdit`, `Agent`, `Task`, `Skill`, `ToolSearch`, `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode`, `EnterWorktree`, `ExitWorktree`, `TodoWrite`, `TaskCreate`, `TaskGet`, `TaskList`, `TaskUpdate`, `TaskOutput`, `TaskStop`, `BashOutput`, `Monitor`, `Workflow`, `ScheduleWakeup`, `CronCreate`, `CronDelete`, `CronList`, `PushNotification`, `RemoteTrigger`, `ReportFindings`, and `SendMessage`, re-audited for each supported Claude version, such that `mcp__custom-tools__*` is the only callable surface. Any native or housekeeping emission MUST be dropped and never routed, executed, or surfaced to pi, while no disallow token may suppress the bridged namespace.

#### Scenario: Current native set is closed
- **WHEN** interactive arguments are built
- **THEN** disallow list contains the enumerated minimum including `ReportFindings` and `SendMessage`
- **AND** advertised callable roster is exactly declared bridged MCP tools

#### Scenario: Built-in housekeeping is not surfaced
- **WHEN** Claude emits any native housekeeping call, including `WaitForMcpServers`
- **THEN** no pi tool call or execution is produced

#### Scenario: Native refusal is verified beyond roster introspection
- **WHEN** user settings attempt to allow a native tool and model is asked to call it
- **THEN** native operation does not execute and foreign user MCP tools remain absent

### Requirement: Driver runs the patched claude-p binary

THE driver SHALL resolve and run the patched (`claude-p-fork`) binary for every spawn (main-provider and capture paths), and the bridge SHALL be able to confirm the resolved binary carries the patch. IF the resolved binary is the unpatched upstream build, THEN the bridge SHALL emit a warn-level log naming the mismatch rather than silently proceeding. The binary swap SHALL NOT introduce any write under `~/.claude/` (constitution III) and SHALL keep the native-tool disallow flags forwarded unchanged (constitution IV).

#### Scenario: Patched binary is used and verified
- **WHEN** the driver spawns claude-p on the main-provider or capture path
- **THEN** the executable run is the patched fork binary
- **AND** the bridge's identity check confirms the patch is present

#### Scenario: Stock-binary fallback is flagged
- **IF** the resolved binary is the unpatched upstream build
- **THEN** the bridge emits a warn-level log naming the mismatch (it does not silently proceed as if patched)

### Requirement: Prompt injection via claude-p input

WHEN a fresh claude-p subprocess is spawned for a pi user turn, THE driver SHALL deliver the pi user prompt to claude-p via its positional argument, `--input-file`, or stdin (text content). On cold-start (no cached driver session id), the delivered prompt carries the flattened pi history per the bridge's existing `buildColdStartPrompt` conversion contract. On warm-resume (cached driver session id valid), it carries only the new user message. For large or multiline prompts THE driver SHALL use `--input-file <path>` (a temp file under `os.tmpdir()`, cleaned up on subprocess exit) rather than the positional argument, to avoid argv limits and shell-escaping fragility.

WHEN claude-p injects the delivered prompt into the interactive `claude` session, THE driver SHALL confirm the prompt was accepted into the session before the turn advances to awaiting the `Stop` hook (per `claude-p-fork.echo-confirmed-prompt-commit`). IF the prompt cannot be confirmed accepted within the patched binary's bounded retype budget, THEN the driver SHALL surface a prompt-not-accepted error promptly, and that error SHALL be retriable by the resilience layer (design D33) when no `tools/call` has been routed for the turn — i.e. a dropped prompt under concurrent-boot contention surfaces as a real claude-p exit classified `error`, never as a silent wedge that some bridge timer must guess at.

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

#### Scenario: Prompt confirmed delivered before the turn proceeds
- **WHEN** the prompt is injected and accepted into the interactive session
- **THEN** the turn advances to await the `Stop` hook
- **AND** the bridge observes the normal turn lifecycle (stream events, then a terminal `result`)

#### Scenario: Dropped prompt surfaces fast as a real exit, not a wedge
- **IF** the injected prompt is not confirmed accepted within the patched binary's retype budget
- **THEN** the driver surfaces a prompt-not-accepted error when claude-p exits
- **AND** when no `tools/call` has been routed, the resilience layer (D33) retries the spawn

### Requirement: Cached driver session is a hint only

THE driver SHALL treat the cached driver session id as a cache hint. The hint MAY
be persisted across a process restart ONLY as a content-free fingerprint sidecar
per the `warm-pi-resume` capability (never as conversation content; constitution
Principle I). THE driver SHALL drop the cache and cold-start on cwd change, pi
history divergence (per the bridge's existing hash-chain check), `/fork`,
`/compact`, `claude` version skew, or any pi lifecycle event pi exposes as a
divergence signal. WHERE a validated resume sidecar exists on a pi
restart/resume (per `warm-pi-resume`), THE driver SHALL pass `--resume
<persisted-id>` for the first post-resume turn; otherwise (no sidecar, or
validation fails) THE driver SHALL cold-start.

#### Scenario: Cwd change drops cache
- **WHEN** a new turn arrives with `context.cwd` different from the cached cwd
- **THEN** the cached driver session id is cleared
- **AND** the next claude-p spawn does not pass `--resume`

#### Scenario: History divergence drops cache
- **WHEN** the bridge detects pi history-hash divergence at the start of a turn
- **THEN** the cached driver session id is cleared and a structured log entry records the drop

#### Scenario: Validated restart warm-resumes instead of cold-starting
- **WHEN** pi resumes a session for which a sidecar exists and validates (history prefix-match and matching `claude` version)
- **THEN** the first post-resume claude-p spawn passes `--resume <persisted-id>` and does NOT re-pack the full history

#### Scenario: Version skew on restart drops cache
- **IF** a sidecar exists on restart but its recorded `claude` version differs from the installed version
- **THEN** the cached session is dropped and the first post-resume turn cold-starts

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

THE driver SHALL classify an unexpected claude-p exit as a retriable error: IF the claude-p subprocess exits with a non-success code while a turn is in flight and no terminal `result` line has been emitted on its stdout, OR IF claude-p emits an unrecoverable error (including `SessionStartTimeout`/`StopTimeout` reported by claude-p itself), THEN the driver SHALL — per the resilience layer (design D33) — bounded-retry by respawning (default ≤2 retries, short backoff, each logged at warn) since nothing was streamed to pi yet; and ONLY after retries are exhausted SHALL it push an `error` event on the active pi stream whose `errorMessage` names the exit cause and emit a structured log entry. THE driver SHALL NOT retry SILENTLY (every retry logs) and SHALL NOT retry once a `tools/call` has been routed to pi for this turn — because a side-effecting tool may have already executed, a respawn+cold-replay would re-run it; a failure after the first routed tool call falls through to the abort/late-tool-result path (D15), not the retry path. (Streaming assistant text alone does not block retry; routing a tool call does.) THE driver SHALL NOT impose any bridge-side liveness timer or wall-clock cap on a spawn: a spawn that produces no output is recovered ONLY by a real subprocess exit (classified `error`) or by a caller-driven abort — never by a watchdog that guesses the spawn is wedged.

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
- **THEN** the driver pushes an `error` event whose `errorMessage` includes the exit code (e.g. 2 wrapper failure)
- **AND** any cached driver session id is cleared so the next turn cold-starts

#### Scenario: Silent spawn is not killed by a bridge timer
- **WHILE** a claude-p spawn has produced no stdout and no tool call has been routed
- **THEN** the bridge SHALL NOT terminate the spawn on any elapsed-time threshold
- **AND** the spawn remains recoverable only by a genuine subprocess exit or by pi's `AbortSignal`

### Requirement: Image content handling in v1

IF a main-provider turn contains image blocks, THEN THE bridge SHALL strip them, warn with dropped count, and proceed text-only. IF a capture call contains image blocks, THEN THE bridge SHALL warn, drop them, and proceed under output-capture's documented lossy text-only replay contract.

#### Scenario: Main interactive turn with image
- **WHEN** main-provider history contains an image block
- **THEN** image is stripped, warning records count, and text-only turn proceeds

#### Scenario: Interactive capture with image
- **WHEN** capture history contains image blocks
- **THEN** capture warns, drops images, and proceeds text-only

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

### Requirement: Resume Returns The Live Turn, Never A Replayed Prior Turn

WHEN the driver serves a `--resume` turn, THE driver SHALL emit a result that reflects the LIVE turn only: it SHALL gate result emission on the transcript growing past a baseline captured before the live prompt is submitted (a new assistant turn must be appended), and SHALL ignore any Stop signal received before the live prompt is submitted. IF the transcript does not grow past the baseline (no live assistant turn appears), THEN THE driver SHALL return an error rather than a replayed prior-turn result — the error surfaces to the bridge (which invalidates the session so the next turn cold-starts). (Source-level fix in the `claude-p` fork; this is why the bridge needs no stale-result detection of its own.)

#### Scenario: A replayed prior turn is never emitted as the resume result
- **WHEN** a `--resume` turn's transcript still ends at the prior turn (the live turn has not appended an assistant message) at the moment a Stop is observed
- **THEN** the driver does NOT emit the prior turn's answer — it waits for the live turn (transcript-growth gate), and if the live turn never appears it errors (the error surfaces; the bridge drops the session so the next turn cold-starts)

#### Scenario: A Stop before submit is ignored
- **WHEN** a Stop hook signal arrives before the driver has submitted the live prompt (state is not awaiting-stop)
- **THEN** the driver ignores it (records only the transcript path) and does not treat it as the turn's completion

### Requirement: Fixed claude-p fork pin

The bridge dependency graph SHALL resolve `claude-p` to fork commit `f47f71dfa34593a32cb911f617f9cf8ca1fa0073` or a later approved fork commit that preserves paste-collapse echo confirmation.

#### Scenario: Installed claude-p includes paste-collapse echo confirmation
- **WHEN** repository dependencies are installed from `package-lock.json`
- **THEN** the resolved `node_modules/claude-p` package SHALL come from `github.com/cartwmic/claude-p` at commit `f47f71dfa34593a32cb911f617f9cf8ca1fa0073`
- **AND** the installed package SHALL contain echo-confirmation handling for the normalized Ink paste-collapse marker observed as `Pastedtext#1`

#### Scenario: Dependency pin does not change bridge behavior envelope
- **WHEN** the fixed claude-p package is installed
- **THEN** the bridge SHALL continue invoking claude-p as the interactive TUI driver
- **AND** the bridge SHALL NOT add any new write under `~/.claude/`
- **AND** the bridge SHALL NOT change the native-tool disallow configuration required by Constitution IV

---

### Requirement: Interactive Held Calls Have No Upstream Idle Cutoff

WHILE an interactive invocation waits on a held bridge MCP call, THE bridge SHALL set `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0` in the Claude child environment so the default stdio-MCP idle interval cannot terminate the call.

#### Scenario: Tool exceeds upstream idle default
- **WHEN** a healthy pi tool remains held longer than Claude Code's default stdio-MCP idle interval
- **THEN** `claude-p` continues waiting until pi returns result or caller aborts

---
