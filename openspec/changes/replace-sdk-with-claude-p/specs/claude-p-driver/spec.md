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

THE driver SHALL configure every claude-p spawn with `--disallowedTools` enumerating the bridge's native-tool disallow list, such that the bridged MCP namespace (`mcp__custom-tools__*`) is the only callable tool surface. Because claude-p reserves `--settings`, the disallow set is expressed via the `--disallowedTools` flag (forwarded to `claude`) rather than inline settings `permissions.deny`.

#### Scenario: Disallow list is non-empty and includes documented set
- **WHEN** the driver builds claude-p arguments for a spawn
- **THEN** the `--disallowedTools` value forbids at least `Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, `Agent`, `WebFetch`, `WebSearch`, `TodoWrite`, `EnterPlanMode`, `ExitPlanMode`, `Skill`, `ToolSearch`, `AskUserQuestion`, `ScheduleWakeup`, `TaskOutput`, `TaskStop`, `BashOutput`, `Monitor`, and `Mcp`
- **AND** the model's only callable tool surface is `mcp__custom-tools__*`

#### Scenario: Built-in `WaitForMcpServers` is not surfaced to pi
- **WHEN** the model emits a built-in `WaitForMcpServers` tool_use during MCP-server startup (observed in claude-p's stream)
- **THEN** the driver/stream layer does NOT surface it to pi as a tool call
- **AND** no pi tool execution is triggered for it

### Requirement: Prompt injection via claude-p input

WHEN a fresh claude-p subprocess is spawned for a pi user turn, THE driver SHALL deliver the pi user prompt to claude-p via its positional argument, `--input-file`, or stdin (text content). On cold-start (no cached driver session id), the delivered prompt carries the flattened pi history per the bridge's existing `buildColdStartPrompt` conversion contract. On warm-resume (cached driver session id valid), it carries only the new user message. For large or multiline prompts THE driver SHALL use `--input-file <path>` (a temp file under `os.tmpdir()`, cleaned up on subprocess exit) rather than the positional argument, to avoid argv limits and shell-escaping fragility.

#### Scenario: Cold-start replay
- **WHEN** the driver starts a turn with no cached driver session id
- **THEN** claude-p receives the full pi history flattened to text per the bridge's existing conversion contract
- **AND** when that text exceeds the implementation-defined size threshold (default 200 KB) it is delivered via `--input-file <tempfile>` rather than the positional argument

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

WHEN pi signals abort on the current turn's `AbortSignal`, THE driver SHALL deliver `SIGINT` to the claude-p subprocess (which returns exit code 130 and tears down its own PTY and `claude` child), SHALL prevent further inference progress, and SHALL escalate to `SIGKILL` after an implementation-defined grace window if the subprocess has not exited.

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

IF the claude-p subprocess exits with a non-success code while a turn is in flight and no terminal `result` line has been emitted on its stdout, OR IF claude-p emits an unrecoverable error (including its own `--timeout` expiry, exit code 124), THEN the driver SHALL push an `error` event on the active pi stream whose `errorMessage` names the exit cause (exit code, signal, or claude-p error) and SHALL emit a structured log entry; THE driver SHALL NOT silently retry.

#### Scenario: Driver binary missing
- **IF** `claude-p` (or the `claude` binary it requires) is not available at spawn time
- **THEN** the driver pushes an `error` event whose `errorMessage` references the missing binary
- **AND** `complete()` resolves with `stopReason === "error"`

#### Scenario: claude-p exits non-zero mid-turn
- **IF** the claude-p subprocess exits with a non-success, non-130 code while a turn is in flight and no terminal `result` line has been emitted
- **THEN** the driver pushes an `error` event whose `errorMessage` includes the exit code (e.g. 2 wrapper failure, 124 timeout)
- **AND** any cached driver session id is cleared so the next turn cold-starts

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
| claude-p-driver.mid-stream-steer-is-handled-by-abort-and-respawn | [ ] | [ ] | [ ] | [ ] | [ ] |
