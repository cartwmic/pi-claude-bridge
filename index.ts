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
	query,
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
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { pascalCase } from "change-case";
import { PROVIDER_ID, messageContentToText, convertPiMessages } from "./convert.js";
import { buildModels, resolveModelId as _resolveModelId } from "./models.js";

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
];

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
	sdkQuery: ReturnType<typeof query>;
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
	toolUseIdQueue: string[];
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
			const toolUseId = frame.toolUseIdQueue.shift();
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
				frame.toolUseIdQueue.push(cb.id);
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
		for await (const message of frame.sdkQuery) {
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
// Provider entry point: streamSimple
// ---------------------------------------------------------------------------

function streamClaudeAgentSdk(
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
		active.currentPiStream = stream;
		resetTurnState(active);
		for (const r of trailing) {
			const result = { content: [{ type: "text" as const, text: r.content || "" }], isError: r.isError };
			const resolver = active.pendingResolvers.get(r.id);
			if (resolver) {
				active.pendingResolvers.delete(r.id);
				resolver(result);
			} else {
				// Result arrived before the MCP handler ran — buffer it.
				active.pendingResults.set(r.id, result);
			}
		}
		return stream;
	}

	// ---- Case 2: orphaned tool result (active query gone, e.g. post-abort) ----
	if (lastMsg?.role === "toolResult") {
		logger.child({ piSessionId: getPiSessionId() }).warn(`streamSimple: orphaned tool result, no active query — emitting end_turn`);
		queueMicrotask(() => {
			const empty = newTurnOutput(model);
			stream.push({ type: "start", partial: empty });
			stream.push({ type: "done", reason: "stop", message: empty });
			stream.end();
		});
		return stream;
	}

	// ---- Case 3: fresh user turn (or subagent / steer-as-fresh) ----
	// If there's an active query that didn't resolve, the new user turn supersedes it:
	// interrupt and start fresh. This handles steering, rapid retype, and aborts that
	// arrived without a clean shutdown.
	if (active) {
		active.log.info(`streamSimple: superseding active frame (top of stack), interrupting`);
		active.wasAborted = true;
		void active.sdkQuery.interrupt().catch(() => {});
		try { active.sdkQuery.close?.(); } catch { /* ignore */ }
		stack.pop();
	}

	startFreshQuery(model, context, options, stream);
	return stream;
}

function startFreshQuery(
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	stream: AssistantMessageEventStream,
): void {
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
	const appendParts = [agentsAppend, skillsAppend].filter((p): p is string => Boolean(p));
	const systemPromptAppend = appendParts.length > 0 ? appendParts.join("\n\n") : undefined;
	// Static system prompt — pi already provides its own, we don't want CC's preset.
	const staticSystemPrompt = systemPromptAppend ?? "You are a helpful coding assistant.";

	const effort = options?.reasoning ? REASONING_TO_EFFORT[options.reasoning] : undefined;
	const extraArgs: Record<string, string | null> = { model: model.id, "strict-mcp-config": null };
	if (effort) extraArgs["thinking-display"] = "summarized";

	// Build the frame BEFORE building the MCP server (handlers close over it).
	const frame: QueryFrame = {
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

	const queryOptions: NonNullable<Parameters<typeof query>[0]["options"]> = {
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

	const sdkQuery = query({ prompt, options: queryOptions });
	frame.sdkQuery = sdkQuery;
	stack.push(frame);

	// Wire abort
	const onAbort = () => {
		frame.log.info({ pendingResolvers: frame.pendingResolvers.size }, `onAbort: model=${model.id}, pendingResolvers=${frame.pendingResolvers.size}`);
		frame.wasAborted = true;
		// Resolve any waiting MCP handlers so the SDK generator can drain.
		for (const resolver of frame.pendingResolvers.values()) {
			resolver({ content: [{ type: "text", text: "Operation aborted" }], isError: true });
		}
		frame.pendingResolvers.clear();
		void sdkQuery.interrupt().catch(() => {});
		try { (sdkQuery as any).close?.(); } catch { /* ignore */ }
		// IMPORTANT: do NOT drop cachedSessionId here. The SDK's session JSONL
		// retains all messages up to the abort point (including the interrupted
		// partial assistant message). On the next user turn, resuming that
		// session preserves the conversation context — which is required so the
		// model knows it was interrupted (S7 coherence, S13 enumeration, etc.).
		// Dropping the id here would force a cold-start with no context.
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
			syncTurnContent(frame);
			if (frame.wasAborted) {
				frame.turnOutput.stopReason = "aborted";
				frame.turnOutput.errorMessage = frame.turnOutput.errorMessage ?? "Operation aborted";
				frame.currentPiStream.push({ type: "error", reason: "aborted", error: frame.turnOutput });
			} else if (frame.turnOutput.stopReason === "error") {
				frame.currentPiStream.push({ type: "error", reason: "error", error: frame.turnOutput });
			} else {
				if (!frame.turnStarted) ensureTurnStarted(frame);
				const reason = frame.turnOutput.stopReason === "length" ? "length" : "stop";
				frame.currentPiStream.push({ type: "done", reason, message: frame.turnOutput });
			}
			frame.currentPiStream.end();
			frame.currentPiStream = null;
		}
		// Pop frame off stack (only if it's still the top — supersession may have popped it already)
		if (top() === frame) stack.pop();
	}).catch((err) => {
		frame.log.error({ err: err instanceof Error ? err.message : String(err) }, "streamSimple: consumeQuery promise error");
		if (top() === frame) stack.pop();
	});
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

	const sdkQuery = query({
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
		// Drain any leftover frames (subagents that didn't clean up).
		while (stack.length > 0) {
			const frame = stack.pop()!;
			frame.wasAborted = true;
			void frame.sdkQuery?.interrupt?.().catch(() => {});
		}
	};
	pi.on("session_start", (event, ctx) => {
		piUI = ctx.ui;
		piExtCtx = ctx as any;
		if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
			clearSession(`session_start:${event.reason}`);
		}
	});
	pi.on("session_shutdown", () => clearSession("session_shutdown"));

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
