# Capability: claude-p-driver

<!-- authored: in-session -->

## MODIFIED Requirements

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

### Requirement: Image content handling in v1

IF a main-provider turn contains image blocks, THEN THE bridge SHALL strip them, warn with dropped count, and proceed text-only. IF a capture call contains image blocks, THEN THE bridge SHALL warn, drop them, and proceed under output-capture's documented lossy text-only replay contract.

#### Scenario: Main interactive turn with image
- **WHEN** main-provider history contains an image block
- **THEN** image is stripped, warning records count, and text-only turn proceeds

#### Scenario: Interactive capture with image
- **WHEN** capture history contains image blocks
- **THEN** capture warns, drops images, and proceeds text-only

## ADDED Requirements

### Requirement: Interactive Held Calls Have No Upstream Idle Cutoff

WHILE an interactive invocation waits on a held bridge MCP call, THE bridge SHALL set `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0` in the Claude child environment so the default stdio-MCP idle interval cannot terminate the call.

#### Scenario: Tool exceeds upstream idle default
- **WHEN** a healthy pi tool remains held longer than Claude Code's default stdio-MCP idle interval
- **THEN** `claude-p` continues waiting until pi returns result or caller aborts

---

## Acceptance criterion quality checklist

| AC ID | Testable | Solution-free | Unambiguous | Consistent | Complete |
|---|---|---|---|---|---|
| claude-p-driver.claude-p-spawn-with-model-selection | [x] | [x] | [x] | [x] | [x] |
| claude-p-driver.native-tool-emission-is-blocked-via-disallowedtools | [x] | [x] | [x] | [x] | [x] |
| claude-p-driver.image-content-handling-in-v1 | [x] | [x] | [x] | [x] | [x] |
| claude-p-driver.interactive-held-calls-have-no-upstream-idle-cutoff | [x] | [x] | [x] | [x] | [x] |
