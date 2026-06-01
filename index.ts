// pi-claude-bridge: SDK-native, pi-canonical, inference-only.
//
// Architecture (see SCENARIOS.md for the full charter):
//   - pi owns conversation history. The Agent SDK is an inference provider.
//   - One SDK query() spans one pi user-turn (which may include many tool rounds).
//   - Tool execution happens IN PI. Tools are declared to the SDK via an
//     in-process MCP server whose handlers block on a Promise until pi
//     delivers the tool result via the next streamSimple() call.
//   - Bridge holds the CC session_id in memory only as a cache hint. Never
//     reads or writes ~/.claude/sessions/.
//   - Aborts use query.interrupt(). No JSONL surgery, no UUID rotation.
//   - Subagents work via a context stack: a child query nested inside a
//     parent's blocked tool-handler slot.

import {
	calculateCost,
	StringEnum,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
	type Tool,
} from "@mariozechner/pi-ai";
import * as piAi from "@mariozechner/pi-ai";
import { keyHint, buildSessionContext, type ExtensionAPI, type ExtensionUIContext } from "@mariozechner/pi-coding-agent";
import {
	createSdkMcpServer,
	query as _realQuery,
	type EffortLevel,
	type SDKMessage,
	type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Base64ImageSource, ContentBlockParam, MessageParam } from "@anthropic-ai/sdk/resources";
import { z } from "zod";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { existsSync, mkdirSync, readFileSync } from "fs";
import pino from "pino";
import { createStream } from "rotating-file-stream";
import { homedir, tmpdir } from "os";
import { randomBytes, randomUUID } from "crypto";
import { writeFileSync } from "fs";
import { createRequire } from "module";
import { dirname, join, resolve } from "path";
import { pascalCase } from "change-case";
import { PROVIDER_ID, messageContentToText, convertPiMessages } from "./convert.js";
import { buildModels, resolveModelId as _resolveModelId } from "./models.js";
import {
	spawnClaudePWithResilience as _realSpawnClaudeP,
	type ClaudePSpawnConfig,
	type ClaudePHandle,
	type ClaudePDoneResult,
	type SystemPromptSource,
	type PromptSource,
} from "./src/driver/claudeP.js";
import type { DriverStreamEvent } from "./src/driver/stream.js";
import { createRouter, type Router, type ParkedCallInfo, type ToolDef } from "./src/mcp/router.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MCP_SERVER_NAME = "custom-tools";
const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

// Pi sends lowercase tool names; the SDK uses PascalCase for built-ins.
const SDK_TO_PI_TOOL_NAME: Record<string, string> = {
	read: "read", write: "write", edit: "edit", bash: "bash",
};

const DISALLOWED_BUILTIN_TOOLS = [
	"Read", "Write", "Edit", "Glob", "Grep", "Bash", "Agent",
	"NotebookEdit", "EnterWorktree", "ExitWorktree",
	"CronCreate", "CronDelete", "CronList", "TeamCreate", "TeamDelete",
	"WebFetch", "WebSearch", "TodoRead", "TodoWrite",
	"EnterPlanMode", "ExitPlanMode", "RemoteTrigger", "SendMessage",
	"ListMcpResourcesTool", "ReadMcpResourceTool",
	// Defense-in-depth: also block CC's deferred-tool / skill / UI built-ins
	// so Claude doesn't even emit tool_use blocks for them. Without these,
	// the model would still occasionally instinctively reach for ToolSearch
	// (its training pattern) — which the SDK handles internally and which
	// would otherwise pollute our FIFO queue. The queue is also defended at
	// push time (see processStreamEvent), but blocking emission is cleaner.
	"ToolSearch", "Skill", "AskUserQuestion", "PushNotification",
	// CC background-task / scheduling family. These were observed leaking
	// through (see claude-bridge.log warnings: "built-in tool_use observed
	// (ScheduleWakeup|TaskOutput) — skipping queue push"). They are CC SDK
	// built-ins, NOT pi-native — pi exposes its own equivalents through the
	// `mcp__custom-tools__*` namespace, so blocking the bare names is safe.
	"ScheduleWakeup", "TaskOutput", "TaskStop", "BashOutput", "Monitor", "Mcp",
];

// ---------------------------------------------------------------------------
// SDK query factory — test seam (Decision 11).
// Production code always uses _queryFactory(...); tests can inject a mock via
// __setQueryFactoryForTests(). DO NOT call _realQuery directly anywhere else.
// ---------------------------------------------------------------------------

let _queryFactory: typeof _realQuery = _realQuery;

/** Test-only: swap the query factory and return a restorer. Not part of the public API. */
export function __setQueryFactoryForTests(f: typeof _realQuery): () => void {
	const prev = _queryFactory;
	_queryFactory = f;
	return () => { _queryFactory = prev; };
}

// ---------------------------------------------------------------------------
// claude-p spawn factory — test seam, mirrors _queryFactory (T1.9).
// Production always uses _spawnClaudePFactory(...); tests inject a mock.
// ---------------------------------------------------------------------------

let _spawnClaudePFactory: typeof _realSpawnClaudeP = _realSpawnClaudeP;

/** Test-only: swap the claude-p spawn (resilience) factory and return a restorer. */
export function __setSpawnClaudePForTests(f: typeof _realSpawnClaudeP): () => void {
	const prev = _spawnClaudePFactory;
	_spawnClaudePFactory = f;
	return () => { _spawnClaudePFactory = prev; };
}

// ---------------------------------------------------------------------------
// Driver selection — sdk (default) vs claude-p (T1.8). The dispatch is a single
// early branch at the top of startFreshQuery; the SDK body below is unchanged.
// ---------------------------------------------------------------------------

const CLAUDE_BRIDGE_DRIVER: "sdk" | "claude-p" =
	(process.env.CLAUDE_BRIDGE_DRIVER ?? "sdk").trim().toLowerCase() === "claude-p" ? "claude-p" : "sdk";

let _driverOverride: "sdk" | "claude-p" | null = null;

/** Test-only: force the active driver and return a restorer. Mirrors __setQueryFactoryForTests. */
export function __setDriverForTests(d: "sdk" | "claude-p" | null): () => void {
	const prev = _driverOverride;
	_driverOverride = d;
	return () => { _driverOverride = prev; };
}

function effectiveDriver(): "sdk" | "claude-p" {
	return _driverOverride ?? CLAUDE_BRIDGE_DRIVER;
}

/** Test-only: swap piApiRef and return a restorer. Not part of the public API. */
export function __setPiApiRefForTests(ref: { getActiveTools(): string[] } | null): () => void {
	const prev = piApiRef;
	piApiRef = ref as any;
	return () => { piApiRef = prev as any; };
}

/** Test-only: return the current debug log path. Not part of the public API. */
export function __getDebugLogPathForTests(): string {
	return DEBUG_LOG_PATH;
}

/** Test-only: reset cross-call session cache. Not part of the public API. */
export function __resetCachedSessionForTests(): void {
	cachedSessionId = null;
	cachedSessionCwd = null;
	lastSentMessageHashes = null;
}

// Pi-CC tool arg key renames (pi names vs CC SDK names for built-ins).
const SDK_KEY_RENAMES: Record<string, Record<string, string>> = {
	read:  { file_path: "path" },
	write: { file_path: "path" },
	edit:  { file_path: "path", old_string: "oldText", new_string: "newText", old_text: "oldText", new_text: "newText" },
};

// Pi reasoning levels → CC SDK effort levels.
const REASONING_TO_EFFORT: Record<string, EffortLevel> = {
	minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "max",
};

// ---------------------------------------------------------------------------
// pi-ai compat shim
// ---------------------------------------------------------------------------

const _piAi = piAi as any;
const newAssistantMessageEventStream: () => AssistantMessageEventStream =
	typeof _piAi.createAssistantMessageEventStream === "function"
		? _piAi.createAssistantMessageEventStream
		: () => new _piAi.AssistantMessageEventStream();

// ---------------------------------------------------------------------------
// Logging (pino + pino-roll)
// ---------------------------------------------------------------------------
// On by default. Disable with CLAUDE_BRIDGE_DEBUG=0.
// Log path: ~/.pi/agent/claude-bridge.log (override CLAUDE_BRIDGE_DEBUG_PATH).
// Size-based rotation via pino-roll: 10 MB per file, keep 2 generations
// (override CLAUDE_BRIDGE_DEBUG_MAX_BYTES for size).
// Output is JSON-per-line; each record carries `level`, `time` (ISO),
// `msg`, plus any structured fields the call site attached.

const DEBUG = process.env.CLAUDE_BRIDGE_DEBUG !== "0";
const DEBUG_LOG_PATH = process.env.CLAUDE_BRIDGE_DEBUG_PATH || join(homedir(), ".pi", "agent", "claude-bridge.log");
const DEBUG_MAX_BYTES = Number(process.env.CLAUDE_BRIDGE_DEBUG_MAX_BYTES) || 10 * 1024 * 1024;

if (DEBUG) {
	try { mkdirSync(dirname(DEBUG_LOG_PATH), { recursive: true }); } catch { /* ignore */ }
}

// rotating-file-stream maintains the live file at DEBUG_LOG_PATH and moves
// rotated content to numbered backups (DEBUG_LOG_PATH.1, .2). Total disk
// bounded at ~3× DEBUG_MAX_BYTES (current + 2 backups).
const logStream = DEBUG
	? createStream(DEBUG_LOG_PATH, {
			size: `${DEBUG_MAX_BYTES}B`,
			maxFiles: 2,
		})
	: undefined;

const logger = DEBUG && logStream
	? pino(
			{ level: "debug", timestamp: pino.stdTimeFunctions.isoTime, base: undefined },
			logStream,
		)
	: pino({ level: "silent" });

// Back-compat shim: existing call sites use `debug(msg)`. Keep it as the
// debug-level entrypoint; new code can call log.info/warn/error directly.
const log = {
	debug: (objOrMsg: unknown, msg?: string) =>
		typeof objOrMsg === "string" ? logger.debug(objOrMsg) : logger.debug(objOrMsg as object, msg),
	info: (objOrMsg: unknown, msg?: string) =>
		typeof objOrMsg === "string" ? logger.info(objOrMsg) : logger.info(objOrMsg as object, msg),
	warn: (objOrMsg: unknown, msg?: string) =>
		typeof objOrMsg === "string" ? logger.warn(objOrMsg) : logger.warn(objOrMsg as object, msg),
	error: (objOrMsg: unknown, msg?: string) =>
		typeof objOrMsg === "string" ? logger.error(objOrMsg) : logger.error(objOrMsg as object, msg),
};

function debug(msg: string) { log.debug(msg); }

// ---------------------------------------------------------------------------
// Models — preserve legacy buildModels with safe fallback for diamond deps.
// ---------------------------------------------------------------------------

import { getModels } from "@mariozechner/pi-ai";
const ANTHROPIC_MODELS = (getModels as any)("anthropic") ?? [];
const MODELS = buildModels(ANTHROPIC_MODELS as any[]);

// ---------------------------------------------------------------------------
// Module state — pi extension singletons.
// ---------------------------------------------------------------------------

let piApiRef: ExtensionAPI | null = null;
let piUI: ExtensionUIContext | null = null;
// Latest pi extension context (captured on session_start). Used to read the
// current pi sessionId for log binding.
let piExtCtx: { sessionManager: { getSessionId(): string } } | null = null;

function getPiSessionId(): string | null {
	try {
		const id = piExtCtx?.sessionManager.getSessionId();
		return id ? id.slice(0, 8) : null;
	} catch { return null; }
}

/**
 * In-memory session cache. The CC session_id is a hint for prompt cache
 * resume. We NEVER read or write ~/.claude/sessions/. On restart, on /fork,
 * on /tree, on /compact — anything that diverges history — this is dropped
 * and the next turn cold-starts.
 */
let cachedSessionId: string | null = null;
let cachedSessionCwd: string | null = null;

/**
 * Per-message fingerprints from the last context we sent. Used to detect
 * divergence: on a new turn, we expect each prior position's hash to be
 * unchanged; new messages append at the end. If any prior position's hash
 * differs, pi has /tree-navigated, /fork-ed, or /compact-ed — the SDK's
 * resumed transcript no longer matches and we must cold-start.
 *
 * Forward progress (T1: [u1] → T2: [u1, a1, u2]) is NOT divergence — the
 * new array is a prefix-extension of the old.
 */
let lastSentMessageHashes: string[] | null = null;

function hashMessage(m: Context["messages"][number]): string {
	const c = typeof m.content === "string" ? m.content : messageContentToText(m.content);
	const head = c.slice(0, 96);
	const tail = c.slice(-32);
	return `${m.role}:${c.length}:${head}|${tail}`;
}

function computeMessageHashes(messages: Context["messages"]): string[] {
	return messages.map(hashMessage);
}

/**
 * Detect divergence: returns true if any common-prefix position differs
 * between the previously-sent message hashes and the current ones. False
 * (no divergence) when there's no prior or when current is a strict
 * prefix-extension of prior.
 */
function detectHistoryDivergence(
	prior: string[] | null,
	current: string[],
): boolean {
	if (!prior || prior.length === 0) return false;
	const commonLen = Math.min(prior.length, current.length);
	for (let i = 0; i < commonLen; i++) {
		if (prior[i] !== current[i]) return true;
	}
	// If current is shorter than prior, history was truncated → divergence.
	return current.length < prior.length;
}

/**
 * Active in-flight query state. There is at most one *top-level* active query
 * per pi conversation, BUT subagents can nest a child query inside a parent's
 * blocked tool-handler slot. We use a stack to model this correctly.
 *
 * `top()` is the query that owns the next streamSimple() call (either a fresh
 * subagent turn or a tool-result delivery for the current frame's blocked
 * MCP handler).
 */
type QueryFrame = {
	/** Which driver owns this frame. "sdk" = legacy; "claude-p" = T1.9 path. */
	driverKind: "sdk" | "claude-p";
	/** SDK query handle — present only on sdk frames. */
	sdkQuery?: ReturnType<typeof _realQuery>;
	/** claude-p driver handle — present only on claude-p frames. */
	claudeHandle?: ClaudePHandle;
	/** Per-spawn router — present only on claude-p frames. */
	router?: Router;
	currentPiStream: AssistantMessageEventStream | null;
	turnOutput: AssistantMessage | null;
	turnStarted: boolean;
	turnSawToolCall: boolean;
	turnBlocks: any[];
	customToolNameToPi: Map<string, string>;
	model: Model<any>;
	cwd: string;
	// Per-frame logger pre-bound with { piSessionId, model, cwd }. Re-bound to
	// add { ccSessionId } once the SDK reports it via system:init.
	log: pino.Logger;

	// Tool-handler queue: the SDK invokes our MCP handlers in the same order it
	// emitted tool_use blocks (toolUseId not exposed to handlers). We push ids
	// when we see them in stream events, pop them when the handler runs.
	// Present only on sdk frames; claude-p frames route via router.onPark.
	toolUseIdQueue?: string[];
	pendingResolvers: Map<string, (result: { content: { type: "text"; text: string }[]; isError?: boolean }) => void>;
	pendingResults: Map<string, { content: { type: "text"; text: string }[]; isError?: boolean }>;

	wasAborted: boolean;
	donePromise: Promise<void>;
};

const stack: QueryFrame[] = [];
function top(): QueryFrame | null { return stack[stack.length - 1] ?? null; }

// ---------------------------------------------------------------------------
// Settings & system-prompt helpers (lightweight version of legacy)
// ---------------------------------------------------------------------------

const GLOBAL_AGENTS_PATH = join(homedir(), ".pi", "AGENTS.md");

function findAgentsMdInParents(startDir: string): string | undefined {
	let current = resolve(startDir);
	while (true) {
		const candidate = join(current, "AGENTS.md");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function resolveAgentsMdPath(): string | undefined {
	return findAgentsMdInParents(process.cwd()) ?? (existsSync(GLOBAL_AGENTS_PATH) ? GLOBAL_AGENTS_PATH : undefined);
}

function sanitizeAgentsContent(content: string): string {
	return content
		.replace(/~\/\.pi\b/gi, "~/.claude")
		.replace(/(^|[\s'"`])\.pi\//g, "$1.claude/")
		.replace(/\b\.pi\b/gi, ".claude")
		.replace(/\bpi\b/gi, "environment");
}

function extractAgentsAppend(): string | undefined {
	const p = resolveAgentsMdPath();
	if (!p) return undefined;
	try {
		const content = readFileSync(p, "utf-8").trim();
		if (!content) return undefined;
		const sanitized = sanitizeAgentsContent(content);
		return sanitized ? `# CLAUDE.md\n\n${sanitized}` : undefined;
	} catch { return undefined; }
}

// Pi's APPEND_SYSTEM.md (project override at <cwd>/.pi/APPEND_SYSTEM.md, else
// global at ~/.pi/agent/APPEND_SYSTEM.md). Forwarded verbatim plus a runtime
// note about the MCP tool-name prefix, since pi tools are exposed to Claude
// as `mcp__<MCP_SERVER_NAME>__<name>` rather than their bare pi names.
const PROJECT_APPEND_SYSTEM_PATH = join(".pi", "APPEND_SYSTEM.md");
const GLOBAL_APPEND_SYSTEM_PATH = join(homedir(), ".pi", "agent", "APPEND_SYSTEM.md");

function resolveAppendSystemPath(): string | undefined {
	const projectPath = join(process.cwd(), PROJECT_APPEND_SYSTEM_PATH);
	if (existsSync(projectPath)) return projectPath;
	if (existsSync(GLOBAL_APPEND_SYSTEM_PATH)) return GLOBAL_APPEND_SYSTEM_PATH;
	return undefined;
}

function extractAppendSystem(): string | undefined {
	const p = resolveAppendSystemPath();
	if (!p) return undefined;
	try {
		const content = readFileSync(p, "utf-8").trim();
		if (!content) return undefined;
		// Forward as-is and append a runtime note teaching Claude how to
		// invoke any tool the rules above might reference. Claude only sees
		// pi tools through the bridge's MCP server, so bare names like
		// `bash` / `subagent` won't resolve unless prefixed.
		const toolNotice = `\n\nNote: if the rules above reference tools by bare names (e.g. \`bash\`, \`read\`, \`write\`, \`edit\`, \`subagent\`), call them via the MCP-prefixed names \`mcp__${MCP_SERVER_NAME}__<name>\` (e.g. \`mcp__${MCP_SERVER_NAME}__bash\`). The bare names are not exposed.`;
		return `# Operator instructions\n\n${content}${toolNotice}`;
	} catch { return undefined; }
}

// Pi's system prompt has a skills block we want to forward to CC verbatim
// (with the read-tool reference rewritten to use our MCP-prefixed name).
function extractSkillsBlock(systemPrompt?: string): string | undefined {
	if (!systemPrompt) return undefined;
	const start = systemPrompt.indexOf("The following skills provide specialized instructions for specific tasks.");
	if (start < 0) return undefined;
	const end = systemPrompt.indexOf("</available_skills>", start);
	if (end < 0) return undefined;
	return systemPrompt.slice(start, end + "</available_skills>".length).trim()
		.replace("Use the read tool to load a skill's file", `Use the read tool (mcp__${MCP_SERVER_NAME}__read) to load a skill's file`);
}

// ---------------------------------------------------------------------------
// Pi tools → SDK MCP server
// ---------------------------------------------------------------------------

function jsonSchemaPropertyToZod(prop: Record<string, unknown>): z.ZodTypeAny {
	let base: z.ZodTypeAny;
	if (Array.isArray(prop.enum)) base = z.enum(prop.enum as [string, ...string[]]);
	else switch (prop.type) {
		case "string": base = z.string(); break;
		case "number": case "integer": base = z.number(); break;
		case "boolean": base = z.boolean(); break;
		case "array": base = prop.items
			? z.array(jsonSchemaPropertyToZod(prop.items as Record<string, unknown>))
			: z.array(z.unknown()); break;
		case "object": base = z.record(z.string(), z.unknown()); break;
		default: base = z.unknown();
	}
	if (typeof prop.description === "string") base = base.describe(prop.description);
	return base;
}

function jsonSchemaToZodShape(schema: unknown): Record<string, z.ZodTypeAny> {
	const s = schema as Record<string, unknown>;
	if (!s || s.type !== "object" || !s.properties) return {};
	const props = s.properties as Record<string, Record<string, unknown>>;
	const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
	const shape: Record<string, z.ZodTypeAny> = {};
	for (const [key, prop] of Object.entries(props)) {
		const zodProp = jsonSchemaPropertyToZod(prop);
		shape[key] = required.has(key) ? zodProp : zodProp.optional();
	}
	return shape;
}

function buildMcpServers(tools: Tool[], frame: QueryFrame) {
	if (!tools.length) return undefined;
	const mcpTools = tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		inputSchema: jsonSchemaToZodShape(tool.parameters),
		handler: async () => {
			// FIFO match: SDK calls handlers in the same order it emitted tool_use blocks.
			const toolUseId = frame.toolUseIdQueue!.shift();
			if (!toolUseId) {
				frame.log.error({ tool: tool.name }, `mcp handler: ${tool.name} — NO toolUseId in queue (BUG); returning empty`);
				return { content: [{ type: "text", text: "internal error: no tool_use_id" }] };
			}
			// If pi already delivered the result (race: result arrived before handler ran), return immediately.
			const already = frame.pendingResults.get(toolUseId);
			if (already) {
				frame.pendingResults.delete(toolUseId);
				frame.log.debug(`mcp handler: ${tool.name} [${toolUseId}] — early result, returning`);
				return already;
			}
			// Otherwise block until pi delivers via streamSimple() tool-result delivery path.
			frame.log.debug(`mcp handler: ${tool.name} [${toolUseId}] — awaiting pi`);
			return new Promise((resolve) => {
				frame.pendingResolvers.set(toolUseId, resolve);
			});
		},
	}));
	const server = createSdkMcpServer({ name: MCP_SERVER_NAME, version: "1.0.0", tools: mcpTools as any });
	return { [MCP_SERVER_NAME]: server };
}

// ---------------------------------------------------------------------------
// Tool-name & tool-arg mapping (SDK-emitted names → pi-native names)
// ---------------------------------------------------------------------------

function mapToolName(name: string, customToolNameToPi: Map<string, string>): string {
	const normalized = name.toLowerCase();
	const builtin = SDK_TO_PI_TOOL_NAME[normalized];
	if (builtin) return builtin;
	const mapped = customToolNameToPi.get(name) ?? customToolNameToPi.get(normalized);
	if (mapped) return mapped;
	if (normalized.startsWith(MCP_TOOL_PREFIX)) return name.slice(MCP_TOOL_PREFIX.length);
	return name;
}

function mapToolArgs(toolName: string, args: Record<string, unknown> | undefined): Record<string, unknown> {
	const input = args ?? {};
	const renames = SDK_KEY_RENAMES[toolName.toLowerCase()];
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) {
		const piKey = renames?.[key] ?? key;
		if (!(piKey in result)) result[piKey] = value;
	}
	if (toolName.toLowerCase() === "bash" && result.timeout == null) result.timeout = 120;
	return result;
}

// ---------------------------------------------------------------------------
// Usage — surface SDK token counts (incl. cache_read / cache_creation) to pi.
// ---------------------------------------------------------------------------

function updateUsage(frame: QueryFrame, usage: Record<string, number | undefined>) {
	const output = frame.turnOutput;
	if (!output) return;
	const model = frame.model;
	if (usage.input_tokens != null) output.usage.input = usage.input_tokens;
	if (usage.output_tokens != null) output.usage.output = usage.output_tokens;
	if (usage.cache_read_input_tokens != null) output.usage.cacheRead = usage.cache_read_input_tokens;
	if (usage.cache_creation_input_tokens != null) output.usage.cacheWrite = usage.cache_creation_input_tokens;
	output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
	calculateCost(model, output.usage);
	frame.log.debug(
		{ in: output.usage.input, out: output.usage.output, cacheRead: output.usage.cacheRead, cacheWrite: output.usage.cacheWrite },
		`usage: in=${output.usage.input} out=${output.usage.output} cacheRead=${output.usage.cacheRead} cacheWrite=${output.usage.cacheWrite} model=${model.id}`,
	);
}

// ---------------------------------------------------------------------------
// SDK message → pi event-stream translation
// ---------------------------------------------------------------------------

function mapStopReason(reason: string | undefined): "stop" | "length" | "toolUse" {
	switch (reason) {
		case "tool_use": return "toolUse";
		case "max_tokens": return "length";
		default: return "stop";
	}
}

function parsePartialJson(input: string, fallback: Record<string, unknown>): Record<string, unknown> {
	if (!input) return fallback;
	try { return JSON.parse(input); } catch { return fallback; }
}

function ensureTurnStarted(frame: QueryFrame) {
	if (!frame.turnStarted && frame.currentPiStream && frame.turnOutput) {
		frame.currentPiStream.push({ type: "start", partial: frame.turnOutput });
		frame.turnStarted = true;
	}
}

/**
 * Mirror frame.turnBlocks → frame.turnOutput.content. The partial message
 * is what pi-ai consumers read for the final assembled response. We sync on
 * every block-level mutation so the `done`/`error` event message is correct.
 */
function syncTurnContent(frame: QueryFrame) {
	if (!frame.turnOutput) return;
	const out: any[] = [];
	for (const b of frame.turnBlocks) {
		if (b.type === "text") out.push({ type: "text", text: b.text });
		else if (b.type === "thinking") out.push({ type: "thinking", thinking: b.thinking, thinkingSignature: b.thinkingSignature });
		else if (b.type === "toolCall") out.push({ type: "toolCall", id: b.id, name: b.name, arguments: b.arguments });
	}
	frame.turnOutput.content = out;
}

/**
 * T1.14a: commit the streamed partial into the frame's turnOutput as the
 * ABORTED message. Mirrors turnBlocks → content via syncTurnContent (preserving
 * streamed text + any prior tool_use blocks) and, when no text block exists,
 * appends a synthetic "[interrupted]" text block so the abandoned prefix always
 * survives into pi history for next-turn cold-replay (S7/S13 coherence). The
 * caller then sets stopReason/errorMessage. Applies to BOTH drivers. Returns
 * the same turnOutput for convenience; does NOT replace it with a fresh one.
 */
function commitAbortedPartial(frame: QueryFrame): AssistantMessage | null {
	if (!frame.turnOutput) return null;
	syncTurnContent(frame);
	const hasText = frame.turnBlocks.some((b) => b.type === "text");
	if (!hasText) {
		frame.turnBlocks.push({ type: "text", text: "[interrupted]" });
		syncTurnContent(frame);
	}
	return frame.turnOutput;
}

function newTurnOutput(model: Model<any>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages" as any,
		provider: PROVIDER_ID as any,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function resetTurnState(frame: QueryFrame) {
	frame.turnOutput = newTurnOutput(frame.model);
	frame.turnStarted = false;
	frame.turnSawToolCall = false;
	frame.turnBlocks = [];
}

/**
 * Translate one SDK stream event into pi event-stream pushes.
 * Ends the current pi stream on tool_use so pi can execute the tool.
 */
function processStreamEvent(frame: QueryFrame, message: SDKMessage) {
	if (!frame.currentPiStream || !frame.turnOutput) return;
	const event = (message as any).event;
	if (!event) return;

	if (event.type === "message_start") {
		if (event.message?.usage) updateUsage(frame, event.message.usage);
		return;
	}

	if (event.type === "content_block_start") {
		ensureTurnStarted(frame);
		const cb = event.content_block;
		if (cb?.type === "text") {
			frame.turnBlocks.push({ type: "text", text: "", index: event.index });
			frame.currentPiStream.push({ type: "text_start", contentIndex: frame.turnBlocks.length - 1, partial: frame.turnOutput });
		} else if (cb?.type === "thinking") {
			frame.turnBlocks.push({ type: "thinking", thinking: "", thinkingSignature: "", index: event.index });
			frame.currentPiStream.push({ type: "thinking_start", contentIndex: frame.turnBlocks.length - 1, partial: frame.turnOutput });
		} else if (cb?.type === "tool_use") {
			frame.turnSawToolCall = true;
			// Only enqueue ids for tools whose handlers we own (mcp__custom-tools__*).
			// Built-in SDK tools (ToolSearch, Skill, etc.) emit content_block_start
			// but bypass our MCP handlers entirely. If we enqueued them, the next
			// call to one of OUR handlers would shift a stale built-in id, causing
			// every subsequent tool result to lag by one slot. (See bug RCA on
			// session 019dcb97.)
			if (typeof cb.name === "string" && cb.name.startsWith(MCP_TOOL_PREFIX)) {
				frame.toolUseIdQueue!.push(cb.id);
			} else {
				frame.log.warn({ tool: cb.name, id: cb.id }, `processStreamEvent: built-in tool_use observed (${cb.name}) — skipping queue push to prevent off-by-N`);
			}
			frame.turnBlocks.push({
				type: "toolCall", id: cb.id,
				name: mapToolName(cb.name, frame.customToolNameToPi),
				arguments: (cb.input as Record<string, unknown>) ?? {},
				partialJson: "", index: event.index,
			});
			frame.currentPiStream.push({ type: "toolcall_start", contentIndex: frame.turnBlocks.length - 1, partial: frame.turnOutput });
		}
		return;
	}

	if (event.type === "content_block_delta") {
		const idx = frame.turnBlocks.findIndex((b) => b.index === event.index);
		const block = frame.turnBlocks[idx];
		if (!block) return;
		const delta = event.delta;
		if (delta?.type === "text_delta" && block.type === "text") {
			block.text += delta.text;
			frame.currentPiStream.push({ type: "text_delta", contentIndex: idx, delta: delta.text, partial: frame.turnOutput });
		} else if (delta?.type === "thinking_delta" && block.type === "thinking") {
			block.thinking += delta.thinking;
			frame.currentPiStream.push({ type: "thinking_delta", contentIndex: idx, delta: delta.thinking, partial: frame.turnOutput });
		} else if (delta?.type === "input_json_delta" && block.type === "toolCall") {
			block.partialJson += delta.partial_json;
			block.arguments = parsePartialJson(block.partialJson, block.arguments);
			frame.currentPiStream.push({ type: "toolcall_delta", contentIndex: idx, delta: delta.partial_json, partial: frame.turnOutput });
		} else if (delta?.type === "signature_delta" && block.type === "thinking") {
			block.thinkingSignature = (block.thinkingSignature ?? "") + delta.signature;
		}
		return;
	}

	if (event.type === "content_block_stop") {
		const idx = frame.turnBlocks.findIndex((b) => b.index === event.index);
		const block = frame.turnBlocks[idx];
		if (!block) return;
		delete block.index;
		if (block.type === "text") {
			syncTurnContent(frame);
			frame.currentPiStream.push({ type: "text_end", contentIndex: idx, content: block.text, partial: frame.turnOutput });
		} else if (block.type === "thinking") {
			syncTurnContent(frame);
			frame.currentPiStream.push({ type: "thinking_end", contentIndex: idx, content: block.thinking, partial: frame.turnOutput });
		} else if (block.type === "toolCall") {
			frame.turnSawToolCall = true;
			block.arguments = mapToolArgs(block.name, parsePartialJson(block.partialJson, block.arguments));
			delete block.partialJson;
			syncTurnContent(frame);
			frame.currentPiStream.push({ type: "toolcall_end", contentIndex: idx, toolCall: block, partial: frame.turnOutput });
		}
		return;
	}

	if (event.type === "message_delta") {
		if (event.delta?.stop_reason) frame.turnOutput.stopReason = mapStopReason(event.delta.stop_reason);
		if (event.usage) updateUsage(frame, event.usage);
		return;
	}

	if (event.type === "message_stop" && frame.turnSawToolCall) {
		// Tool calls in this assistant message — end the pi stream so pi executes.
		// The SDK is now blocked on our MCP handlers awaiting pi's results.
		syncTurnContent(frame);
		frame.turnOutput.stopReason = "toolUse";
		frame.currentPiStream.push({ type: "done", reason: "toolUse", message: frame.turnOutput });
		frame.currentPiStream.end();
		frame.currentPiStream = null;
		return;
	}
}

/** Background SDK consumer. Loops until the query ends or aborts. */
async function consumeQuery(frame: QueryFrame): Promise<{ sessionId?: string }> {
	let sessionId: string | undefined;
	try {
		for await (const message of frame.sdkQuery!) {
			if (frame.wasAborted) break;
			switch (message.type) {
				case "stream_event":
					processStreamEvent(frame, message);
					break;
				case "system":
					if ((message as any).subtype === "init" && (message as any).session_id) {
						sessionId = (message as any).session_id;
						// Immediately update the module-level cache so a
						// subsequent supersession (mid-flight steer / abort+
						// retype) can resume into this same session, which
						// preserves prior conversation context up to the
						// interrupted point.
						cachedSessionId = sessionId;
						cachedSessionCwd = frame.cwd;
						// Re-bind frame logger to include the CC session_id so
						// subsequent logs in this frame are filterable by it.
						frame.log = frame.log.child({ ccSessionId: sessionId.slice(0, 8) });
						frame.log.debug(`consumeQuery: captured session=${sessionId.slice(0, 8)} mid-flight`);
					}
					break;
				case "result":
					// Final summary; rely on `assistant` + stream_event to populate content.
					break;
				case "assistant": {
					// stream_event covers content; the SDK's reconstructed assistant
					// message carries the consolidated final usage (incl. cache_read /
					// cache_creation), which the partial message_delta sometimes omits.
					// Without this, pi's persisted AssistantMessage.usage shows
					// cacheRead/cacheWrite=0 even when caching was active.
					const u = (message as any).message?.usage;
					if (u && frame.turnOutput) updateUsage(frame, u);
					break;
				}
				case "user":
					// stream_event already covers content; ignore.
					break;
				default:
					break;
			}
		}
	} catch (err) {
		frame.log.error({ err: err instanceof Error ? err.message : String(err) }, "consumeQuery: error");
		if (frame.turnOutput) {
			frame.turnOutput.stopReason = frame.wasAborted ? "aborted" : "error";
			frame.turnOutput.errorMessage = err instanceof Error ? err.message : String(err);
		}
	}
	return { sessionId };
}

// ---------------------------------------------------------------------------
// Prompt extraction (last user message, with optional images)
// ---------------------------------------------------------------------------

function extractUserPrompt(messages: Context["messages"]): string | null {
	const last = messages[messages.length - 1];
	if (!last || last.role !== "user") return null;
	if (typeof last.content === "string") return last.content;
	return messageContentToText(last.content) || "";
}

function extractUserPromptBlocks(messages: Context["messages"]): ContentBlockParam[] | null {
	const last = messages[messages.length - 1];
	if (!last || last.role !== "user" || typeof last.content === "string" || !Array.isArray(last.content)) return null;
	let hasImage = false;
	const blocks: ContentBlockParam[] = [];
	for (const block of last.content) {
		if (block.type === "text" && block.text) {
			blocks.push({ type: "text", text: block.text });
		} else if (block.type === "image" && (block as any).data && (block as any).mimeType) {
			hasImage = true;
			blocks.push({
				type: "image",
				source: { type: "base64", media_type: (block as any).mimeType as Base64ImageSource["media_type"], data: (block as any).data },
			});
		}
	}
	return hasImage ? blocks : null;
}

async function* wrapPromptStream(blocks: ContentBlockParam[]): AsyncIterable<SDKUserMessage> {
	yield { type: "user", message: { role: "user", content: blocks } as MessageParam, parent_tool_use_id: null };
}

/**
 * Build a cold-start prompt that embeds pi's full prior conversation as text
 * context, followed by the new user message. Used when no `cachedSessionId`
 * is available (first turn after bridge restart, after fork/compact, etc.).
 *
 * The SDK's query() interface only accepts a single prompt at start time;
 * there's no way to seed a multi-turn transcript at query creation. So we
 * pack the prior conversation into a single user message that the model
 * reads as background context. Format is intentionally explicit so the
 * model knows it's history, not the current request.
 */
function buildColdStartPrompt(messages: Context["messages"]): string {
	if (messages.length === 0) return "";
	if (messages.length === 1 && messages[0].role === "user") {
		// First-ever turn — no prior history to embed.
		return typeof messages[0].content === "string"
			? messages[0].content
			: messageContentToText(messages[0].content) || "";
	}

	const last = messages[messages.length - 1];
	const lastIsUser = last.role === "user";
	const priorMessages = lastIsUser ? messages.slice(0, -1) : messages;

	const priorLines: string[] = [];
	for (const m of priorMessages) {
		if (m.role === "user") {
			const text = typeof m.content === "string" ? m.content : messageContentToText(m.content);
			if (text) priorLines.push(`[user] ${text}`);
		} else if (m.role === "assistant") {
			const blocks = Array.isArray(m.content) ? m.content : [];
			const parts: string[] = [];
			for (const b of blocks) {
				if (b.type === "text" && b.text) parts.push(b.text);
				else if (b.type === "toolCall") parts.push(`[tool: ${b.name}(${JSON.stringify(b.arguments).slice(0, 200)})]`);
			}
			if (parts.length) priorLines.push(`[assistant] ${parts.join(" ")}`);
		} else if (m.role === "toolResult") {
			const text = typeof m.content === "string" ? m.content : messageContentToText(m.content);
			const tag = m.isError ? "tool-error" : "tool-result";
			priorLines.push(`[${tag} ${m.toolName}] ${text.slice(0, 500)}`);
		}
	}

	const lastUserText = lastIsUser
		? (typeof last.content === "string" ? last.content : messageContentToText(last.content))
		: "[continue]";

	if (priorLines.length === 0) return lastUserText || "[continue]";

	return [
		"<conversation_history>",
		"The following is our prior conversation in this session. Treat it as context.",
		...priorLines,
		"</conversation_history>",
		"",
		"User's current message:",
		lastUserText || "[continue]",
	].join("\n");
}

// ---------------------------------------------------------------------------
// Tool-result extraction (find tool_results appended since the last assistant)
// ---------------------------------------------------------------------------

function extractTrailingToolResults(messages: Context["messages"]): Array<{ id: string; content: string; isError: boolean }> {
	// Walk backwards, collect toolResult messages, stop at the first non-toolResult.
	const results: Array<{ id: string; content: string; isError: boolean }> = [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "toolResult") break;
		const content = typeof m.content === "string" ? m.content : messageContentToText(m.content);
		results.unshift({ id: m.toolCallId, content, isError: m.isError });
	}
	return results;
}

// ---------------------------------------------------------------------------
// MCP tool registry from pi's context
// ---------------------------------------------------------------------------

function resolveMcpTools(context: Context, excludeToolName: string): {
	mcpTools: Tool[];
	customToolNameToPi: Map<string, string>;
} {
	const mcpTools: Tool[] = [];
	const customToolNameToPi = new Map<string, string>();
	if (!context.tools) return { mcpTools, customToolNameToPi };
	for (const tool of context.tools) {
		if (tool.name === excludeToolName) continue;
		const sdkName = `${MCP_TOOL_PREFIX}${tool.name}`;
		mcpTools.push(tool);
		customToolNameToPi.set(sdkName, tool.name);
		customToolNameToPi.set(sdkName.toLowerCase(), tool.name);
	}
	return { mcpTools, customToolNameToPi };
}

// ---------------------------------------------------------------------------
// Output-capture classification helpers (Decision 2, 3, 6)
// ---------------------------------------------------------------------------

/**
 * Snapshot pi's active tool names once per call. Returns empty set when
 * piApiRef is null (bridge loaded outside pi extension lifecycle, e.g. tests)
 * or when getActiveTools() throws. With an empty set, every ctx.tools entry
 * is treated as a capture tool — the correct fallback for callers not bound
 * to the pi extension runtime (per spec "`piApiRef === null` fallback").
 * Uses getActiveTools() NOT getAllTools() so registered-but-inactive names
 * are correctly classified as capture-side (Decision 2).
 */
export function getActiveToolNameSet(): Set<string> {
	try {
		// getActiveTools() returns string[] (tool names) per ExtensionAPI type.
		const names = piApiRef?.getActiveTools() ?? [];
		return new Set(names);
	} catch {
		return new Set();
	}
}

/**
 * Partition context.tools into executable (pi-registered) and capture
 * (unregistered) tools. Skips excludeName (e.g. AskClaude built-in).
 */
export function classifyToolsForCapture(
	context: Context,
	activeNames: Set<string>,
	excludeName: string,
): { executable: Tool[]; capture: Tool[] } {
	const executable: Tool[] = [];
	const capture: Tool[] = [];
	if (!context.tools) return { executable, capture };
	for (const tool of context.tools) {
		if (tool.name === excludeName) continue;
		if (activeNames.has(tool.name)) {
			executable.push(tool);
		} else {
			capture.push(tool);
		}
	}
	return { executable, capture };
}

/**
 * Deep JSON-only clone of a schema: preserves every JSON-serializable keyword
 * at every depth (minLength, maxLength, minItems, maxItems, pattern, enum,
 * required, nested properties, items, etc.) and naturally drops TypeBox
 * symbol-keyed metadata (Symbol(Kind), Symbol(Modifier), etc.) which
 * JSON.stringify skips at every depth. Per design Decision 6.
 */
export function cleanSchemaForSdk(schema: unknown): Record<string, unknown> {
	return JSON.parse(JSON.stringify(schema));
}

type CaptureCallShape =
	| { kind: "all-executable" }
	| { kind: "single-capture"; captureTool: Tool; cleanedSchema: Record<string, unknown> }
	| { kind: "rejected"; reason: string };

/**
 * Enforce Decision 3: capture mode is mutually exclusive with executable
 * tools, and requires exactly one capture tool with an object-root schema.
 */
export function validateCaptureCallShape({
	executable,
	capture,
}: { executable: Tool[]; capture: Tool[] }): CaptureCallShape {
	if (capture.length === 0) {
		return { kind: "all-executable" };
	}
	if (capture.length === 1 && executable.length === 0) {
		const captureTool = capture[0];
		const cleanedSchema = cleanSchemaForSdk(captureTool.parameters);
		if (cleanedSchema.type !== "object") {
			return {
				kind: "rejected",
				reason: `capture tool "${captureTool.name}" has non-object root schema type "${String(cleanedSchema.type)}" — capture mode requires an object root schema (Type.Object(...)). v1 limitation.`,
			};
		}
		return { kind: "single-capture", captureTool, cleanedSchema };
	}
	if (capture.length > 1 && executable.length === 0) {
		return {
			kind: "rejected",
			reason: `bridge output-capture v1 supports exactly one capture tool per call; ${capture.length} unregistered tools found: [${capture.map((t) => t.name).join(", ")}]. Split into separate calls or use exactly one capture tool.`,
		};
	}
	// Mixed: at least one capture tool alongside executable tools
	return {
		kind: "rejected",
		reason: `capture mode (unregistered: [${capture.map((t) => t.name).join(", ")}]) is mutually exclusive with executable tools (registered: [${executable.map((t) => t.name).join(", ")}]) in v1. A call must use either all executable tools or exactly one capture tool. v1 limitation.`,
	};
}

// ---------------------------------------------------------------------------
// Provider entry point: streamSimple
// ---------------------------------------------------------------------------

export function streamClaudeAgentSdk(
	model: Model<any>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = newAssistantMessageEventStream();
	const lastMsg = context.messages[context.messages.length - 1];

	// ---- Case 1: tool-result delivery for the active query frame ----
	const active = top();
	if (active && lastMsg?.role === "toolResult") {
		const trailing = extractTrailingToolResults(context.messages);
		active.log.debug({ results: trailing.length, resolvers: active.pendingResolvers.size }, `streamSimple: tool-result delivery, ${trailing.length} results, ${active.pendingResolvers.size} resolvers waiting`);

		// Option H: pre-scan to find which (if any) frame the trailing
		// tool_result(s) belong to, so we can decide whether to wire the
		// stream into the active frame (normal flow) or close it with
		// aborted-error (the matched frame is post-abort, SDK won't generate
		// further content).
		let matchedFrame: QueryFrame | null = null;
		for (const r of trailing) {
			for (let i = stack.length - 1; i >= 0; i--) {
				if (stack[i].pendingResolvers.has(r.id)) { matchedFrame = stack[i]; break; }
			}
			if (matchedFrame) break;
		}
		const willHangIfWired = matchedFrame ? matchedFrame.wasAborted : active.wasAborted;

		// Wire the stream BEFORE resolving — only if the matched frame is
		// still live. A live frame's SDK will continue generating into this
		// stream after the resolver fires.
		if (!willHangIfWired) {
			active.currentPiStream = stream;
			resetTurnState(active);
		}

		// Deliver each result to the matching resolver across the stack.
		for (const r of trailing) {
			const result = { content: [{ type: "text" as const, text: r.content || "" }], isError: r.isError };
			let resolved = false;
			for (let i = stack.length - 1; i >= 0; i--) {
				const f = stack[i];
				const resolver = f.pendingResolvers.get(r.id);
				if (resolver) {
					f.pendingResolvers.delete(r.id);
					resolver(result);
					if (i !== stack.length - 1 || f.wasAborted) {
						f.log.info({ id: r.id, aborted: f.wasAborted }, `tool-result delivery: matched ${f.wasAborted ? "aborted-frame" : "buried-frame"} resolver (post-abort late delivery)`);
					}
					resolved = true;
					break;
				}
			}
			if (!resolved) {
				active.pendingResults.set(r.id, result);
			}
		}

		// If the matched frame is aborted, close the stream now — its SDK
		// won't write anything more. The resolver did still get the real
		// content; it lives in the SDK's session JSONL for next-turn resume.
		if (willHangIfWired) {
			queueMicrotask(() => {
				const out = newTurnOutput(model);
				out.stopReason = "aborted";
				out.errorMessage = "Operation aborted by user (real tool result captured for next-turn resume)";
				try {
					stream.push({ type: "start", partial: out });
					stream.push({ type: "error", reason: "aborted", error: out });
					stream.end();
				} catch { /* stream may have ended */ }
				(matchedFrame ?? active).log.info({ deliveredFor: "aborted-frame" }, "tool-result delivery to aborted frame: closed pi stream with aborted-error");
			});
		}
		return stream;
	}

	// ---- Case 2: orphaned tool result (no frame on the stack at all) ----
	// We've already scanned all frames for resolvers in Case 1 above. If we
	// reach here, the stack is genuinely empty — pi delivered a tool_result
	// for a frame we already cleaned up. Emit aborted so pi's TUI treats it
	// as the (already-fired) abort it represents, not a phantom completion.
	if (lastMsg?.role === "toolResult") {
		const orphanLog = logger.child({ piSessionId: getPiSessionId() });
		orphanLog.warn(`streamSimple: orphaned tool result, no active query — emitting end_turn`);
		queueMicrotask(() => {
			const out = newTurnOutput(model);
			out.stopReason = "aborted";
			out.errorMessage = "Operation aborted (tool result arrived after abort)";
			stream.push({ type: "start", partial: out });
			stream.push({ type: "error", reason: "aborted", error: out });
			stream.end();
			orphanLog.info("pushAbortedError: orphan tool result post-abort");
		});
		return stream;
	}

	// ---- Case 0: output-capture shape gate (Decision 10) ----
	// Classification runs only when lastMsg?.role !== "toolResult" (i.e. fresh-turn
	// path). Cases 1 and 2 above have already returned for tool-result delivery.
	// We check here — before touching the stack or shared state — so a capture
	// call never supersedes an active user frame (Decision 4).
	{
		const activeNames = getActiveToolNameSet();
		const { executable, capture } = classifyToolsForCapture(context, activeNames, askClaudeToolName);
		const shape = validateCaptureCallShape({ executable, capture });

		if (shape.kind === "rejected") {
			log.warn({ captureTool: capture.map((t) => t.name), executable: executable.map((t) => t.name) }, `streamSimple: rejected capture-shape: ${shape.reason}`);
			queueMicrotask(() => {
				const out = newTurnOutput(model);
				out.stopReason = "error";
				out.errorMessage = shape.reason;
				stream.push({ type: "start", partial: out });
				stream.push({ type: "error", reason: "error", error: out });
				stream.end();
			});
			return stream;
		}

		if (shape.kind === "single-capture") {
			runCaptureQuery(model, shape.captureTool, shape.cleanedSchema, context, options, stream);
			return stream;
		}

		// shape.kind === "all-executable" — fall through to Case 3.
	}

	// ---- Case 3: fresh user turn (or subagent / steer-as-fresh) ----
	// If there's an active query that didn't resolve, the new user turn supersedes it:
	// interrupt and start fresh. This handles steering, rapid retype, and aborts that
	// arrived without a clean shutdown.
	//
	// Option H drain-on-supersede: if the superseded frame still has pending
	// MCP resolvers (an aborted tool_use whose real result never arrived from
	// pi), drain them here with the canonical synthetic text. By definition,
	// pi has now decided to move on (it's sending a new user turn instead of
	// delivering the tool_result), so it's safe to fabricate. Drain BEFORE
	// the pop so we don't lose the resolvers. Also drain any deeper buried
	// frames whose pending tool calls were also superseded by this turn.
	if (active) {
		active.log.info(`streamSimple: superseding active frame (top of stack), interrupting`);
		drainPendingResolversAsAborted(active, "superseded by new user turn");
		active.wasAborted = true;
		abortFrame(active);
		stack.pop();
		// Drain any deeper buried frames too — they're equally orphaned by
		// the steer. Without this, a parent_frame buried beneath a popped
		// child would keep its pending resolvers forever.
		while (stack.length > 0) {
			const buried = stack[stack.length - 1];
			if (buried.pendingResolvers.size === 0 && !buried.wasAborted) break;
			drainPendingResolversAsAborted(buried, "buried beneath superseded frame");
			buried.wasAborted = true;
			abortFrame(buried);
			stack.pop();
		}
	}

	startFreshQuery(model, context, options, stream);
	return stream;
}

/** Drain a frame's pendingResolvers with the canonical interrupted-by-user
 * text. Used by Case 3 supersede and clearSession. The text is what lands in
 * the SDK's session JSONL as the tool_result content, so it must be
 * unambiguous about user attribution to keep resume coherence. */
const ABORTED_TOOL_RESULT_TEXT = "[Tool execution interrupted by user before completion]";

/**
 * Stop a frame's underlying driver (T1.9). For claude-p frames this aborts the
 * driver handle (SIGINT to the process group, decoupled abort lifecycle) and
 * stops the per-spawn router. For sdk frames it interrupts + closes the SDK
 * query. Used by every abort/supersede/clearSession site so the dispatch is
 * driver-agnostic.
 */
function abortFrame(frame: QueryFrame): void {
	if (frame.driverKind === "claude-p") {
		frame.claudeHandle?.abort();
		void frame.router?.stop();
	} else {
		void frame.sdkQuery?.interrupt().catch(() => {});
		try { (frame.sdkQuery as any)?.close?.(); } catch { /* ignore */ }
	}
}

function drainPendingResolversAsAborted(frame: QueryFrame, reason: string) {
	const drained = frame.pendingResolvers.size;
	if (drained === 0) return;
	for (const resolver of frame.pendingResolvers.values()) {
		resolver({ content: [{ type: "text", text: ABORTED_TOOL_RESULT_TEXT }], isError: true });
	}
	frame.pendingResolvers.clear();
	frame.log.info({ drained, reason, text: ABORTED_TOOL_RESULT_TEXT }, `drainPendingResolversAsAborted: resolved ${drained} pending tool handler(s) with 'interrupted by user' text (${reason})`);
}

function startFreshQuery(
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	stream: AssistantMessageEventStream,
): void {
	// ---- Driver dispatch (T1.8). Single early branch; SDK body below unchanged. ----
	if (effectiveDriver() === "claude-p") {
		void startFreshQueryClaudeP(model, context, options, stream);
		return;
	}

	const cwd = (options as { cwd?: string } | undefined)?.cwd ?? process.cwd();
	const { mcpTools, customToolNameToPi } = resolveMcpTools(context, askClaudeToolName);

	const promptBlocks = extractUserPromptBlocks(context.messages);
	const promptText = extractUserPrompt(context.messages) ?? "";

	if (!promptText && !promptBlocks) {
		logger.child({ piSessionId: getPiSessionId(), model: model.id }).warn(`streamSimple: empty prompt; last role=${context.messages[context.messages.length - 1]?.role}`);
		queueMicrotask(() => {
			const empty = newTurnOutput(model);
			stream.push({ type: "start", partial: empty });
			stream.push({ type: "done", reason: "stop", message: empty });
			stream.end();
		});
		return;
	}

	// On a fresh user turn, decide whether to resume the cached CC session.
	// Hot path: cachedSessionId set + same cwd → resume (cache read).
	// Cold path: cachedSessionId null OR different cwd OR pi forked/compacted →
	//            no resume; SDK creates a fresh session_id (cache creation). We
	//            replay full pi history as the prompt so the SDK has context.
	//
	// We detect "history shape changed" implicitly via cachedSessionId === null,
	// which happens when:
	//   - First turn ever
	//   - Bridge restarted
	//   - Previous turn aborted (we drop the id)
	//   - pi /fork or /compact triggered a clearSession event
	// Divergence detection: if any prior-position content changed (or pi's
	// history is shorter than what we last sent), pi has /tree-navigated,
	// /fork-ed, or /compact-ed — the SDK's resumed transcript no longer
	// matches and we must cold-start. Forward progress (history grew with
	// new messages) is NOT divergence.
	const newHashes = computeMessageHashes(context.messages);
	const diverged = detectHistoryDivergence(lastSentMessageHashes, newHashes);
	if (diverged) {
		logger.child({ piSessionId: getPiSessionId(), model: model.id }).info(
			{ priorLen: lastSentMessageHashes?.length ?? 0, newLen: newHashes.length, droppedSession: cachedSessionId?.slice(0, 8) ?? null },
			`startFreshQuery: history divergence detected — dropping cached session (was ${cachedSessionId?.slice(0, 8) ?? "none"}). prior_len=${lastSentMessageHashes?.length ?? 0} new_len=${newHashes.length}`,
		);
		cachedSessionId = null;
		cachedSessionCwd = null;
	}
	lastSentMessageHashes = newHashes;

	const useResume = cachedSessionId !== null && cachedSessionCwd === cwd;

	// On cold-start (no cached session_id), pi's full conversation history must
	// be replayed into the prompt — otherwise the SDK's fresh session has no
	// context. On warm-resume, the SDK loads its own JSONL transcript and we
	// only need to send the new user message.
	let prompt: string | AsyncIterable<SDKUserMessage>;
	if (useResume) {
		prompt = promptBlocks ? wrapPromptStream(promptBlocks) : promptText;
	} else {
		// Cold-start: embed pi history. (Image content is not preserved in the
		// embedded text history — it would arrive on subsequent warm turns if
		// the session continues. For first-turn-with-image, the image is in
		// promptBlocks and the message will be the only history anyway.)
		prompt = promptBlocks
			? wrapPromptStream(promptBlocks)
			: buildColdStartPrompt(context.messages);
	}

	const skillsAppend = extractSkillsBlock(context.systemPrompt);
	const agentsAppend = extractAgentsAppend();
	const appendSystem = extractAppendSystem();
	const appendParts = [agentsAppend, appendSystem, skillsAppend].filter((p): p is string => Boolean(p));
	const systemPromptAppend = appendParts.length > 0 ? appendParts.join("\n\n") : undefined;
	// Static system prompt — pi already provides its own, we don't want CC's preset.
	const staticSystemPrompt = systemPromptAppend ?? "You are a helpful coding assistant.";

	const effort = options?.reasoning ? REASONING_TO_EFFORT[options.reasoning] : undefined;
	const extraArgs: Record<string, string | null> = { model: model.id, "strict-mcp-config": null };
	if (effort) extraArgs["thinking-display"] = "summarized";

	// Build the frame BEFORE building the MCP server (handlers close over it).
	const frame: QueryFrame = {
		driverKind: "sdk",
		sdkQuery: null as any,
		currentPiStream: stream,
		turnOutput: newTurnOutput(model),
		turnStarted: false,
		turnSawToolCall: false,
		turnBlocks: [],
		customToolNameToPi,
		model,
		cwd,
		log: logger.child({ piSessionId: getPiSessionId(), model: model.id, cwd }),
		toolUseIdQueue: [],
		pendingResolvers: new Map(),
		pendingResults: new Map(),
		wasAborted: false,
		donePromise: Promise.resolve(),
	};
	const mcpServers = buildMcpServers(mcpTools, frame);

	const queryOptions: NonNullable<Parameters<typeof _realQuery>[0]["options"]> = {
		cwd,
		disallowedTools: DISALLOWED_BUILTIN_TOOLS,
		allowedTools: [`mcp__${MCP_SERVER_NAME}__*`],
		permissionMode: "bypassPermissions",
		includePartialMessages: true,
		systemPrompt: staticSystemPrompt,
		extraArgs,
		...(effort ? { effort } : {}),
		settingSources: [],
		...(mcpServers ? { mcpServers } : {}),
		...(useResume && cachedSessionId ? { resume: cachedSessionId } : {}),
	};

	frame.log.debug(
		{ msgs: context.messages.length, tools: mcpTools.length, resume: useResume ? cachedSessionId?.slice(0, 8) : null, effort: effort ?? "default" },
		`streamSimple: fresh query model=${model.id} msgs=${context.messages.length} tools=${mcpTools.length} ` +
		`resume=${useResume ? cachedSessionId?.slice(0, 8) : "no"} effort=${effort ?? "default"} prompt="${promptText.slice(0, 60)}"`,
	);

	const sdkQuery = _queryFactory({ prompt, options: queryOptions });
	frame.sdkQuery = sdkQuery;
	stack.push(frame);

	// Wire abort. Option H: do NOT pre-drain pendingResolvers. Pi may still
	// deliver a real tool_result (Case 1 below) within milliseconds of the
	// abort firing — if we drain now with synthetic text, that real result
	// gets orphan-pathed and discarded. Instead, leave pendingResolvers
	// alive and let pi's next event decide:
	//   - Real tool_result lands  → Case 1 resolves with real content.
	//   - User sends a new turn   → Case 3 (supersede) drains with synthetic
	//                               text and pops the frame.
	//   - Session shutdown / new  → clearSession drains.
	const onAbort = () => {
		frame.log.info({ pendingResolvers: frame.pendingResolvers.size }, `onAbort: model=${model.id}, pendingResolvers=${frame.pendingResolvers.size} (deferred drain — waiting for pi's next event)`);
		frame.wasAborted = true;
		// Stop further inference. The SDK won't make new requests on this
		// query. Pending MCP handler promises remain unresolved until pi's
		// next event (real result or new turn) decides their fate.
		abortFrame(frame);
		// IMPORTANT: do NOT drop cachedSessionId here. The SDK's session JSONL
		// retains all messages up to the abort point (including the interrupted
		// partial assistant message). On the next user turn, resuming that
		// session preserves the conversation context — which is required so the
		// model knows it was interrupted (S7 coherence, S13 enumeration, etc.).
		// Dropping the id here would force a cold-start with no context.

		// Surface the abort to pi's UI even when we're between SDK turns.
		// If frame.currentPiStream is null, we just nulled it on message_stop
		// (turn ended in toolUse) and pi is now blocking on the tool result.
		// The consumeQuery finalizer can't push to a null stream, so without
		// this branch pi sees nothing — silent abort. We push the aborted
		// error directly onto the original `stream` handed to streamSimple
		// for this turn.
		if (!frame.currentPiStream) {
			try {
				// T1.14a: preserve the streamed partial (text + prior tool_use
				// blocks) in the aborted message rather than emitting a fresh,
				// empty one — so the abandoned prefix survives into pi history.
				const out = commitAbortedPartial(frame) ?? newTurnOutput(model);
				out.stopReason = "aborted";
				out.errorMessage = out.errorMessage ?? "Operation aborted by user";
				stream.push({ type: "error", reason: "aborted", error: out });
				stream.end();
				frame.log.info({ where: "tool-execution-window" }, "pushAbortedError: pi was awaiting tool result, surfacing aborted to pi stream");
			} catch (err) {
				frame.log.warn({ err: err instanceof Error ? err.message : String(err) }, "pushAbortedError: stream may already be ended");
			}
		}
	};
	if (options?.signal) {
		if (options.signal.aborted) onAbort();
		else options.signal.addEventListener("abort", onAbort, { once: true });
	}

	// Background consumer
	frame.donePromise = consumeQuery(frame).then(({ sessionId }) => {
		// Capture session id for next turn's cache resume — even on abort, so
		// the next turn can resume the session and see the interrupted partial
		// (which is needed for the model to know it was interrupted).
		if (sessionId) {
			cachedSessionId = sessionId;
			cachedSessionCwd = cwd;
			frame.log.debug({ aborted: frame.wasAborted }, `streamSimple: caching session=${sessionId.slice(0, 8)} cwd=${cwd}${frame.wasAborted ? " (aborted)" : ""}`);
		}
		// Finalize the most recent stream
		if (frame.currentPiStream && frame.turnOutput) {
			if (frame.wasAborted) {
				// T1.14a: commit the streamed partial (with a synthetic
				// "[interrupted]" text block when no text was streamed) BEFORE
				// stamping the aborted stopReason, so the abandoned prefix
				// survives into pi history for next-turn cold-replay.
				commitAbortedPartial(frame);
				frame.turnOutput.stopReason = "aborted";
				frame.turnOutput.errorMessage = frame.turnOutput.errorMessage ?? "Operation aborted";
				frame.currentPiStream.push({ type: "error", reason: "aborted", error: frame.turnOutput });
			} else if (frame.turnOutput.stopReason === "error") {
				syncTurnContent(frame);
				frame.currentPiStream.push({ type: "error", reason: "error", error: frame.turnOutput });
			} else {
				syncTurnContent(frame);
				if (!frame.turnStarted) ensureTurnStarted(frame);
				const reason = frame.turnOutput.stopReason === "length" ? "length" : "stop";
				frame.currentPiStream.push({ type: "done", reason, message: frame.turnOutput });
			}
			frame.currentPiStream.end();
			frame.currentPiStream = null;
		}
		// Pop frame off stack only if (a) it's still the top, AND (b) it has
		// no pending resolvers waiting for late tool_results. Option H keeps
		// aborted frames on the stack with their pendingResolvers alive, so
		// pi can still deliver real tool_results and we can match them via
		// the all-frames lookup in Case 1. The frame gets cleaned up by Case
		// 3's drain-on-supersede or by clearSession.
		if (top() === frame) {
			if (frame.pendingResolvers.size === 0) {
				stack.pop();
			} else {
				frame.log.info({ pending: frame.pendingResolvers.size }, "consumeQuery finalize: frame retained on stack (pending resolvers may receive late tool_results)");
			}
		}
	}).catch((err) => {
		frame.log.error({ err: err instanceof Error ? err.message : String(err) }, "streamSimple: consumeQuery promise error");
		if (top() === frame && frame.pendingResolvers.size === 0) stack.pop();
	});
}

// ===========================================================================
// claude-p driver path (T1.9) — mirrors the SDK path's translation contract
// but consumes the claude-p subprocess driver + in-process MCP router instead
// of the in-process SDK. The DEFAULT sdk path above is byte-unchanged.
// ===========================================================================

const CLAUDE_P_TIMEOUT_SECONDS = 600; // generous; must not trip on a held tool round (spec)
const PROMPT_FILE_THRESHOLD_BYTES = 50 * 1024; // >50KB → tmpfile (argv-limit safety, constitution III)

/**
 * Resolve the absolute path to the built MCP shim. Prefers the published
 * dist entrypoint (`pi-claude-bridge/dist/src/mcp/shim.js`); falls back to the
 * in-repo TypeScript source under tsx for dev/test. NEVER touches ~/.claude.
 */
function resolveShimPath(): string {
	const req = createRequire(import.meta.url);
	try {
		return req.resolve("pi-claude-bridge/dist/src/mcp/shim.js");
	} catch {
		// Dev/test fallback: built dist next to this module, else TS source.
		const distLocal = join(dirname(new URL(import.meta.url).pathname), "dist", "src", "mcp", "shim.js");
		if (existsSync(distLocal)) return distLocal;
		return join(dirname(new URL(import.meta.url).pathname), "src", "mcp", "shim.ts");
	}
}

/** Spill large/multiline content to a tmpfile under os.tmpdir() (NEVER ~/.claude). */
function writeOverflowTmp(prefix: string, content: string): string {
	const p = join(tmpdir(), `${prefix}-${randomBytes(8).toString("hex")}.txt`);
	writeFileSync(p, content, "utf-8");
	return p;
}

/** Update the frame's usage from a driver `usage` event (already pi-shaped). */
function updateUsageFromDriver(frame: QueryFrame, usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number }) {
	const output = frame.turnOutput;
	if (!output) return;
	output.usage.input = usage.input;
	output.usage.output = usage.output;
	output.usage.cacheRead = usage.cacheRead;
	output.usage.cacheWrite = usage.cacheWrite;
	output.usage.totalTokens = usage.totalTokens;
	calculateCost(frame.model, output.usage);
}

/**
 * THE round-trip trigger (T1.9). Invoked synchronously by router.onPark the
 * instant a `tools/call` parks. Pushes a pi toolCall block keyed by the
 * router-minted `info.piId` (NOT the model `toolu_…`) and ends the pi stream so
 * pi executes the tool. pi later delivers `toolResult.id === piId` → Case 1
 * (unchanged) finds the resolver in frame.pendingResolvers (== router.pendingResolvers)
 * and resolves it, unblocking the shim. Mirrors the SDK message_stop path.
 */
function onRouterPark(frame: QueryFrame, info: ParkedCallInfo): void {
	if (!frame.currentPiStream || !frame.turnOutput) return;
	ensureTurnStarted(frame);
	closeOpenInlineBlocks(frame);
	frame.turnBlocks.push({
		type: "toolCall",
		id: info.piId, // router-minted pi id — the id pi echoes back as toolResult.id
		name: mapToolName(info.name, frame.customToolNameToPi),
		arguments: mapToolArgs(info.name, info.arguments),
	});
	const idx = frame.turnBlocks.length - 1;
	syncTurnContent(frame);
	frame.turnSawToolCall = true;
	frame.turnOutput.stopReason = "toolUse";
	frame.currentPiStream.push({ type: "toolcall_start", contentIndex: idx, partial: frame.turnOutput });
	frame.currentPiStream.push({ type: "toolcall_end", contentIndex: idx, toolCall: frame.turnBlocks[idx], partial: frame.turnOutput });
	frame.currentPiStream.push({ type: "done", reason: "toolUse", message: frame.turnOutput });
	frame.currentPiStream.end();
	frame.currentPiStream = null;
	frame.log.debug({ piId: info.piId, name: info.name }, `onRouterPark: routed tools/call to pi (piId=${info.piId})`);
}

/** Close any still-open inline (text/thinking) blocks before a tool call / turn end. */
function closeOpenInlineBlocks(frame: QueryFrame): void {
	if (!frame.currentPiStream) return;
	for (let i = 0; i < frame.turnBlocks.length; i++) {
		const b = frame.turnBlocks[i];
		if (b.index === undefined) continue;
		const wasOpen = b.index;
		delete b.index;
		if (b.type === "text") {
			frame.currentPiStream.push({ type: "text_end", contentIndex: i, content: b.text, partial: frame.turnOutput });
		} else if (b.type === "thinking") {
			frame.currentPiStream.push({ type: "thinking_end", contentIndex: i, content: b.thinking, partial: frame.turnOutput });
		}
		void wasOpen;
	}
}

/**
 * Translate one driver-internal stream event into pi event-stream pushes
 * (mirrors processStreamEvent). text/thinking deltas open+append inline blocks;
 * tool-use is DISPLAY ONLY (best-effort label of an already-parked block — does
 * NOT push a new block, does NOT route); usage updates token counts; done/error
 * set the terminal stopReason for finalizeClaudePFrame to push.
 */
function processDriverEvent(frame: QueryFrame, ev: DriverStreamEvent): void {
	if (!frame.turnOutput) return;

	switch (ev.kind) {
		case "text-delta": {
			if (!frame.currentPiStream) return;
			ensureTurnStarted(frame);
			let block = frame.turnBlocks.find((b) => b.type === "text" && b.index !== undefined);
			if (!block) {
				block = { type: "text", text: "", index: frame.turnBlocks.length };
				frame.turnBlocks.push(block);
				frame.currentPiStream.push({ type: "text_start", contentIndex: frame.turnBlocks.length - 1, partial: frame.turnOutput });
			}
			const idx = frame.turnBlocks.indexOf(block);
			block.text += ev.text;
			frame.currentPiStream.push({ type: "text_delta", contentIndex: idx, delta: ev.text, partial: frame.turnOutput });
			return;
		}
		case "thinking-delta": {
			if (!frame.currentPiStream) return;
			ensureTurnStarted(frame);
			let block = frame.turnBlocks.find((b) => b.type === "thinking" && b.index !== undefined);
			if (!block) {
				block = { type: "thinking", thinking: "", thinkingSignature: "", index: frame.turnBlocks.length };
				frame.turnBlocks.push(block);
				frame.currentPiStream.push({ type: "thinking_start", contentIndex: frame.turnBlocks.length - 1, partial: frame.turnOutput });
			}
			const idx = frame.turnBlocks.indexOf(block);
			block.thinking += ev.text;
			frame.currentPiStream.push({ type: "thinking_delta", contentIndex: idx, delta: ev.text, partial: frame.turnOutput });
			return;
		}
		case "tool-use": {
			// DISPLAY ONLY (D32). Best-effort: label an already-parked toolCall
			// block whose name+args match. Do NOT push a new block; do NOT route.
			const parked = frame.router?.listParkedCalls() ?? [];
			const match = parked.find((p) => p.name === ev.name);
			if (match) {
				frame.log.debug({ toolu: ev.toolUseId, piId: match.piId }, "processDriverEvent: tool-use observed (display-only correlation)");
			}
			return;
		}
		case "usage": {
			updateUsageFromDriver(frame, ev.usage);
			return;
		}
		case "done": {
			if (frame.currentPiStream) {
				closeOpenInlineBlocks(frame);
				syncTurnContent(frame);
			}
			frame.turnOutput.stopReason = frame.turnSawToolCall ? "toolUse" : "stop";
			return;
		}
		case "error": {
			frame.turnOutput.stopReason = "error";
			frame.turnOutput.errorMessage = ev.errorMessage;
			return;
		}
	}
}

/**
 * Finalize a claude-p frame once its (possibly retried) driver `done` resolves.
 * Caches the session id (even on abort) UNLESS stopReason==="error" (clear so
 * the next turn cold-starts); finalizes the current pi stream like the SDK
 * finalizer; pops the frame iff it's the top and has no pending resolvers.
 */
function finalizeClaudePFrame(frame: QueryFrame, res: ClaudePDoneResult): void {
	const cwd = frame.cwd;
	if (res.stopReason === "error") {
		// Clear cache so the next turn cold-starts (spec: "any cached driver
		// session id is cleared").
		if (cachedSessionId === res.sessionId || cachedSessionCwd === cwd) {
			cachedSessionId = null;
			cachedSessionCwd = null;
		}
		frame.log.warn({ stopReason: res.stopReason, exitCode: res.exitCode }, "finalizeClaudePFrame: error — cleared cached session");
	} else if (res.sessionId) {
		// Cache the session id for next-turn warm resume — even on abort, so the
		// next turn can resume and the model sees the interrupted partial.
		cachedSessionId = res.sessionId;
		cachedSessionCwd = cwd;
		frame.log.debug({ aborted: frame.wasAborted, session: res.sessionId.slice(0, 8) }, `finalizeClaudePFrame: caching session=${res.sessionId.slice(0, 8)}${frame.wasAborted ? " (aborted)" : ""}`);
	}

	// Finalize the most recent stream (mirrors SDK finalizer).
	if (frame.currentPiStream && frame.turnOutput) {
		if (frame.wasAborted || res.stopReason === "aborted") {
			commitAbortedPartial(frame);
			frame.turnOutput.stopReason = "aborted";
			frame.turnOutput.errorMessage = frame.turnOutput.errorMessage ?? "Operation aborted";
			frame.currentPiStream.push({ type: "error", reason: "aborted", error: frame.turnOutput });
		} else if (frame.turnOutput.stopReason === "error") {
			syncTurnContent(frame);
			frame.currentPiStream.push({ type: "error", reason: "error", error: frame.turnOutput });
		} else {
			syncTurnContent(frame);
			if (!frame.turnStarted) ensureTurnStarted(frame);
			frame.currentPiStream.push({ type: "done", reason: "stop", message: frame.turnOutput });
		}
		frame.currentPiStream.end();
		frame.currentPiStream = null;
	}

	if (top() === frame) {
		if (frame.pendingResolvers.size === 0) {
			void frame.router?.stop();
			stack.pop();
		} else {
			frame.log.info({ pending: frame.pendingResolvers.size }, "finalizeClaudePFrame: frame retained on stack (pending resolvers may receive late tool_results)");
		}
	}
}

/**
 * claude-p main-provider fresh turn (T1.9). Reuses the SDK path's prompt /
 * session / system-prompt assembly verbatim, then spawns the claude-p driver
 * with a per-spawn MCP router whose onPark drives the pi round-trip. May be
 * async (awaits router.start()); the dispatcher does `void startFreshQueryClaudeP(...)`.
 */
async function startFreshQueryClaudeP(
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	stream: AssistantMessageEventStream,
): Promise<void> {
	const cwd = (options as { cwd?: string } | undefined)?.cwd ?? process.cwd();
	const { mcpTools, customToolNameToPi } = resolveMcpTools(context, askClaudeToolName);

	const promptBlocks = extractUserPromptBlocks(context.messages);
	const promptText = extractUserPrompt(context.messages) ?? "";

	if (!promptText && !promptBlocks) {
		logger.child({ piSessionId: getPiSessionId(), model: model.id }).warn(`streamSimple[claude-p]: empty prompt; last role=${context.messages[context.messages.length - 1]?.role}`);
		queueMicrotask(() => {
			const empty = newTurnOutput(model);
			stream.push({ type: "start", partial: empty });
			stream.push({ type: "done", reason: "stop", message: empty });
			stream.end();
		});
		return;
	}

	// Image handling: claude-p cannot inject images — strip + warn, deliver text-only.
	let imageCount = 0;
	for (const m of context.messages) {
		const content = Array.isArray(m.content) ? m.content : [];
		for (const b of content) if ((b as any).type === "image") imageCount++;
	}
	if (imageCount > 0) {
		logger.child({ piSessionId: getPiSessionId(), model: model.id }).warn({ imageCount }, `streamSimple[claude-p]: dropping ${imageCount} image block(s) — claude-p path is text-only (image-strip-on-main-path)`);
	}

	// Divergence detection (verbatim from SDK path).
	const newHashes = computeMessageHashes(context.messages);
	const diverged = detectHistoryDivergence(lastSentMessageHashes, newHashes);
	if (diverged) {
		logger.child({ piSessionId: getPiSessionId(), model: model.id }).info(
			{ priorLen: lastSentMessageHashes?.length ?? 0, newLen: newHashes.length, droppedSession: cachedSessionId?.slice(0, 8) ?? null },
			`startFreshQueryClaudeP: history divergence detected — dropping cached session (was ${cachedSessionId?.slice(0, 8) ?? "none"})`,
		);
		cachedSessionId = null;
		cachedSessionCwd = null;
	}
	lastSentMessageHashes = newHashes;

	const useResume = cachedSessionId !== null && cachedSessionCwd === cwd;

	// Cold → embed full pi history; warm → only the new user message (text-only).
	const promptString = useResume
		? promptText
		: buildColdStartPrompt(context.messages);

	// System-prompt assembly (verbatim from SDK path).
	const skillsAppend = extractSkillsBlock(context.systemPrompt);
	const agentsAppend = extractAgentsAppend();
	const appendSystem = extractAppendSystem();
	const appendParts = [agentsAppend, appendSystem, skillsAppend].filter((p): p is string => Boolean(p));
	const systemPromptAppend = appendParts.length > 0 ? appendParts.join("\n\n") : undefined;
	const staticSystemPrompt = systemPromptAppend ?? "You are a helpful coding assistant.";

	// Build the frame BEFORE the router (onPark closes over it).
	const frame: QueryFrame = {
		driverKind: "claude-p",
		currentPiStream: stream,
		turnOutput: newTurnOutput(model),
		turnStarted: false,
		turnSawToolCall: false,
		turnBlocks: [],
		customToolNameToPi,
		model,
		cwd,
		log: logger.child({ piSessionId: getPiSessionId(), model: model.id, cwd, driver: "claude-p" }),
		pendingResolvers: new Map(),
		pendingResults: new Map(),
		wasAborted: false,
		donePromise: Promise.resolve(),
	};
	resetTurnState(frame);

	// Per-spawn router. Its pending maps ARE the frame's pending maps (by
	// reference) so Case 1 delivery + drainPendingResolversAsAborted work unchanged.
	const router = createRouter({
		logger: frame.log,
		onPark: (info) => onRouterPark(frame, info),
	});
	frame.router = router;
	frame.pendingResolvers = router.pendingResolvers as any;
	frame.pendingResults = router.pendingResults as any;

	// Advertise BARE pi tool names: claude namespaces every MCP tool as
	// `mcp__<server>__<advertisedName>` itself, so the model sees exactly
	// `mcp__custom-tools__<name>` (matching customToolNameToPi keys + the
	// system-prompt tool-notice). Advertising the already-prefixed name would
	// double-prefix to `mcp__custom-tools__mcp__custom-tools__<name>` (G1 finding
	// F1). The shim then receives `tools/call` with the bare name (MCP strips the
	// server prefix), which onRouterPark maps straight back to the pi name.
	const toolDefs: ToolDef[] = mcpTools.map((t) => ({
		name: t.name,
		description: t.description,
		inputSchema: cleanSchemaForSdk(t.parameters),
	}));
	router.declareTools(toolDefs);
	await router.start();

	// Build --mcp-config pointing at the stdio shim for this spawn.
	const shimPath = resolveShimPath();
	const toolsB64 = Buffer.from(JSON.stringify(toolDefs), "utf-8").toString("base64");
	const mcpConfig = JSON.stringify({
		mcpServers: {
			[MCP_SERVER_NAME]: {
				command: process.execPath,
				args: [shimPath, "--socket", router.socketPath, "--mode", "main", "--tools", toolsB64],
			},
		},
	});

	// System prompt: inline text, or file when large.
	const systemPrompt: SystemPromptSource = staticSystemPrompt.length > PROMPT_FILE_THRESHOLD_BYTES
		? { kind: "file", path: writeOverflowTmp("pcb-sysprompt", staticSystemPrompt) }
		: { kind: "text", text: staticSystemPrompt };

	// Prompt: positional, or --input-file when large/multiline.
	const promptSrc: PromptSource = promptString.length > PROMPT_FILE_THRESHOLD_BYTES
		? { kind: "file", path: writeOverflowTmp("pcb-prompt", promptString) }
		: { kind: "positional", text: promptString };

	// Session identity: fresh (new uuid) XOR resume (cached id).
	const session = useResume && cachedSessionId
		? { kind: "resume" as const, sessionId: cachedSessionId }
		: { kind: "fresh" as const, sessionId: randomUUID() };

	const cfg: ClaudePSpawnConfig = {
		model: model.id,
		systemPrompt,
		prompt: promptSrc,
		mcpConfig,
		session,
		timeoutSeconds: CLAUDE_P_TIMEOUT_SECONDS,
	};

	frame.log.debug(
		{ msgs: context.messages.length, tools: mcpTools.length, resume: useResume ? cachedSessionId?.slice(0, 8) : null },
		`streamSimple[claude-p]: fresh spawn model=${model.id} msgs=${context.messages.length} tools=${mcpTools.length} resume=${useResume ? cachedSessionId?.slice(0, 8) : "no"} prompt="${promptText.slice(0, 60)}"`,
	);

	stack.push(frame);

	// Wire abort. Mirror the SDK onAbort: deferred drain; surface aborted to the
	// pi stream when pi is awaiting a tool result (currentPiStream null). Does
	// NOT drop cachedSessionId here (finalizeClaudePFrame handles caching).
	const onAbort = () => {
		frame.log.info({ pendingResolvers: frame.pendingResolvers.size }, `onAbort[claude-p]: pendingResolvers=${frame.pendingResolvers.size} (deferred drain)`);
		frame.wasAborted = true;
		abortFrame(frame);
		if (!frame.currentPiStream) {
			try {
				const out = commitAbortedPartial(frame) ?? newTurnOutput(model);
				out.stopReason = "aborted";
				out.errorMessage = out.errorMessage ?? "Operation aborted by user";
				stream.push({ type: "error", reason: "aborted", error: out });
				stream.end();
				frame.log.info({ where: "tool-execution-window" }, "pushAbortedError[claude-p]: pi was awaiting tool result, surfacing aborted");
			} catch (err) {
				frame.log.warn({ err: err instanceof Error ? err.message : String(err) }, "pushAbortedError[claude-p]: stream may already be ended");
			}
		}
	};
	if (options?.signal) {
		if (options.signal.aborted) onAbort();
		else options.signal.addEventListener("abort", onAbort, { once: true });
	}

	// Spawn via the resilience wrapper. POLICY: retry only while no tools/call
	// has been routed to pi (router.everRoutedToolCall) — D33 idempotency gate.
	const handle = _spawnClaudePFactory(
		cfg,
		{ onEvent: (ev: DriverStreamEvent) => processDriverEvent(frame, ev), logger: frame.log as any },
		{
			maxRetries: 2,
			shouldRetry: () => !router.everRoutedToolCall,
			freshSessionId: () => randomUUID(),
			onRetry: (attempt) => frame.log.warn({ attempt }, `startFreshQueryClaudeP: retrying claude-p spawn (attempt ${attempt})`),
		},
	);
	frame.claudeHandle = handle;
	frame.donePromise = handle.done.then((res) => finalizeClaudePFrame(frame, res));
}

// ---------------------------------------------------------------------------
// runCaptureQuery — isolated output-capture path (Decision 4)
//
// Emits exactly: one `start` event, then one terminal `done(toolUse)` or
// `error` event. Suppresses all intermediate stream events (Decision 5).
//
// ISOLATION INVARIANTS: this function MUST NOT touch:
//   - stack (no push, no pop, no top())
//   - cachedSessionId (no reads or writes)
//   - cachedSessionCwd (no reads or writes)
//   - lastSentMessageHashes (no reads or writes)
// These names are listed here to make it easy to audit for regressions.
// ---------------------------------------------------------------------------

export async function runCaptureQuery(
	model: Model<any>,
	captureTool: Tool,
	cleanedSchema: Record<string, unknown>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	stream: AssistantMessageEventStream,
): Promise<void> {
	const captureLog = logger.child({ piSessionId: getPiSessionId(), model: model.id, mode: "capture", captureTool: captureTool.name });
	captureLog.info(`runCaptureQuery: starting capture for tool "${captureTool.name}" model=${model.id}`);

	// Pre-flight abort check.
	const signal = options?.signal;
	if (signal?.aborted) {
		const out = newTurnOutput(model);
		out.stopReason = "aborted";
		out.errorMessage = "Operation aborted by user";
		stream.push({ type: "start", partial: out });
		stream.push({ type: "error", reason: "aborted", error: out });
		stream.end();
		return;
	}

	// Abort listener (wired after pre-flight, removed in every exit path).
	let streamEnded = false;
	let sdkQueryRef: ReturnType<typeof _realQuery> | null = null;
	const onAbort = () => {
		if (streamEnded) return;
		streamEnded = true;
		const out = newTurnOutput(model);
		out.stopReason = "aborted";
		out.errorMessage = "Operation aborted by user";
		try {
			stream.push({ type: "error", reason: "aborted", error: out });
			stream.end();
		} catch { /* stream already ended */ }
		if (sdkQueryRef) { void sdkQueryRef.interrupt().catch(() => {}); }
		captureLog.info("runCaptureQuery: aborted via signal");
	};
	if (signal) signal.addEventListener("abort", onAbort, { once: true });

	// Image-block warn-log: capture mode is text-only (Decision 9).
	let imageCount = 0;
	for (const m of context.messages) {
		const content = Array.isArray(m.content) ? m.content : [];
		for (const block of content) {
			if ((block as any).type === "image") imageCount++;
		}
	}
	if (imageCount > 0) {
		captureLog.warn({ imageCount }, `runCaptureQuery: dropping ${imageCount} image content block(s) — capture mode is text-only (per design Decision 9)`);
	}

	// Build prompt (text-only; Decision 9 documented fidelity limit).
	const systemPrompt = context.systemPrompt ?? "";
	const prompt = buildColdStartPrompt(context.messages);

	// Empty-prompt guard: reject only when BOTH systemPrompt and prompt are empty.
	if (!systemPrompt && !prompt) {
		const out = newTurnOutput(model);
		out.stopReason = "error";
		out.errorMessage = "capture path: both systemPrompt and prompt are empty — the model has nothing to act on. Provide at least one non-empty message or a non-empty systemPrompt.";
		try {
			stream.push({ type: "start", partial: out });
			stream.push({ type: "error", reason: "error", error: out });
			stream.end();
		} catch { /* ignore */ }
		if (signal) signal.removeEventListener("abort", onAbort);
		return;
	}

	// Build SDK options for the capture path (Decision 12, 13).
	const effort = options?.reasoning ? REASONING_TO_EFFORT[options.reasoning] : undefined;
	const extraArgs: Record<string, string | null> = { model: model.id, "strict-mcp-config": null };
	const captureOptions: NonNullable<Parameters<typeof _realQuery>[0]["options"]> = {
		// outputFormat: JSON-schema structured output (Decision 1, 6)
		outputFormat: { type: "json_schema", schema: cleanedSchema },
		// No mcpServers, no allowedTools (capture has no MCP surface)
		disallowedTools: DISALLOWED_BUILTIN_TOOLS,
		// Permission flags (Decision 13; both set per SDK type-doc requirement)
		permissionMode: "bypassPermissions",
		allowDangerouslySkipPermissions: true,
		// Hermetic cwd (Decision 12: no working-tree dependency)
		cwd: tmpdir(),
		settingSources: [],
		extraArgs,
		...(effort ? { effort } : {}),
		// systemPrompt forwarded verbatim; DO NOT blend pi-UI material (Decision 9)
		systemPrompt,
		// No resume: capture sessions are never warm-resumed (Decision 7)
	};

	captureLog.info({ schema: JSON.stringify(cleanedSchema).slice(0, 200) }, `streamSimple: fresh query model=${model.id} mode=capture captureTool=${captureTool.name} prompt="${prompt.slice(0, 60)}"`);

	// Wrap SDK construction in try/catch (Decision 12: surface sync throw as error).
	let sdkQuery: ReturnType<typeof _realQuery>;
	try {
		sdkQuery = _queryFactory({ prompt, options: captureOptions });
		sdkQueryRef = sdkQuery;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		const out = newTurnOutput(model);
		out.stopReason = "error";
		out.errorMessage = `capture path SDK construction failed: ${msg}`;
		try {
			stream.push({ type: "start", partial: out });
			stream.push({ type: "error", reason: "error", error: out });
			stream.end();
		} catch { /* ignore */ }
		if (signal) signal.removeEventListener("abort", onAbort);
		captureLog.error({ err: msg }, `runCaptureQuery: SDK construction failed: ${msg}`);
		return;
	}

	// Push start event (Decision 5: exactly one start + one terminal event).
	const startOut = newTurnOutput(model);
	stream.push({ type: "start", partial: startOut });

	// Iterate SDK messages locally. Do NOT call consumeQuery (isolation requirement).
	// Suppress all intermediate events; only inspect `result` SDKMessage (Decision 5).
	let sawResult = false;
	let capturedPid: number | undefined; // best-effort, don't fail if not exposed

	try {
		for await (const message of sdkQuery) {
			if (streamEnded) break;

			if (message.type === "system" && (message as any).subtype === "init") {
				// Capture child PID at system:init (best-effort; not all SDK versions expose it).
				if ((message as any).pid) capturedPid = (message as any).pid;
				captureLog.info({ session: (message as any).session_id?.slice(0, 8), pid: capturedPid },
					`runCaptureQuery: system:init session=${(message as any).session_id?.slice(0, 8)} pid=${capturedPid ?? "(not exposed)"}`
				);
				// ISOLATION: do NOT write cachedSessionId, cachedSessionCwd, lastSentMessageHashes
				continue;
			}

			if (message.type !== "result") {
				// Suppress all non-result messages (Decision 5): no pi-ai events emitted.
				captureLog.debug({ type: message.type }, `runCaptureQuery: suppressing ${message.type} message`);
				continue;
			}

			// ---- result SDKMessage ----
			sawResult = true;
			const result = message as any;

			// Map usage (Decision 5).
			const out = newTurnOutput(model);
			if (result.usage) {
				if (result.usage.input_tokens != null) out.usage.input = result.usage.input_tokens;
				if (result.usage.output_tokens != null) out.usage.output = result.usage.output_tokens;
				if (result.usage.cache_read_input_tokens != null) out.usage.cacheRead = result.usage.cache_read_input_tokens;
				if (result.usage.cache_creation_input_tokens != null) out.usage.cacheWrite = result.usage.cache_creation_input_tokens;
				out.usage.totalTokens = out.usage.input + out.usage.output + out.usage.cacheRead + out.usage.cacheWrite;
				calculateCost(model, out.usage);
			}

			if (result.structured_output !== undefined) {
				// Success path (Decision 5): synthesize toolCall block.
				// Generate toolu_<random> id (matches Anthropic's prefix convention).
				const toolCallId = "toolu_" + randomBytes(8).toString("hex");
				out.stopReason = "toolUse";
				out.content = [{
					type: "toolCall",
					id: toolCallId,
					name: captureTool.name,
					arguments: result.structured_output as Record<string, unknown>,
				}];
				captureLog.info({ toolCallId, tool: captureTool.name, in: out.usage.input, out: out.usage.output }, `runCaptureQuery: success structured_output for ${captureTool.name}`);
				if (!streamEnded) {
					streamEnded = true;
					try {
						stream.push({ type: "done", reason: "toolUse", message: out });
						stream.end();
					} catch { /* ignore */ }
				}
			} else {
				// Error path: any terminal result lacking structured_output (Decision 5).
				const subtype = result.subtype ?? "unknown";
				const isErr = result.is_error ? " is_error=true" : "";
				out.stopReason = "error";
				out.errorMessage = `SDK structured-output failure: subtype=${subtype}${isErr}`;
				captureLog.warn({ subtype, is_error: result.is_error }, `runCaptureQuery: result without structured_output: ${out.errorMessage}`);
				if (!streamEnded) {
					streamEnded = true;
					try {
						stream.push({ type: "error", reason: "error", error: out });
						stream.end();
					} catch { /* ignore */ }
				}
			}

			// After terminal event: best-effort interrupt, then break (Decision 5).
			void sdkQuery.interrupt().catch(() => {});
			break;
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		captureLog.error({ err: msg }, `runCaptureQuery: iterator error: ${msg}`);
		if (!streamEnded) {
			streamEnded = true;
			const out = newTurnOutput(model);
			out.stopReason = "error";
			out.errorMessage = `capture path SDK iterator error: ${msg}`;
			try {
				stream.push({ type: "error", reason: "error", error: out });
				stream.end();
			} catch { /* ignore */ }
		}
	}

	// Iterator closed without result (e.g. empty iterator, interrupted before result).
	if (!sawResult && !streamEnded) {
		streamEnded = true;
		const out = newTurnOutput(model);
		out.stopReason = "error";
		out.errorMessage = "capture path SDK iterator closed without result message";
		captureLog.warn("runCaptureQuery: iterator closed without result");
		try {
			stream.push({ type: "error", reason: "error", error: out });
			stream.end();
		} catch { /* ignore */ }
	}

	// Finalize: remove abort listener (every exit path must reach here).
	if (signal) signal.removeEventListener("abort", onAbort);
	captureLog.info({ pid: capturedPid }, "runCaptureQuery: done");
}

// ---------------------------------------------------------------------------
// AskClaude tool — Claude Code as a delegated agent for codebase Q&A.
//
// SEPARATE use of the SDK from the provider path. Uses its own one-shot query()
// with full agentic capability (Read, Bash, etc.) and returns a summary.
// Kept minimal vs. legacy; expand if needed.
// ---------------------------------------------------------------------------

let askClaudeToolName = "AskClaude";

const ASKCLAUDE_DESCRIPTION =
	"Ask Claude Code (with full file/bash access) to investigate or answer a question about the codebase. Returns a written summary.";

async function runAskClaude(
	prompt: string,
	mode: "read" | "full" | "none",
	signal: AbortSignal | undefined,
	systemPrompt: string | undefined,
	piContext: Context["messages"] | undefined,
): Promise<{ text: string; error?: boolean }> {
	const cwd = process.cwd();
	const disallowed = mode === "none"
		? [...DISALLOWED_BUILTIN_TOOLS]
		: mode === "read"
			? ["Write", "Edit", "Bash", "Agent", "NotebookEdit", "EnterWorktree", "ExitWorktree", "RemoteTrigger", "SendMessage"]
			: [];

	// Replay pi history (without images) as user-message context to Claude Code.
	let promptArg: string | AsyncIterable<SDKUserMessage> = prompt;
	if (piContext && piContext.length > 0) {
		const { anthropicMessages } = convertPiMessages(piContext as any);
		const blocks: ContentBlockParam[] = [{ type: "text", text: prompt }];
		// Lightweight: just include text-only history as a header to the prompt.
		const historyText = anthropicMessages
			.map((m) => {
				const c = typeof m.content === "string" ? m.content : (m.content as any[]).map((b: any) => b.text ?? "").join(" ");
				return `[${m.role}] ${c}`.slice(0, 500);
			})
			.join("\n");
		if (historyText) blocks.unshift({ type: "text", text: `Prior conversation:\n${historyText}\n\n---\nQuestion:` });
		promptArg = wrapPromptStream(blocks);
	}

	const sdkQuery = _queryFactory({
		prompt: promptArg,
		options: {
			cwd,
			disallowedTools: disallowed,
			permissionMode: "bypassPermissions",
			settingSources: [],
			systemPrompt: systemPrompt ?? "You are a helpful Claude Code assistant invoked by pi.",
			...(cachedSessionId ? { resume: cachedSessionId } : {}),
		},
	});

	const onAbort = () => { void sdkQuery.interrupt().catch(() => {}); try { (sdkQuery as any).close?.(); } catch {} };
	if (signal) {
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	}

	let responseText = "";
	let isError = false;
	try {
		for await (const m of sdkQuery) {
			if (signal?.aborted) break;
			if (m.type === "result") {
				if ((m as any).subtype === "success" && (m as any).result) {
					responseText = (m as any).result;
				}
			} else if (m.type === "assistant") {
				const blocks = (m as any).message?.content ?? [];
				for (const b of blocks) {
					if (b.type === "text" && b.text) responseText += b.text;
				}
			}
		}
	} catch (err) {
		isError = true;
		responseText = err instanceof Error ? err.message : String(err);
	}
	return { text: responseText || "[Claude Code returned no text]", error: isError };
}

// ---------------------------------------------------------------------------
// Pi extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	piApiRef = pi;

	// Disable non-essential CC traffic.
	process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";

	// Reset session cache on pi lifecycle events that diverge history.
	const clearSession = (event: string) => {
		log.info({ event, droppedSession: cachedSessionId?.slice(0, 8) ?? null }, `${event}: dropping cached session ${cachedSessionId?.slice(0, 8) ?? "none"}`);
		cachedSessionId = null;
		cachedSessionCwd = null;
		lastSentMessageHashes = null;
		// Drain any leftover frames (subagents that didn't clean up). Also
		// drain pendingResolvers with synthetic text — Option H keeps frames
		// on the stack post-abort waiting for pi to deliver real
		// tool_results, but if the session is being cleared/replaced, those
		// resolvers will never see real content. Drain them so the SDK isn't
		// left with hung handler promises.
		while (stack.length > 0) {
			const frame = stack.pop()!;
			drainPendingResolversAsAborted(frame, `clearSession:${event}`);
			frame.wasAborted = true;
			abortFrame(frame);
		}
	};
	pi.on("session_start", (event, ctx) => {
		piUI = ctx.ui;
		piExtCtx = ctx as any;
		if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
			clearSession(`session_start:${event.reason}`);
		}
	});
	pi.on("session_shutdown", (_event?: any) => {
		clearSession("session_shutdown");
		// Pi rebuilds a fresh ModelRegistry on EVERY session change — /new,
		// /resume, /fork, and /reload all flow through createAgentSessionServices
		// which builds a new registry then re-runs extensions to populate it.
		// /reload additionally calls resetApiProviders() in pi-ai. In all cases
		// the Symbol guard (which lives on globalThis) survives, and would skip
		// pi.registerProvider on the second module init — leaving the new
		// registry without claude-bridge models. Symptoms:
		//   - /reload: subsequent input "submitted" but never reaches inference
		//   - /new:    falls back to codex/gpt-5.4 instead of configured default
		// Drop the guard on every shutdown so the next module init re-registers.
		delete (globalThis as Record<symbol, any>)[Symbol.for("claude-bridge:active")];
	});

	// Provider registration. Subagent-loaded module instances don't re-register
	// because pi-ai's ModelRegistry is shared — first writer wins for the
	// claude-bridge provider. Subsequent calls for claude-bridge models go
	// through the parent's streamSimple via the stack (which we own).
	const ACTIVE_KEY = Symbol.for("claude-bridge:active");
	const g = globalThis as Record<symbol, any>;
	if (!g[ACTIVE_KEY]) {
		g[ACTIVE_KEY] = streamClaudeAgentSdk;
		pi.registerProvider(PROVIDER_ID, {
			baseUrl: "claude-bridge",
			apiKey: "not-used",
			api: "claude-bridge" as any,
			models: MODELS as any,
			streamSimple: streamClaudeAgentSdk as any,
		});
		log.info({ models: MODELS.length }, `provider: registered (models=${MODELS.length})`);
	} else {
		log.info(`provider: skipping re-registration (already active)`);
	}

	// AskClaude tool — keep behavior, much smaller surface than legacy.
	//
	// Opt-in via env: defaults to OFF. Set CLAUDE_BRIDGE_ASKCLAUDE_ENABLED=1
	// (or "true") to register the tool. When unset/false the tool is not
	// registered at all (won't appear in pi.getAllTools()).
	const askClaudeEnabledRaw = (process.env.CLAUDE_BRIDGE_ASKCLAUDE_ENABLED ?? "").trim().toLowerCase();
	const askClaudeEnabled = askClaudeEnabledRaw === "1" || askClaudeEnabledRaw === "true";
	if (!askClaudeEnabled) {
		log.info("AskClaude tool: disabled (set CLAUDE_BRIDGE_ASKCLAUDE_ENABLED=1 to enable)");
		return;
	}
	log.info("AskClaude tool: enabled via CLAUDE_BRIDGE_ASKCLAUDE_ENABLED");
	pi.registerTool({
		name: askClaudeToolName,
		label: "Ask Claude Code",
		description: ASKCLAUDE_DESCRIPTION,
		parameters: Type.Object({
			prompt: Type.String({ description: "Question or task for Claude Code." }),
			mode: Type.Optional(StringEnum(["read", "full", "none"] as const, {
				description: '"read" (default): file access for analysis. "full": writes/bash. "none": no tools.',
			})),
			isolated: Type.Optional(Type.Boolean({ description: "true: clean session. false (default): include pi history." })),
		}),
		renderCall(args, theme) {
			const text = theme.fg("mdLink", theme.bold("AskClaude ")) +
				theme.fg("muted", `"${args.prompt.slice(0, 200)}${args.prompt.length > 200 ? "…" : ""}"`);
			return new Text(text, 0, 0);
		},
		renderResult(result, _opts, theme) {
			const body = result.content[0]?.type === "text" ? result.content[0].text : "";
			const details = result.details as { error?: boolean } | undefined;
			const head = details?.error
				? theme.fg("error", "✗ Claude Code error")
				: theme.fg("mdLink", "✓ Claude Code");
			return new Text(`${head}\n${theme.fg("toolOutput", body.slice(0, 1500))}`, 0, 0);
		},
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (ctx.model?.baseUrl === "claude-bridge") {
				return {
					content: [{ type: "text" as const, text: "AskClaude cannot delegate to itself (active provider is claude-bridge)." }],
					details: { error: true },
				};
			}
			const mode = (params.mode ?? "read") as "read" | "full" | "none";
			const isolated = params.isolated ?? false;
			const piContext = isolated ? undefined : (buildSessionContext(ctx.sessionManager.getBranch()).messages as Context["messages"]);
			const { text, error } = await runAskClaude(params.prompt, mode, signal, ctx.getSystemPrompt(), piContext);
			return { content: [{ type: "text" as const, text }], details: { error } };
		},
	});
}

// Suppress unused-import lints in TS strict mode
void _resolveModelId;
void keyHint;
void pascalCase;
