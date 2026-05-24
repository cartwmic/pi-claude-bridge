// src/driver/settings.ts
//
// Build the inline JSON payloads that `claude --settings <...>` and
// `claude --mcp-config <...>` consume per Phase 0 T0.13 + T0.14 findings.
//
// Two builders:
//   - buildSettingsJson(opts)  → `--settings <inline-json>` value
//   - buildMcpConfigJson(opts) → `--mcp-config <inline-json>` value
//
// Each returns a JSON STRING (already stringified) ready to be passed as a
// CLI arg. Keeping the stringify here means tests don't have to re-derive
// the structure separately from runtime usage; one source of truth.

/**
 * Native built-in tools the bridge denies at driver configuration so that
 * Claude never emits a tool_use block for them. The model's only callable
 * surface becomes the bridged `mcp__custom-tools__*` namespace.
 *
 * Mirrors today's `DISALLOWED_BUILTIN_TOOLS` (index.ts:60) verbatim. When
 * the SDK path is removed in Phase 3 the const here becomes the canonical
 * list and the index.ts copy is deleted.
 *
 * NB: spec `claude-tui-driver.native-tool-emission-is-blocked-at-driver-configuration`
 * pins the MINIMUM set; this list is a superset of the documented minimum.
 */
export const DISALLOWED_BUILTIN_TOOLS: readonly string[] = Object.freeze([
	// Filesystem / shell
	"Read", "Write", "Edit", "Glob", "Grep", "Bash", "Agent",
	"NotebookEdit", "EnterWorktree", "ExitWorktree",
	// CC org/automation
	"CronCreate", "CronDelete", "CronList", "TeamCreate", "TeamDelete",
	// Web
	"WebFetch", "WebSearch", "TodoRead", "TodoWrite",
	"EnterPlanMode", "ExitPlanMode", "RemoteTrigger", "SendMessage",
	"ListMcpResourcesTool", "ReadMcpResourceTool",
	// Defense-in-depth: skill / UI built-ins (model otherwise reaches for
	// ToolSearch from its training pattern; the SDK swallowed those silently,
	// the PTY path will not).
	"ToolSearch", "Skill", "AskUserQuestion", "PushNotification",
	// CC background-task / scheduling family (observed leaking on SDK path).
	"ScheduleWakeup", "TaskOutput", "TaskStop", "BashOutput", "Monitor", "Mcp",
]);

/** Bridged tool surface — only `mcp__custom-tools__*` is allowed. */
export const ALLOWED_TOOL_GLOBS: readonly string[] = Object.freeze([
	"mcp__custom-tools__*",
]);

export interface HookCommand {
	type: "command";
	command: string;
}

export interface HookEntry {
	matcher: string;
	hooks: HookCommand[];
}

/**
 * Settings builder options.
 *
 * `shimPath` — absolute path to the built `pi-claude-bridge-shim` binary.
 * `socketPath` — per-PTY unix socket path the shim connects to.
 * `events` — which hook events to register. v1 = SessionStart + Stop only
 *   (D9; PreToolUse + SessionEnd dropped). Configurable for tests.
 */
export interface SettingsBuilderOptions {
	shimPath: string;
	socketPath: string;
	events?: ReadonlyArray<"SessionStart" | "Stop">;
}

/**
 * Build the inline JSON payload for `claude --settings <...>`.
 *
 * Two top-level keys:
 *   - hooks: hook-event → matcher → command entry
 *     The command invokes the shim with `--mode hook --event <name>
 *     --socket <socket-path>`; claude writes the hook payload to stdin and
 *     the shim relays it to the bridge over the unix socket.
 *   - permissions.deny: the DISALLOWED_BUILTIN_TOOLS list in the format
 *     claude's permission engine expects (e.g. "Bash", "Read", ...).
 *
 * Returns a JSON STRING.
 */
export function buildSettingsJson(opts: SettingsBuilderOptions): string {
	const events = opts.events ?? (["SessionStart", "Stop"] as const);
	const shimCommand = (event: string) =>
		`${shellQuote(opts.shimPath)} --mode hook --event ${event} --socket ${shellQuote(opts.socketPath)}`;

	const hooks: Record<string, HookEntry[]> = {};
	for (const ev of events) {
		hooks[ev] = [
			{
				matcher: "*",
				hooks: [{ type: "command", command: shimCommand(ev) }],
			},
		];
	}

	const settings = {
		hooks,
		permissions: {
			deny: DISALLOWED_BUILTIN_TOOLS.map(toolDenyEntry),
		},
	};
	return JSON.stringify(settings);
}

/**
 * Convert a tool name into the deny-list entry shape claude expects.
 *
 * Bash uses a sub-command matcher syntax (`Bash(*)`); other tools are bare
 * names. We deny ALL Bash invocations (the bridge replaces Bash with
 * pi-native `mcp__custom-tools__bash`).
 */
function toolDenyEntry(toolName: string): string {
	if (toolName === "Bash") return "Bash(*)";
	return toolName;
}

/**
 * Single-quote a string for shell, escaping embedded single quotes.
 *
 * Used to construct the hook command strings that claude executes via
 * `sh -c`. The shim path may contain spaces (D19 + Round-5 A.P2 finding).
 */
function shellQuote(s: string): string {
	if (s.length === 0) return "''";
	if (/^[a-zA-Z0-9_./@:%+=,-]+$/.test(s)) return s;
	return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ---------------------------------------------------------------------------
// MCP config builder
// ---------------------------------------------------------------------------

export interface McpConfigBuilderOptions {
	/** Absolute path to the built `pi-claude-bridge-shim` binary. */
	shimPath: string;
	/** Per-PTY unix socket path. */
	socketPath: string;
	/** Absolute path to the per-PTY tools.json the shim advertises. */
	toolsFile: string;
	/** Optional capture-tool name (capture-mode only) so shim handles it locally. */
	captureTool?: string;
	/** Display name for the shim server in `--mcp-config`. Default: "pi-bridge". */
	serverName?: string;
}

/**
 * Build the inline JSON payload for `claude --mcp-config <...>`.
 *
 * Single stdio-mode MCP server entry pointing at the shim. The shim runs as
 * a subprocess of claude (per --mcp-config's stdio transport contract) and
 * relays tools/list + tools/call over the unix socket to the bridge.
 */
export function buildMcpConfigJson(opts: McpConfigBuilderOptions): string {
	const name = opts.serverName ?? "pi-bridge";
	const shimArgs = ["--mode", "mcp", "--socket", opts.socketPath, "--tools-file", opts.toolsFile];
	if (opts.captureTool) shimArgs.push("--capture-tool", opts.captureTool);
	const config = {
		mcpServers: {
			[name]: {
				type: "stdio" as const,
				command: opts.shimPath,
				args: shimArgs,
			},
		},
	};
	return JSON.stringify(config);
}

/**
 * Tools-allow-list for `--allowedTools` flag. Constrains the model's tool
 * surface to the bridged namespace only.
 */
export function buildAllowedToolsArg(): string {
	return ALLOWED_TOOL_GLOBS.join(",");
}
