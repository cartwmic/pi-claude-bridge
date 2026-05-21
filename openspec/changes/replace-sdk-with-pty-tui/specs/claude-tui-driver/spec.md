# Capability: claude-tui-driver

PTY-driven invocation of the `claude` interactive TUI binary. Owns process
lifecycle, hook configuration, session mapping, and the externally-observable
contract between pi turns and `claude` invocations.

## ADDED Requirements

### Requirement: PTY spawn with model selection

WHEN the bridge starts a fresh turn for a model registered under provider `claude-bridge`, THE driver SHALL spawn the `claude` binary inside a pseudoterminal session whose CLI arguments include the resolved model id, `--system-prompt <text>` carrying the system prompt for this path (verbatim on the capture path; pi-combined on the main-provider path), `--mcp-config <inline-json>` exposing only `mcp__custom-tools__*`, `--strict-mcp-config`, `--setting-sources ""`, `--permission-mode bypassPermissions`, `--session-id <pre-generated-uuid>`, `--settings <inline-json>` registering the bridge's hook handlers (`SessionStart` and `Stop` only), and the pi user prompt as the trailing positional argument.

#### Scenario: Fresh turn spawns one PTY with bridged tool surface
- **WHEN** `streamSimple` enters a fresh-turn path for model `claude-sonnet-4-6`
- **THEN** the driver spawns the executable `claude` attached to a pseudoterminal
- **AND** the spawned arguments include `--mcp-config` pointing at the bridge's stdio MCP shim
- **AND** the spawned arguments include `--strict-mcp-config` (preventing user-global MCP servers from contributing tools)
- **AND** the spawned arguments include `--setting-sources ""` (preventing user/project/local settings from overriding the bridge's inline config)
- **AND** the spawned arguments include `--permission-mode bypassPermissions` (preventing interactive permission dialogs)
- **AND** the spawned arguments include `--system-prompt <text>` with the path-appropriate system prompt content
- **AND** the spawned arguments include `--session-id <uuid>` with a pre-generated UUID the bridge will use to compute the transcript path deterministically (via `~/.claude/projects/<encoded-realpath-cwd>/<uuid>.jsonl` where the cwd is passed through `fs.realpathSync` before `/` → `-` encoding; see design D18)
- **AND** the spawned arguments include `--settings` carrying inline hook handlers for `SessionStart` and `Stop` only (NOT `PreToolUse` — dropped per design D9/D11)
- **AND** the spawned arguments include the disallowed-tool surface enforcing constitution principle IV
- **AND** the pi user prompt is delivered as the trailing positional CLI argument (text content only; image content is handled per the "Image content handling in v1" requirement)

#### Scenario: Transcript path is computed deterministically from the pre-generated UUID (with realpath cwd)
- **WHEN** the driver generates a UUID `<uuid>` and spawns with `--session-id <uuid>` in lexical cwd `/var/folders/.../tmp-x` (macOS) whose `fs.realpathSync` returns `/private/var/folders/.../tmp-x`
- **THEN** the bridge computes the transcript path as `~/.claude/projects/-private-var-folders-...-tmp-x/<uuid>.jsonl` (realpath cwd with `/` → `-`)
- **AND** the transcript tailer opens that path as soon as it appears on disk (parent-directory `fs.watch` for file-creation event)
- **AND** the bridge does NOT depend on the `SessionStart` hook payload carrying a `transcript_path` field for discovery

#### Scenario: User-global MCP server isolated from the spawned PTY
- **WHEN** the user has a globally-configured MCP server in `~/.claude/settings.json` (e.g. `mcp__user-tool__*`)
- **AND** the driver spawns a PTY for a pi turn
- **THEN** the spawned `claude` does not expose any `mcp__user-tool__*` tool to the model (verified by `tools/list` MCP introspection or by the absence of such tools in the transcript)

#### Scenario: User-global `permissions.allow` cannot re-enable a disallowed tool
- **WHEN** the user has `~/.claude/settings.json` containing `permissions.allow: ["Bash(*)"]`
- **AND** the driver spawns a PTY for a pi turn
- **THEN** the spawned `claude` still blocks `Bash` (because `--setting-sources ""` excludes user settings)

### Requirement: Native tool emission is blocked at driver configuration

THE driver SHALL configure every spawned `claude` invocation such that all native built-in tools enumerated in the bridge's disallow list are blocked at emission, leaving the bridged MCP namespace (`mcp__custom-tools__*`) as the only callable tool surface.

#### Scenario: Disallow list is non-empty and includes documented set
- **WHEN** the driver builds inline settings for a PTY spawn
- **THEN** the resulting settings forbid at least `Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, `Agent`, `WebFetch`, `WebSearch`, `TodoWrite`, `EnterPlanMode`, `ExitPlanMode`, `Skill`, `ToolSearch`, `AskUserQuestion`, `ScheduleWakeup`, `TaskOutput`, `TaskStop`, `BashOutput`, `Monitor`, and `Mcp`
- **AND** the allow set, if expressed, includes only `mcp__custom-tools__*`

### Requirement: Prompt injection via CLI positional argument

WHEN a fresh PTY is spawned for a pi user turn, THE driver SHALL deliver the pi user prompt to `claude` via the documented `[prompt]` positional CLI argument (text content) and SHALL NOT type the prompt into the PTY's stdin in interactive mode. On cold-start (no cached driver session id), the positional argument carries the flattened pi history per the bridge's existing `buildColdStartPrompt` conversion contract. On warm-resume (cached driver session id valid), the positional argument carries only the new user message. THE driver SHALL NOT write the prompt to any persistent location outside the PTY's own transcript.

IF the assembled positional argument exceeds an implementation-defined size threshold (the OS argv ceiling minus a safety margin; default 200 KB), THE driver SHALL fall back to an interactive-mode-compatible bounded mechanism that Phase 0 spike T0.11 identifies (candidates: composing extra history into `--system-prompt` if size allows; splitting the prompt across `--add-dir <context-file>` references; or another path; `--input-format` is `--print`-only per `claude --help` and is NOT a viable fallback). IF Phase 0 T0.11 identifies no viable fallback, the driver SHALL push an `error` event whose `errorMessage` references the prompt-size overflow and document this v1 limitation in CHANGELOG.

#### Scenario: Cold-start replay
- **WHEN** the driver starts a turn with no cached driver session id
- **THEN** the spawned `claude` receives the full pi history flattened to text per the bridge's existing conversion contract as the positional CLI argument
- **AND** the prompt arrives at `claude` startup, not via a subsequent hook callback

#### Scenario: Warm-resume injection
- **WHEN** the driver starts a turn with a cached driver session id matching the current pi cwd and message-hash chain
- **THEN** the PTY is spawned with `--resume <cached-session-id>` (without `--session-id`; the resumed id is the authority)
- **AND** the positional argument contains only the new user message
- **AND** no historical pi messages are re-sent
- **AND** the transcript tailer computes the path as `~/.claude/projects/<encoded-cwd>/<cached-session-id>.jsonl` (the same formula as fresh spawns, per design D22) and opens the existing file tailing from end-of-file

### Requirement: Cached driver session is a hint only

THE driver SHALL treat the cached driver session id as an in-memory cache hint and SHALL drop the cache on cwd change, pi history divergence (per the bridge's existing hash-chain check), `/fork`, `/compact`, restart, or any pi lifecycle event that pi exposes as a divergence signal.

#### Scenario: Cwd change drops cache
- **WHEN** a new turn arrives with `context.cwd` different from the cached cwd
- **THEN** the cached driver session id is cleared
- **AND** the next PTY spawn does not pass `--resume`

#### Scenario: History divergence drops cache
- **WHEN** the bridge detects pi history-hash divergence at the start of a turn
- **THEN** the cached driver session id is cleared and a structured log entry records the drop

### Requirement: Abort propagates to the PTY

WHEN pi signals abort on the current turn's `AbortSignal`, THE driver SHALL deliver an interrupt to the PTY (sending `SIGINT` or the equivalent TUI key sequence), SHALL prevent further inference progress, and SHALL terminate the PTY within an implementation-defined grace window before falling back to `SIGKILL`.

#### Scenario: Abort during model output
- **WHEN** pi aborts mid-turn while the model is streaming text
- **THEN** the driver delivers an interrupt to the PTY
- **AND** the active stream pushes a `done` event with `reason: "aborted"`
- **AND** the PTY is reaped before the next turn starts

### Requirement: Workspace trust dialog is auto-answered by the bridge

WHEN the driver spawns `claude` in a cwd that `claude` does not yet trust, `claude` interactive mode draws a workspace-trust dialog before firing any hooks or writing the transcript file. THE driver SHALL include an ANSI-aware PTY-output scanner that watches the first 5 seconds of PTY output for the trigger substrings `Quick safety check` and `Accessing workspace:` (case-insensitive, after ANSI escape sequences are stripped). On either match, THE driver SHALL write `\r` to the PTY's input (selecting the default "Yes, trust this project" option). THE scanner SHALL stop watching on first match, on transcript-file-creation event, or after the 5s window elapses, whichever comes first.

#### Scenario: Fresh tmpdir cwd triggers trust dialog; scanner auto-answers
- **WHEN** the driver spawns `claude` in `os.tmpdir()` (an untrusted cwd)
- **AND** within ~500ms the PTY output contains the trust dialog
- **THEN** the scanner detects the trigger substring within 1s
- **AND** writes `\r` to the PTY input
- **AND** the transcript file appears within 5s of the keystroke
- **AND** the `SessionStart` hook fires after the dialog is dismissed

#### Scenario: Already-trusted cwd; scanner times out silently
- **WHEN** the driver spawns `claude` in a cwd `claude` has previously trusted
- **AND** no trust dialog is drawn in PTY output
- **THEN** the scanner times out at 5s without sending any keystroke
- **AND** no harm to the spawned session

#### Scenario: Trust dialog never detected AND transcript never appears
- **IF** the PTY produces no detected dialog AND no transcript file within 30s of spawn AND the process is still alive
- **THEN** the driver pushes an `error` event whose `errorMessage` is `"workspace trust dialog not detected; claude TUI may have changed its boot UI"`
- **AND** the PTY is killed

### Requirement: Driver never writes to user-global Claude config

THE driver SHALL NOT write to any path under `~/.claude/` — including `~/.claude/settings.json`, `~/.claude/sessions/` (PID-keyed metadata), `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` (transcripts), `~/.claude/skills/`, `~/.claude/plugins/`, or any other subdirectory. THE driver MAY read a transcript JSONL file at the path delivered by a `SessionStart` or `Stop` hook payload (real location format: `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`) — and only that path.

#### Scenario: Inline configuration only
- **WHEN** the driver needs to register hooks or MCP servers for a spawn
- **THEN** the configuration is passed via `--settings '<json>'` and `--mcp-config '<json>'` inline flags
- **AND** no file under `~/.claude/` is created or modified by the driver

### Requirement: Unexpected driver exit surfaces as error

IF the spawned `claude` process exits before the `Stop` hook fires, OR IF the PTY emits an unrecoverable error event, THEN the driver SHALL push an `error` event on the active pi stream whose `errorMessage` names the exit cause (signal, exit code, or PTY error) and SHALL emit a structured log entry; THE driver SHALL NOT silently retry.

#### Scenario: Driver binary missing
- **IF** `claude` is not on `$PATH` at spawn time
- **THEN** the driver pushes an `error` event whose `errorMessage` references the missing binary
- **AND** `complete()` resolves with `stopReason === "error"`

#### Scenario: Driver crashes mid-turn
- **IF** the PTY emits an `exit` event with a non-zero status code while a turn is in flight and the `Stop` hook has not fired
- **THEN** the driver pushes an `error` event whose `errorMessage` includes the exit code or signal
- **AND** any cached driver session id is cleared so the next turn cold-starts

---

### Requirement: Image content handling in v1

IF a pi turn's `Context.messages` contains image content blocks intended for the main-provider path, THEN the driver SHALL strip the image blocks from the positional CLI argument, SHALL emit a `warn`-level log entry naming the dropped block count, AND SHALL proceed with text-only content. IF a capture-shape `complete()` call's prompt contains image content blocks, THEN the driver SHALL reject the call pre-spawn with `stopReason: "error"` and an `errorMessage` naming the v1 limitation (interactive `claude` has no documented programmatic mechanism for inline image injection).

#### Scenario: Main-provider turn with image content
- **WHEN** `complete()` is invoked on the main-provider path with `context.messages` containing an image block
- **THEN** the bridge strips the image block from the positional argument before spawning `claude`
- **AND** a warn-level log entry records the dropped block count
- **AND** the turn proceeds with text-only content

#### Scenario: Capture call with image content
- **WHEN** `complete()` is invoked on the capture path with `context.messages` containing an image block
- **THEN** the bridge does not spawn `claude`
- **AND** the pi-ai stream emits `start` then `error` whose `errorMessage` references the v1 no-image-on-capture limitation
- **AND** `complete()` resolves with `stopReason === "error"`

### Requirement: Hook-relay subprocess is the bridge's hook IPC channel

WHEN the driver registers hook handlers (`SessionStart` and `Stop`) via inline `--settings`, THE hook commands SHALL be invocations of the `pi-claude-bridge-shim` executable with `--mode hook --event <name> --socket <per-pty-socket-path>`. THE hook subprocess SHALL read the hook payload from its stdin (per `claude`'s documented hook contract), forward the payload + event name to the bridge over the per-PTY unix-domain socket, await a structured response, and write any required response to stdout in the format `claude` expects for that hook event (verified by Phase 0 T0.13).

#### Scenario: SessionStart payload reaches the bridge as a confirmation signal
- **WHEN** the spawned `claude` invokes the `SessionStart` hook with its payload
- **THEN** the hook subprocess connects to the per-PTY socket and forwards the payload to the bridge
- **AND** the bridge confirms the active turn frame has started
- **AND** IF the payload contains a `transcript_path` field, the bridge asserts it matches the path computed deterministically from the pre-generated `--session-id` UUID (per D18); on mismatch the bridge logs a warn-level entry but proceeds with the computed path

#### Scenario: Stop payload signals turn completion
- **WHEN** the spawned `claude` invokes the `Stop` hook with its payload
- **THEN** the hook subprocess forwards the payload to the bridge
- **AND** the bridge enters the bounded post-`Stop` settle window (D17) before closing the transcript tailer

### Requirement: Abort lifecycle is decoupled from `Stop` hook firing

WHEN pi signals abort while a turn is in flight, THE driver SHALL transition the transcript stream to `aborted` mode immediately (drain buffered complete JSONL lines, emit `done` with `reason: "aborted"`, close the file handle, stop watching). The driver SHALL NOT require the `Stop` hook to fire before resolving the abort. IF the `Stop` hook subsequently fires post-abort, the driver SHALL ignore its payload. A post-abort PTY exit, regardless of exit code or signal, SHALL be classified as the expected termination path for that turn and SHALL NOT trigger the "unexpected driver exit" error path.

#### Scenario: Abort completes without `Stop`
- **WHEN** pi aborts a turn and the PTY exits via SIGINT (or SIGKILL after grace) without the `Stop` hook firing
- **THEN** the pi-ai stream emits `done` with `reason: "aborted"`
- **AND** the driver does NOT push an `error` event citing unexpected driver exit

#### Scenario: Late `Stop` after abort is ignored
- **WHEN** pi aborts and the stream has already emitted `done` with `reason: "aborted"`
- **AND** the `Stop` hook subsequently fires with a payload
- **THEN** the bridge logs the late event at info level and takes no further action on the pi-ai stream

### Requirement: Abort preserves late-tool-result coherence with pi

WHEN pi signals abort while a turn is mid-tool-round (an MCP tool call is parked awaiting pi to deliver a `tool_result`), THE driver SHALL tear down the PTY + shim per the abort lifecycle requirement above BUT SHALL keep the bridge-side router state for that frame ALIVE (the `pendingResolvers` and `pendingResults` maps preserved) until pi's next event resolves the ambiguity. IF pi subsequently delivers a real `tool_result` for the aborted frame via the next `streamSimple()` call, THE bridge SHALL stash that result on the frame for inclusion in the next turn's cold-start replay material. IF pi sends a new user message, THE bridge SHALL drain the frame's pending resolvers synthetically and pop the frame from the active stack. IF a `clearSession` event fires before either of the above, THE bridge SHALL drain synthetically and discard.

#### Scenario: Pi delivers tool_result after abort
- **WHEN** pi aborts mid-tool-round and the PTY/shim are torn down
- **AND** pi's tool executor finishes the tool 200ms later and calls `streamSimple()` with the `tool_result`
- **THEN** the bridge captures the result in the aborted frame's `pendingResults` map
- **AND** logs the capture at info level
- **AND** the next turn's cold-start replay includes the captured `tool_result` in pi's history

#### Scenario: Pi sends new user message after abort
- **WHEN** pi aborts and the PTY/shim are torn down
- **AND** before any `tool_result` arrives, pi sends a new user message via `streamSimple()`
- **THEN** the bridge drains the aborted frame's `pendingResolvers` synthetically (per ABORTED_TOOL_RESULT_TEXT in today's index.ts)
- **AND** pops the aborted frame from the active stack
- **AND** the new turn proceeds as a fresh-turn dispatch

---

## Acceptance criterion quality checklist

| AC ID | Testable | Solution-free | Unambiguous | Consistent | Complete |
|---|---|---|---|---|---|
| claude-tui-driver.pty-spawn-with-model-selection | [ ] | [ ] | [ ] | [ ] | [ ] |
| claude-tui-driver.native-tool-emission-is-blocked-at-driver-configuration | [ ] | [ ] | [ ] | [ ] | [ ] |
| claude-tui-driver.prompt-injection-via-cli-positional-argument | [ ] | [ ] | [ ] | [ ] | [ ] |
| claude-tui-driver.cached-driver-session-is-a-hint-only | [ ] | [ ] | [ ] | [ ] | [ ] |
| claude-tui-driver.abort-propagates-to-the-pty | [ ] | [ ] | [ ] | [ ] | [ ] |
| claude-tui-driver.driver-never-writes-to-user-global-claude-config | [ ] | [ ] | [ ] | [ ] | [ ] |
| claude-tui-driver.unexpected-driver-exit-surfaces-as-error | [ ] | [ ] | [ ] | [ ] | [ ] |
| claude-tui-driver.workspace-trust-dialog-is-auto-answered-by-the-bridge | [ ] | [ ] | [ ] | [ ] | [ ] |
| claude-tui-driver.image-content-handling-in-v1 | [ ] | [ ] | [ ] | [ ] | [ ] |
| claude-tui-driver.hook-relay-subprocess-is-the-bridges-hook-ipc-channel | [ ] | [ ] | [ ] | [ ] | [ ] |
| claude-tui-driver.abort-lifecycle-is-decoupled-from-stop-hook-firing | [ ] | [ ] | [ ] | [ ] | [ ] |
| claude-tui-driver.abort-preserves-late-tool-result-coherence-with-pi | [ ] | [ ] | [ ] | [ ] | [ ] |
