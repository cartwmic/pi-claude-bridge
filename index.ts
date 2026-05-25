// pi-claude-bridge: PTY-driven, pi-canonical, inference-only.
//
// Architecture (post-v1.0.0 Phase 3 SDK-deletion):
//   - pi owns conversation history. Claude is reached by driving the
//     interactive `claude` TUI through node-pty (src/driver/streamPty.ts).
//   - One PTY session spans one pi user-turn (which may include many tool
//     rounds). The session is held across tool round-trips.
//   - Tool execution happens IN PI. Tools are declared to `claude` via a
//     stdio MCP shim (src/mcp/) whose handlers block on a Promise until pi
//     delivers the tool result via the next streamSimple() call.
//   - Bridge holds the CC session_id in memory only as a cache hint for
//     warm-resume (--resume). Never reads or writes ~/.claude/sessions/.
//   - Aborts use claude's native Escape key. No JSONL surgery, no UUID
//     rotation. History-divergence detection drops the warm-resume cache
//     when pi diverges (/fork, /compact, /tree, /reload, /new).
//   - Subagents work as nested PTY spawns; capture-mode calls use an
//     isolated runCaptureQueryPty path that never touches the main session.
//
// SDK provider path REMOVED in v1.0.0 (Phase 3, task 3.2). The bridge no
// longer depends on @anthropic-ai/claude-agent-sdk or @anthropic-ai/sdk.
// See openspec/changes/replace-sdk-with-pty-tui/ for the full rationale.

import {
	type Context,
	type Model,
	type SimpleStreamOptions,
	type Tool,
	type AssistantMessageEventStream,
} from "@mariozechner/pi-ai";
import * as piAi from "@mariozechner/pi-ai";
import { type ExtensionAPI, type ExtensionUIContext } from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync } from "fs";
import pino from "pino";
import { createStream } from "rotating-file-stream";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { PROVIDER_ID, messageContentToText } from "./convert.js";
import { buildModels, resolveModelId as _resolveModelId } from "./models.js";
import { streamClaudeViaPty, clearStreamPtyCache, __resetStreamPtyCacheForTests } from "./src/driver/streamPty.js";
import { runCaptureQueryPty } from "./src/capture.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MCP_SERVER_NAME = "custom-tools";

// ---------------------------------------------------------------------------
// Test seams (kept public for unit tests; not part of the runtime API)
// ---------------------------------------------------------------------------

/** Test-only: swap piApiRef and return a restorer. */
export function __setPiApiRefForTests(ref: { getActiveTools(): string[] } | null): () => void {
	const prev = piApiRef;
	piApiRef = ref as any;
	return () => { piApiRef = prev as any; };
}

/** Test-only: return the current debug log path. */
export function __getDebugLogPathForTests(): string {
	return DEBUG_LOG_PATH;
}

/** Test-only: reset cross-call session cache (delegates to streamPty). */
export function __resetCachedSessionForTests(): void {
	__resetStreamPtyCacheForTests();
}

// ---------------------------------------------------------------------------
// pi-ai compat shim
// ---------------------------------------------------------------------------

const _piAi = piAi as any;
const newAssistantMessageEventStream: () => AssistantMessageEventStream =
	typeof _piAi.createAssistantMessageEventStream === "function"
		? _piAi.createAssistantMessageEventStream
		: () => new _piAi.AssistantMessageEventStream();

// ---------------------------------------------------------------------------
// Driver-selection guard. v1.0.0 = PTY-only. The `sdk` value is rejected
// at module load with a deprecation error (task 3.1).
// ---------------------------------------------------------------------------

const _rawDriver = (process.env.CLAUDE_BRIDGE_DRIVER ?? "").trim().toLowerCase();
if (_rawDriver === "sdk") {
	// eslint-disable-next-line no-console
	console.error(
		"pi-claude-bridge: CLAUDE_BRIDGE_DRIVER=sdk was removed in v1.0.0. " +
		"The bridge now drives the interactive `claude` TUI via node-pty (CLAUDE_BRIDGE_DRIVER=pty, the default). " +
		"Unset CLAUDE_BRIDGE_DRIVER or set it to 'pty' to continue.",
	);
	throw new Error("CLAUDE_BRIDGE_DRIVER=sdk removed in v1.0.0");
}
export const CLAUDE_BRIDGE_DRIVER: "pty" = "pty";

// ---------------------------------------------------------------------------
// Logging (pino + rotating-file-stream). On by default; disable with
// CLAUDE_BRIDGE_DEBUG=0. Log path: ~/.pi/agent/claude-bridge.log
// (override CLAUDE_BRIDGE_DEBUG_PATH). 10 MB × 2 generations by default.
// ---------------------------------------------------------------------------

const DEBUG = process.env.CLAUDE_BRIDGE_DEBUG !== "0";
const DEBUG_LOG_PATH = process.env.CLAUDE_BRIDGE_DEBUG_PATH || join(homedir(), ".pi", "agent", "claude-bridge.log");
const DEBUG_MAX_BYTES = Number(process.env.CLAUDE_BRIDGE_DEBUG_MAX_BYTES) || 10 * 1024 * 1024;

if (DEBUG) {
	try { mkdirSync(dirname(DEBUG_LOG_PATH), { recursive: true }); } catch { /* ignore */ }
}

const logStream = DEBUG
	? createStream(DEBUG_LOG_PATH, {
			size: `${DEBUG_MAX_BYTES}B`,
			maxFiles: 2,
		})
	: undefined;

const logger = DEBUG && logStream
	? pino({ level: "debug", timestamp: pino.stdTimeFunctions.isoTime, base: undefined }, logStream)
	: pino({ level: "silent" });

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
let piExtCtx: { sessionManager: { getSessionId(): string } } | null = null;

// ---------------------------------------------------------------------------
// Settings & system-prompt helpers (AGENTS.md, APPEND_SYSTEM.md, skills)
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
		const toolNotice = `\n\nNote: if the rules above reference tools by bare names (e.g. \`bash\`, \`read\`, \`write\`, \`edit\`, \`subagent\`), call them via the MCP-prefixed names \`mcp__${MCP_SERVER_NAME}__<name>\` (e.g. \`mcp__${MCP_SERVER_NAME}__bash\`). The bare names are not exposed.`;
		return `# Operator instructions\n\n${content}${toolNotice}`;
	} catch { return undefined; }
}

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
// Prompt extraction (last user message)
// ---------------------------------------------------------------------------

function extractUserPrompt(messages: Context["messages"]): string | null {
	const last = messages[messages.length - 1];
	if (!last || last.role !== "user") return null;
	if (typeof last.content === "string") return last.content;
	return messageContentToText(last.content) || "";
}

/**
 * Build a cold-start prompt that embeds pi's full prior conversation as text
 * context, followed by the new user message. Used by the PTY driver when no
 * cached session is available (first turn after bridge restart, after
 * fork/compact, etc.). Kept exported for tests + the PTY path.
 */
export function buildColdStartPrompt(messages: Context["messages"]): string {
	if (messages.length === 0) return "";
	if (messages.length === 1 && messages[0].role === "user") {
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
// Output-capture classification helpers (Decisions 2/3/6)
// ---------------------------------------------------------------------------

/**
 * Snapshot pi's active tool names. Returns empty set when piApiRef is null
 * (bridge loaded outside pi extension lifecycle, e.g. tests) or when
 * getActiveTools() throws. Uses getActiveTools() NOT getAllTools() so
 * registered-but-inactive names are correctly classified as capture-side.
 */
export function getActiveToolNameSet(): Set<string> {
	try {
		const names = piApiRef?.getActiveTools() ?? [];
		return new Set(names);
	} catch {
		return new Set();
	}
}

/** Partition context.tools into executable (pi-registered) and capture
 *  (unregistered). Skips excludeName. */
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

/** Deep JSON-only clone of a schema: preserves every JSON-serializable
 *  keyword at every depth and naturally drops TypeBox symbol-keyed metadata. */
export function cleanSchemaForSdk(schema: unknown): Record<string, unknown> {
	return JSON.parse(JSON.stringify(schema));
}

type CaptureCallShape =
	| { kind: "all-executable" }
	| { kind: "single-capture"; captureTool: Tool; cleanedSchema: Record<string, unknown> }
	| { kind: "rejected"; reason: string };

/** Decision 3: capture mode is mutually exclusive with executable tools, and
 *  requires exactly one capture tool with an object-root schema. */
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
	return {
		kind: "rejected",
		reason: `capture mode (unregistered: [${capture.map((t) => t.name).join(", ")}]) is mutually exclusive with executable tools (registered: [${executable.map((t) => t.name).join(", ")}]) in v1. A call must use either all executable tools or exactly one capture tool. v1 limitation.`,
	};
}

// ---------------------------------------------------------------------------
// streamSimple entry point — pure PTY dispatch (v1.0.0).
// ---------------------------------------------------------------------------

/** Pi-ai provider entry. Dispatches to either the PTY main path or the
 *  isolated PTY capture path based on the call's tool shape. Rejected
 *  shapes emit a synthetic error stream. No SDK path remains in v1.0.0. */
export function streamClaudeAgentSdk(
	model: Model<any>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const activeNames = getActiveToolNameSet();
	const { executable, capture } = classifyToolsForCapture(context, activeNames, "");
	const shape = validateCaptureCallShape({ executable, capture });

	if (shape.kind === "rejected") {
		log.warn(
			{ captureTool: capture.map((t) => t.name), executable: executable.map((t) => t.name) },
			`streamSimple: rejected capture-shape: ${shape.reason}`,
		);
		const stream = newAssistantMessageEventStream();
		queueMicrotask(() => {
			const empty = {
				id: "",
				role: "assistant" as const,
				content: [],
				stopReason: "error" as const,
				usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cost: 0 },
				errorMessage: shape.reason,
			} as any;
			stream.push({ type: "start", partial: empty });
			stream.push({ type: "error", reason: "error", error: empty });
			stream.end();
		});
		return stream;
	}

	if (shape.kind === "single-capture") {
		return runCaptureQueryPty(model, context, options, {
			captureTool: shape.captureTool,
			cleanedSchema: shape.cleanedSchema,
			makeStream: newAssistantMessageEventStream,
		});
	}

	// shape.kind === "all-executable" — main PTY path.
	const skillsAppend = extractSkillsBlock(context.systemPrompt);
	const agentsAppend = extractAgentsAppend();
	const appendSystem = extractAppendSystem();
	const appendParts = [agentsAppend, appendSystem, skillsAppend].filter((p): p is string => Boolean(p));
	const sysParts = [context.systemPrompt, ...appendParts].filter((p): p is string => Boolean(p && p.length > 0));
	const systemPrompt = sysParts.length > 0 ? sysParts.join("\n\n") : "You are a helpful coding assistant.";
	const cwd = (options as { cwd?: string } | undefined)?.cwd ?? process.cwd();
	return streamClaudeViaPty(model, context, options, {
		systemPrompt,
		makeStream: newAssistantMessageEventStream,
		tools: executable,
		cwd,
	});
}

// ---------------------------------------------------------------------------
// Pi extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	piApiRef = pi;

	// Disable non-essential CC traffic.
	process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";

	// Lifecycle: drop PTY warm-resume cache on history-divergent events as a
	// belt-and-suspenders companion to passive history-hash detection inside
	// streamPty.ts. The passive detection alone is sufficient for correctness;
	// the explicit hook gives a clean "user did X" log line.
	pi.on("session_start", (event, ctx) => {
		piUI = ctx.ui;
		piExtCtx = ctx as any;
		if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
			clearStreamPtyCache(`session_start:${event.reason}`);
		}
	});

	pi.on("session_shutdown", (_event?: any) => {
		// Do NOT clear the warm-resume cache here. Despite the type doc claiming
		// session_shutdown fires "on process exit", pi emits it between user
		// turns (observed in bridge logs: caching session=X followed milliseconds
		// later by session_shutdown dropping X, repeatedly across a single pi
		// process). Clearing here cold-starts every subsequent turn — pi appears
		// to "forget" prior context. Genuine process exit drops the module-level
		// cache for free.
		//
		// Pi rebuilds a fresh ModelRegistry on EVERY session change. /reload also
		// calls resetApiProviders() in pi-ai. The Symbol guard (lives on
		// globalThis) survives those resets and would skip pi.registerProvider on
		// the next module init — leaving the new registry without claude-bridge
		// models. Drop the guard so the next module init re-registers.
		delete (globalThis as Record<symbol, any>)[Symbol.for("claude-bridge:active")];
	});

	// Provider registration. Subagent-loaded module instances don't re-register
	// because pi-ai's ModelRegistry is shared — first writer wins for the
	// claude-bridge provider. Subsequent claude-bridge model calls in subagents
	// route through the parent's streamSimple, which the PTY driver handles via
	// nested per-subagent spawns.
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

	// AskClaude tool REMOVED in v1.0.0 (BREAKING). See CHANGELOG.
	log.info("AskClaude tool removed in v1.0.0; not registered.");

	// Touch piUI to silence unused-var lint (kept for future use).
	void piUI;
	void piExtCtx;
}

// Suppress unused-import lints in TS strict mode
void _resolveModelId;
