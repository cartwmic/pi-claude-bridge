# Capability: claude-p-driver

<!-- authored: in-session -->

## MODIFIED Requirements

### Requirement: claude-p spawn with model selection

WHERE `claude-p` is selected, WHEN the bridge starts a fresh turn for a `claude-bridge` model, THE driver SHALL spawn the maintained `claude-p` binary with selected model, path-appropriate system prompt, explicit bridge shim config, current native disallow list, strict MCP/settings isolation, permission bypass, fresh or resumed session identity, stream-json output, and verbose mode; it SHALL NOT pass `--settings`, `-p`, `--print`, or `--timeout`.

#### Scenario: Fresh interactive turn
- **WHEN** selected driver is `claude-p` and a fresh turn starts
- **THEN** exactly one `claude-p` subprocess starts with existing required model, prompt, MCP, isolation, permission, session, output, and verbose flags
- **AND** no print-mode flag is passed

#### Scenario: Direct selection does not spawn interactive driver
- **WHEN** selected driver is `claude-print`
- **THEN** this requirement does not cause a `claude-p` process to spawn

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

WHILE an interactive invocation waits on a held bridge MCP call, THE child Claude process SHALL receive unlimited MCP idle policy and SHALL not terminate the call because of its default stdio-MCP idle interval.

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
