// src/driver/streamPty.ts
//
// T1.10 PTY-driven streamSimple path. Selected when CLAUDE_BRIDGE_DRIVER=pty.
//
// Phase-7 Bucket B (2026-05-23): persistent-handle tool round-trip.
//
//   The pi-ai protocol turn boundary is the tool_call/tool_result handshake:
//   - First streamSimple call (fresh user turn) spawns a `claude` PTY,
//     types the user prompt, streams text-deltas, and on first tool_use
//     emits `done(toolUse)` to end the pi-ai stream. The PTY stays alive.
//   - Pi executes the tool locally and calls streamSimple AGAIN with a
//     trailing `toolResult` message. We re-wire to the SAME PTY handle,
//     deliver the result through the router (which lets the model resume),
//     and project subsequent transcript events onto the NEW pi-ai stream.
//   - Repeats until the model emits text + Stop hook → done(stop), at
//     which point we tear down the handle and clear active-session state.
//
//   On supersede (fresh turn arrives while an active handle still has
//   pending parked tool_calls): drain those resolvers with synthetic
//   "[Tool execution interrupted by user before completion]" text (per
//   index.ts SDK-path ABORTED_TOOL_RESULT_TEXT contract), abort the
//   handle, then spawn a fresh one.
//
//   Capture path (output-capture shape) still routes through
//   `runCaptureQueryPty` (separate entry point) — capture sessions never
//   share state with main mode and don't need this handle persistence.
//
// Public surface: `streamClaudeViaPty(model, context, options, extras)`
// returns an AssistantMessageEventStream that pi-ai consumes.

import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";

function writeBridgeLogLine(msg: string): void {
	const path = process.env.CLAUDE_BRIDGE_DEBUG_PATH;
	if (!path) return;
	try {
		appendFileSync(path, JSON.stringify({ level: 30, time: new Date().toISOString(), msg }) + "\n");
	} catch {}
}
import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
	Tool,
	ToolCall,
} from "@mariozechner/pi-ai";
import { spawnDriver, type DriverHandle } from "./pty.js";
import type { RouterToolDefinition, ToolResultContent } from "../mcp/router.js";
import type { TranscriptEvent } from "./transcript.js";

const ABORTED_TOOL_RESULT_TEXT = "[Tool execution interrupted by user before completion]";

/** Per-turn CC `usage` events report cumulative prompt-side snapshots
 *  (input + cacheRead + cacheWrite) for each assistant entry, NOT deltas —
 *  summing them N-fold inflates the value over a multi-roundtrip turn.
 *  Track the latest snapshot across turns so newTurnOutput can seed pi's
 *  footer without snapping to zero between turns. Cleared whenever the
 *  warm-resume cache is cleared (any path that breaks transcript coherence). */
let lastUsageSnapshot: { input: number; cacheRead: number; cacheWrite: number } | null = null;

function newTurnOutput(modelId: string): AssistantMessage {
	const seed = lastUsageSnapshot ?? { input: 0, cacheRead: 0, cacheWrite: 0 };
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages" as any,
		provider: "claude-bridge" as any,
		model: modelId,
		usage: {
			input: seed.input,
			output: 0,
			cacheRead: seed.cacheRead,
			cacheWrite: seed.cacheWrite,
			totalTokens: seed.input + seed.cacheRead + seed.cacheWrite,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function flattenMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const b of content) {
		if (b && typeof b === "object" && "type" in b) {
			if ((b as any).type === "text" && typeof (b as any).text === "string") parts.push((b as any).text);
		}
	}
	return parts.join("");
}

/**
 * Stripped-down cold-start prompt builder. Mirrors index.ts's
 * `buildColdStartPrompt` shape; kept local to avoid a circular import.
 */
function buildPromptText(messages: Context["messages"]): { prompt: string; imagesDropped: number } {
	let imagesDropped = 0;
	const countImages = (content: unknown): void => {
		if (!Array.isArray(content)) return;
		for (const b of content) {
			if (b && typeof b === "object" && "type" in b && (b as any).type === "image") imagesDropped++;
		}
	};

	if (messages.length === 0) return { prompt: "", imagesDropped };
	if (messages.length === 1 && messages[0].role === "user") {
		countImages(messages[0].content);
		return { prompt: flattenMessageText(messages[0].content), imagesDropped };
	}
	const last = messages[messages.length - 1];
	const lastIsUser = last.role === "user";
	const prior = lastIsUser ? messages.slice(0, -1) : messages;

	const lines: string[] = [];
	for (const m of prior) {
		countImages(m.content);
		if (m.role === "user") {
			const t = flattenMessageText(m.content);
			if (t) lines.push(`[user] ${t}`);
		} else if (m.role === "assistant") {
			const blocks = Array.isArray(m.content) ? m.content : [];
			const parts: string[] = [];
			for (const b of blocks as any[]) {
				if (b.type === "text" && b.text) parts.push(b.text);
				else if (b.type === "toolCall") parts.push(`[tool: ${b.name}(${JSON.stringify(b.arguments).slice(0, 200)})]`);
			}
			if (parts.length) lines.push(`[assistant] ${parts.join(" ")}`);
		} else if (m.role === "toolResult") {
			const t = flattenMessageText(m.content);
			const tag = (m as any).isError ? "tool-error" : "tool-result";
			lines.push(`[${tag} ${(m as any).toolName ?? ""}] ${t.slice(0, 500)}`);
		}
	}
	countImages(last.content);
	const lastUserText = lastIsUser ? flattenMessageText(last.content) : "[continue]";
	if (lines.length === 0) return { prompt: lastUserText || "[continue]", imagesDropped };
	const prompt = [
		"<conversation_history>",
		"The following is our prior conversation in this session. Treat it as context.",
		...lines,
		"</conversation_history>",
		"",
		"User's current message:",
		lastUserText || "[continue]",
	].join("\n");
	return { prompt, imagesDropped };
}

/**
 * Convert pi-ai Tool definitions to router-shaped tool definitions for the
 * shim's advertised set.
 *
 * Tool-name layering (the source of MANY hours of debugging):
 *   - pi gives us tools with names like `bash`, `read`, `write`, `edit`.
 *   - We MUST keep an inner `mcp__custom-tools__` prefix on what we
 *     advertise to the shim's tools/list — dropping it causes CC's MCP
 *     server validation to silently refuse to start (SessionStart hook
 *     never fires), because CC reserves bare names like `bash` for its
 *     own built-ins.
 *   - Our MCP server name in --mcp-config is `pi-bridge` (see
 *     src/driver/settings.ts buildMcpConfigJson). CC prepends this
 *     server name when surfacing tools to the model, so the model sees
 *     a name like `mcp__pi-bridge__mcp__custom-tools__bash` and emits
 *     tool_use blocks with THAT full name.
 *   - On the way back, we must strip BOTH prefixes (`mcp__pi-bridge__`
 *     and `mcp__custom-tools__`) before sending the ToolCall to pi.
 *     The reverse-lookup nameMap handles every form CC might emit.
 *
 * Returns the prefixed defs AND a reverse-lookup map from every plausible
 * emitted form CC might use → pi's original tool name.
 */
function toolsToRouterDefs(tools: Tool[]): { defs: RouterToolDefinition[]; nameMap: Map<string, string> } {
	const nameMap = new Map<string, string>();
	const defs = tools.map((t) => {
		const inner = `mcp__custom-tools__${t.name}`;
		const withServer = `mcp__pi-bridge__${inner}`;
		for (const form of [t.name, inner, withServer]) {
			nameMap.set(form, t.name);
			nameMap.set(form.toLowerCase(), t.name);
		}
		return {
			name: inner,
			description: t.description ?? "",
			inputSchema: t.parameters ?? { type: "object" },
		};
	});
	return { defs, nameMap };
}

/** Reverse-lookup a tool name from CC's emitted form to pi's original. */
function resolvePiToolName(emittedName: string, nameMap: Map<string, string>): string {
	const direct = nameMap.get(emittedName);
	if (direct) return direct;
	const lower = nameMap.get(emittedName.toLowerCase());
	if (lower) return lower;
	let name = emittedName;
	for (const prefix of ["mcp__pi-bridge__", "mcp__custom-tools__"]) {
		if (name.startsWith(prefix)) name = name.slice(prefix.length);
	}
	return name;
}

function resolveShimPath(): string {
	const hereUrl = import.meta.url;
	// Use package-root launcher, not dist/, so git-installed pi packages work
	// without a post-clone build. shim.js loads src/mcp/shim.ts via jiti.
	return new URL("../../shim.js", hereUrl).pathname;
}

// --- Trailing tool-result extraction ------------------------------------

interface TrailingToolResult {
	id: string;
	content: string;
	isError: boolean;
}

function extractTrailingToolResults(messages: Context["messages"]): TrailingToolResult[] {
	const results: TrailingToolResult[] = [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as any;
		if (m.role !== "toolResult") break;
		const content = flattenMessageText(m.content);
		results.unshift({
			id: m.toolCallId || m.tool_call_id || m.id || "",
			content,
			isError: !!m.isError,
		});
	}
	return results;
}

// --- Active-session state (module-level) --------------------------------
//
// pi-claude-bridge runs one main-mode handle at a time per process (single
// user-driven conversation). On supersede we drain + abort + replace.
// Capture mode uses a separate entry point and doesn't touch this state.

interface PendingEntry {
	name: string;
	deliverResult: (content: ToolResultContent, isError?: boolean) => void;
}

interface ActiveSession {
	handle: DriverHandle;
	modelId: string;
	cwd: string;
	/** D15: marked true on abort. activeSession is NOT nulled immediately;
	 * the next pi event (toolResult or fresh turn) decides its fate.
	 * - toolResult → deliver to parked entry (router will stash via
	 *   pendingResults since PTY socket is detached), emit
	 *   `tool-result delivery to aborted frame` log, then null session.
	 * - fresh user turn → supersede: drain synthetically, null session.
	 * - timeout (5s default) → null session passively. */
	wasAborted: boolean;
	/** Reverse-lookup: CC's emitted tool name (e.g. `mcp__custom-tools__bash`)
	 *  → pi's original tool name (e.g. `bash` or `mcp__custom-tools__bash`). */
	nameMap: Map<string, string>;
	// pendingEntries: keyed by Anthropic toolUseId (the id pi sees). Populated
	// only after a tool-use transcript event + tool-call-parked event are
	// paired via FIFO (see correlateParked).
	pendingEntries: Map<string, PendingEntry>;
	// Race buffer: pi delivers a tool_result for a toolUseId BEFORE the
	// matching parked entry has arrived from CC's MCP shim. The transcript
	// tool-use event fires (and pi runs the tool) faster than CC's MCP
	// dispatch round-trips through the shim. Store the result here; when
	// correlateParked() pairs the toolUseId with a parked entry, deliver
	// the stored result immediately.
	pendingEarlyResults: Map<string, { content: ToolResultContent; isError: boolean }>;
	// FIFO queues for tool-use ↔ parked-entry correlation. Tool-use transcript
	// events carry the Anthropic toolUseId (what pi sees); tool-call-parked
	// events carry CC's MCP request id (router-generated). They arrive in the
	// same order CC dispatches the tool calls; we pair them FIFO.
	pendingToolUseIds: string[]; // Anthropic toolUseId, awaiting a parked entry
	pendingParkedEntries: PendingEntry[]; // parked entry, awaiting a toolUseId
	// Per-pi-turn-stream state (rotated when tool round-trip lands a new call):
	currentStream: AssistantMessageEventStream;
	out: AssistantMessage;
	textBuffer: string;
	textContentIndex: number;
	totalContentIndex: number;
	started: boolean;
	ended: boolean;
}

function correlateParked(session: ActiveSession): void {
	// Drain matching pairs from both FIFO queues.
	while (session.pendingToolUseIds.length > 0 && session.pendingParkedEntries.length > 0) {
		const toolUseId = session.pendingToolUseIds.shift()!;
		const entry = session.pendingParkedEntries.shift()!;
		const shortName = resolvePiToolName(entry.name, session.nameMap);
		// Check if pi already delivered a result for this toolUseId (race:
		// transcript event fired faster than CC's MCP dispatch).
		const early = session.pendingEarlyResults.get(toolUseId);
		if (early) {
			session.pendingEarlyResults.delete(toolUseId);
			writeBridgeLogLine(
				`mcp handler: ${shortName} [${toolUseId}] — early result, returning`,
			);
			try {
				entry.deliverResult(early.content, early.isError);
			} catch {}
			writeBridgeLogLine(
				`tool-result delivery: ${shortName} [${toolUseId}]${early.isError ? " (isError)" : ""} (early)`,
			);
			continue;
		}
		session.pendingEntries.set(toolUseId, entry);
		writeBridgeLogLine(`mcp handler: ${shortName} [${toolUseId}] — awaiting pi`);
	}
}

// Pi reasoning levels → CC effort flag values. Mirrors SDK path's
// REASONING_TO_EFFORT (index.ts).
const REASONING_TO_EFFORT: Record<string, "low" | "medium" | "high" | "xhigh" | "max"> = {
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "max",
};

let activeSession: ActiveSession | null = null;

// 7.2 history-divergence detection. Each completed turn snapshots a hash
// of pi's message history. The next fresh turn compares: if any common-
// prefix position differs OR current is shorter than prior, pi has
// /forked, /compacted, /tree-navigated, /reloaded, etc. — the SDK's
// JSONL transcript no longer matches and we MUST cold-start to avoid
// the model reading stale content.
let lastSentMessageHashes: string[] | null = null;

function hashMessage(m: any): string {
	const c = typeof m.content === "string" ? m.content : flattenMessageText(m.content);
	const head = c.slice(0, 96);
	const tail = c.slice(-32);
	return `${m.role}:${c.length}:${head}|${tail}`;
}

function computeMessageHashes(messages: Context["messages"]): string[] {
	return messages.map(hashMessage);
}

function detectHistoryDivergence(
	prior: string[] | null,
	current: string[],
): boolean {
	if (!prior || prior.length === 0) return false;
	const commonLen = Math.min(prior.length, current.length);
	for (let i = 0; i < commonLen; i++) {
		if (prior[i] !== current[i]) return true;
	}
	return current.length < prior.length;
}

// D22 warm-resume cache. After a turn completes successfully (Stop hook +
// settle), we cache the CC session_id + cwd. The next fresh user turn
// (same cwd, no divergence) spawns with `--resume <sid>` so CC's MCP shim
// reads the existing JSONL and the model has full context cache. Cleared
// on abort, error, or supersede (any path that breaks transcript coherence).
let cachedSessionId: string | null = null;
let cachedSessionCwd: string | null = null;

function clearWarmResumeCache(reason: string): void {
	if (cachedSessionId === null) return;
	writeBridgeLogLine(`clearSession: dropping cached sid=${cachedSessionId.slice(0, 8)} (${reason})`);
	cachedSessionId = null;
	cachedSessionCwd = null;
	lastSentMessageHashes = null;
	lastUsageSnapshot = null;
}

/** External entry point: drop the warm-resume cache + divergence hashes.
 *  Called from index.ts on pi lifecycle events (session_start with reason
 *  new/resume/fork, session_shutdown) as a belt-and-suspenders companion
 *  to passive history-divergence detection. Safe to call when already cleared. */
export function clearStreamPtyCache(reason: string): void {
	clearWarmResumeCache(reason);
}

/** Test-only: forcibly reset cache to a clean state. */
export function __resetStreamPtyCacheForTests(): void {
	cachedSessionId = null;
	cachedSessionCwd = null;
	lastSentMessageHashes = null;
	lastUsageSnapshot = null;
}

// --- Per-turn stream helpers (operate on `activeSession`) ---------------

function ensureStarted(s: ActiveSession): void {
	if (s.started) return;
	s.started = true;
	s.currentStream.push({ type: "start", partial: s.out });
}

function endWith(
	s: ActiveSession,
	ev:
		| { type: "done"; reason: "stop" | "toolUse"; message: AssistantMessage }
		| { type: "error"; reason: "aborted" | "error"; error: AssistantMessage },
): void {
	if (s.ended) return;
	s.ended = true;
	ensureStarted(s);
	s.currentStream.push(ev as any);
	s.currentStream.end();
}

function resetTurnState(s: ActiveSession, stream: AssistantMessageEventStream, modelId: string): void {
	s.currentStream = stream;
	s.out = newTurnOutput(modelId);
	s.textBuffer = "";
	s.textContentIndex = -1;
	s.totalContentIndex = 0;
	s.started = false;
	s.ended = false;
}

// --- Entry point --------------------------------------------------------

export interface StreamPtyExtras {
	systemPrompt: string;
	makeStream: () => AssistantMessageEventStream;
	tools: Tool[];
	cwd: string;
}

export function streamClaudeViaPty(
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	extras: StreamPtyExtras,
): AssistantMessageEventStream {
	const stream = extras.makeStream();
	const lastMsg = context.messages[context.messages.length - 1];

	// ---- Case 1: tool-result delivery to active handle ----
	if (lastMsg?.role === "toolResult" && activeSession) {
		const session = activeSession;
		const trailing = extractTrailingToolResults(context.messages);
		const toAbortedFrame = session.wasAborted;
		writeBridgeLogLine(
			`streamSimple: tool-result delivery, ${trailing.length} results, ${session.pendingEntries.size} resolvers waiting${toAbortedFrame ? " (post-abort, D15)" : ""}`,
		);

		// Re-wire the active session's stream to the NEW pi-ai stream so
		// subsequent transcript events (text-deltas, next tool_use, Stop)
		// flow into pi's TUI. Skip on aborted-frame delivery: the handle is
		// dead, the router socket is detached, and the result is stashed in
		// router.pendingResults for D15 replay. We just need to close the
		// new pi-ai stream with aborted.
		if (!toAbortedFrame) {
			resetTurnState(session, stream, model.id);
		}

		// Deliver each result to its parked entry. CC will resume generating.
		// If the parked entry hasn't arrived yet (race: pi acted on the
		// transcript tool-use event before CC's MCP dispatch round-tripped),
		// store in pendingEarlyResults; correlateParked() will deliver it
		// as soon as the parked entry shows up.
		for (const r of trailing) {
			const content: ToolResultContent = [{ type: "text" as const, text: r.content || "" }];
			const entry = session.pendingEntries.get(r.id);
			if (!entry) {
				session.pendingEarlyResults.set(r.id, { content, isError: r.isError });
				writeBridgeLogLine(
					`streamSimple: tool-result stashed (early) id=${r.id} (awaiting parked entry)`,
				);
				continue;
			}
			session.pendingEntries.delete(r.id);
			const shortName = resolvePiToolName(entry.name, session.nameMap);
			try {
				entry.deliverResult(content, r.isError);
				writeBridgeLogLine(
					`tool-result delivery: ${shortName} [${r.id}]${r.isError ? " (isError)" : ""}${toAbortedFrame ? " (to aborted frame)" : ""}`,
				);
				if (toAbortedFrame) {
					writeBridgeLogLine(
						`tool-result delivery to aborted frame: real content preserved via router.pendingResults (D15)`,
					);
				}
			} catch (err) {
				writeBridgeLogLine(
					`tool-result delivery failed: ${shortName} [${r.id}] err=${(err as Error)?.message ?? String(err)}`,
				);
			}
		}
		// If we delivered into an aborted frame, close the pi-ai stream
		// with aborted-error — CC is gone, no further content can stream.
		if (toAbortedFrame) {
			const out = newTurnOutput(model.id);
			out.stopReason = "aborted";
			out.errorMessage =
				"Operation aborted by user (real tool result captured for next-turn resume, D15)";
			queueMicrotask(() => {
				try {
					stream.push({ type: "start", partial: out });
					stream.push({ type: "error", reason: "aborted", error: out });
					stream.end();
				} catch {}
			});
			// Drain remaining state and tear down.
			session.pendingEntries.clear();
			session.pendingEarlyResults.clear();
			activeSession = null;
		}
		return stream;
	}

	// ---- Case 2: orphaned tool result (no active session) ----
	if (lastMsg?.role === "toolResult") {
		writeBridgeLogLine(
			`streamSimple: orphaned tool result, no active query — emitting aborted`,
		);
		writeBridgeLogLine(
			`pushAbortedError: orphan tool result post-abort`,
		);
		const orphanOut = newTurnOutput(model.id);
		orphanOut.stopReason = "aborted";
		orphanOut.errorMessage = "Operation aborted (tool result arrived after handle teardown)";
		queueMicrotask(() => {
			try {
				stream.push({ type: "start", partial: orphanOut });
				stream.push({ type: "error", reason: "aborted", error: orphanOut });
				stream.end();
			} catch {}
		});
		return stream;
	}

	// ---- Case 3: fresh user turn ----
	// If an active session still has parked tool_calls, the user has
	// superseded the previous turn. Drain synthetically + abort + spawn fresh.
	if (activeSession) {
		const stale = activeSession;
		const totalPending = stale.pendingEntries.size + stale.pendingParkedEntries.length;
		writeBridgeLogLine(
			`streamSimple: superseding active frame (pendingEntries=${totalPending}, wasAborted=${stale.wasAborted}), interrupting`,
		);
		// Supersede after a normal mid-turn handover (no abort) means the
		// in-flight turn never completed cleanly — drop warm-resume cache.
		// Supersede AFTER an abort (D15 path) preserves the cache that was
		// populated by the abort handler: CC's JSONL contains the partial
		// turn up to abort, and warm-resume from this sid is correct.
		if (!stale.wasAborted) {
			clearWarmResumeCache("supersede");
		}
		// Drain BOTH correlated and uncorrelated parked entries so CC's MCP
		// shim unblocks. Uncorrelated entries have no toolUseId yet (no
		// matching tool-use transcript event) — synthesize one for the log.
		for (const [id, entry] of stale.pendingEntries.entries()) {
			try {
				entry.deliverResult(
					[{ type: "text" as const, text: ABORTED_TOOL_RESULT_TEXT }],
					true,
				);
			} catch {}
			writeBridgeLogLine(
				`tool-result delivery: ${entry.name.replace(/^mcp__custom-tools__/, "")} [${id}] (synthetic interrupted-by-user)`,
			);
		}
		stale.pendingEntries.clear();
		for (const entry of stale.pendingParkedEntries) {
			try {
				entry.deliverResult(
					[{ type: "text" as const, text: ABORTED_TOOL_RESULT_TEXT }],
					true,
				);
			} catch {}
			writeBridgeLogLine(
				`tool-result delivery: ${entry.name.replace(/^mcp__custom-tools__/, "")} [uncorrelated] (synthetic interrupted-by-user)`,
			);
		}
		stale.pendingParkedEntries.length = 0;
		stale.pendingToolUseIds.length = 0;
		// End the stale stream if not yet ended.
		if (!stale.ended) {
			try {
				stale.out.stopReason = "stop";
				endWith(stale, { type: "error", reason: "aborted", error: stale.out });
			} catch {}
		}
		// Detach the module-level pointer NOW so the abort's "done" handler
		// (which would otherwise null it) doesn't race a fresh spawn below.
		activeSession = null;
		// Fire-and-forget abort. The stale handle's listeners may still
		// emit events but they'll find no activeSession to write to.
		void stale.handle.abort().catch(() => {});
	}

	// Spawn fresh handle and set up the new session.
	startFreshTurn(model, context, options, extras, stream);
	return stream;
}

function startFreshTurn(
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	extras: StreamPtyExtras,
	stream: AssistantMessageEventStream,
): void {
	// 7.2 history-divergence check: pi has /fork-ed, /compact-ed,
	// /tree-navigated, /reload-ed, or /new-ed if any prior-position
	// content changed or history shrank. Drop cache + cold-start so the
	// model doesn't see stale content from the previous SDK session.
	const newHashes = computeMessageHashes(context.messages);
	const diverged = detectHistoryDivergence(lastSentMessageHashes, newHashes);
	if (diverged) {
		writeBridgeLogLine(
			`clearSession: history divergence detected (priorLen=${lastSentMessageHashes?.length ?? 0} newLen=${newHashes.length}); cold-starting`,
		);
		clearWarmResumeCache("divergence");
	}
	lastSentMessageHashes = newHashes;

	// D22 warm-resume eligibility: cached sid + same cwd + no model change.
	// On warm-resume CC reads the existing JSONL; we only send the LAST
	// user message (CC has prior turns already). On cold-start we send the
	// full conversation-history-embedded prompt.
	const warmResume =
		cachedSessionId !== null &&
		cachedSessionCwd === extras.cwd;

	const { prompt, imagesDropped } = warmResume
		? (() => {
			const last = context.messages[context.messages.length - 1];
			if (last?.role === "user") {
				return { prompt: flattenMessageText(last.content), imagesDropped: 0 };
			}
			return buildPromptText(context.messages);
		})()
		: buildPromptText(context.messages);
	if (imagesDropped > 0) {
		process.stderr.write(
			`pi-claude-bridge: stripped ${imagesDropped} image block(s) from main-provider prompt (v1 limitation)\n`,
		);
	}

	(async () => {
		try {
			const { defs: tools, nameMap } = toolsToRouterDefs(extras.tools);
			writeBridgeLogLine(
				`tools: ${extras.tools.map((t) => t.name).join(",")}`,
			);
			writeBridgeLogLine(
				`streamSimple: PTY spawn model=${model.id} promptLen=${prompt.length} sysLen=${extras.systemPrompt.length} tools=${tools.length}`,
			);
			writeBridgeLogLine(
				`streamSimple: fresh query resume=${warmResume ? cachedSessionId!.slice(0, 8) : "no"} model=${model.id}`,
			);
			const reasoning = (options as { reasoning?: string } | undefined)?.reasoning;
			const effort = reasoning ? REASONING_TO_EFFORT[reasoning] : undefined;
			const handle = await spawnDriver({
				shimPath: resolveShimPath(),
				model: model.id,
				prompt,
				systemPrompt: warmResume ? "" : extras.systemPrompt,
				cwd: extras.cwd,
				mode: "main",
				tools,
				signal: options?.signal as AbortSignal | undefined,
				...(effort ? { effort } : {}),
				...(warmResume && cachedSessionId ? { resumeSessionId: cachedSessionId } : {}),
			});

			writeBridgeLogLine(
				`streamSimple: spawned session=${handle.sessionId.slice(0, 8)} transcriptPath=${handle.transcriptPath}`,
			);

			// Build the active session BEFORE wiring listeners so they can
			// reference it via closure on this stable object identity.
			const session: ActiveSession = {
				handle,
				modelId: model.id,
				cwd: extras.cwd,
				wasAborted: false,
				nameMap,
				pendingEntries: new Map(),
				pendingEarlyResults: new Map(),
				pendingToolUseIds: [],
				pendingParkedEntries: [],
				currentStream: stream,
				out: newTurnOutput(model.id),
				textBuffer: "",
				textContentIndex: -1,
				totalContentIndex: 0,
				started: false,
				ended: false,
			};
			activeSession = session;

			handle.on("hook", (e) => {
				writeBridgeLogLine(`streamSimple: hook event=${e.event} session=${handle.sessionId.slice(0, 8)}`);
			});

			handle.on("transcript", (e: TranscriptEvent) => {
				// Only act if THIS handle is still the active one and the
				// current pi-ai stream hasn't ended for this turn.
				if (activeSession !== session) return;
				if (session.ended && e.kind !== "done" && e.kind !== "error") return;
				switch (e.kind) {
					case "text-delta": {
						ensureStarted(session);
						if (session.textContentIndex === -1) {
							session.textContentIndex = session.totalContentIndex++;
							session.out.content.push({ type: "text", text: "" });
							session.currentStream.push({
								type: "text_start",
								contentIndex: session.textContentIndex,
								partial: session.out,
							});
							// Scenario-lib compat: SDK path emitted streaming activity
							// (per-content-block usage events) mid-turn. PTY tailer
							// only emits usage post-Stop, so scenarios polling
							// `"msg":"usage:` to detect 'streaming started' miss the
							// window. Emit a dedicated log line on the first text
							// delta so abort-mid-stream scenarios (s7, s9, s13, s20)
							// have a reliable mid-turn marker.
							writeBridgeLogLine(
								`streamSimple: streaming session=${session.handle.sessionId.slice(0, 8)}`,
							);
						}
						const delta = e.text;
						session.textBuffer += delta;
						(session.out.content[session.textContentIndex] as any).text = session.textBuffer;
						session.currentStream.push({
							type: "text_delta",
							contentIndex: session.textContentIndex,
							delta,
							partial: session.out,
						});
						return;
					}
					case "thinking-delta": {
						ensureStarted(session);
						const idx = session.totalContentIndex++;
						session.out.content.push({
							type: "thinking",
							thinking: e.text,
							thinkingSignature: e.signature ?? "",
						} as any);
						session.currentStream.push({ type: "thinking_start", contentIndex: idx, partial: session.out });
						if (e.text) {
							session.currentStream.push({
								type: "thinking_delta",
								contentIndex: idx,
								delta: e.text,
								partial: session.out,
							});
						}
						session.currentStream.push({
							type: "thinking_end",
							contentIndex: idx,
							content: e.text,
							partial: session.out,
						});
						return;
					}
					case "tool-use": {
						ensureStarted(session);
						// Close any in-flight text block.
						if (session.textContentIndex !== -1) {
							session.currentStream.push({
								type: "text_end",
								contentIndex: session.textContentIndex,
								content: session.textBuffer,
								partial: session.out,
							});
							session.textContentIndex = -1;
							session.textBuffer = "";
						}
						const idx = session.totalContentIndex++;
						const piToolName = resolvePiToolName(e.name, session.nameMap);
						const piToolUseId = e.toolUseId || "toolu_" + randomBytes(8).toString("hex");
						// Queue toolUseId for FIFO pairing with the tool-call-parked
						// event from CC's MCP shim.
						session.pendingToolUseIds.push(piToolUseId);
						correlateParked(session);
						const toolCall: ToolCall = {
							type: "toolCall" as const,
							id: piToolUseId,
							name: piToolName,
							arguments: (e.input ?? {}) as Record<string, unknown>,
						};
						session.out.content.push({
							type: "toolCall",
							id: toolCall.id,
							name: piToolName,
							arguments: toolCall.arguments,
						} as any);
						session.currentStream.push({
							type: "toolcall_start",
							contentIndex: idx,
							partial: session.out,
						});
						session.currentStream.push({
							type: "toolcall_end",
							contentIndex: idx,
							toolCall,
							partial: session.out,
						});
						session.out.stopReason = "toolUse";
						endWith(session, { type: "done", reason: "toolUse", message: session.out });
						return;
					}
					case "usage": {
						// CC emits cumulative prompt-side snapshots per assistant
						// entry — last-wins for input/cacheRead/cacheWrite avoids
						// N-fold inflation over multi-roundtrip turns. Output is
						// a per-call delta, so sum it.
						session.out.usage.input = e.usage.input;
						session.out.usage.output += e.usage.output;
						session.out.usage.cacheRead = e.usage.cacheRead;
						session.out.usage.cacheWrite = e.usage.cacheWrite;
						session.out.usage.totalTokens =
							session.out.usage.input +
							session.out.usage.output +
							session.out.usage.cacheRead +
							session.out.usage.cacheWrite;
						lastUsageSnapshot = {
							input: e.usage.input,
							cacheRead: e.usage.cacheRead,
							cacheWrite: e.usage.cacheWrite,
						};
						writeBridgeLogLine(
							`usage: cacheRead=${e.usage.cacheRead} cacheWrite=${e.usage.cacheWrite} input=${e.usage.input} output=${e.usage.output}`,
						);
						return;
					}
					case "warn":
						return;
					case "error": {
						session.out.stopReason = "error";
						session.out.errorMessage = e.errorMessage;
						endWith(session, { type: "error", reason: "error", error: session.out });
						return;
					}
					case "done": {
						// Flush any in-flight text block.
						if (session.textContentIndex !== -1) {
							session.currentStream.push({
								type: "text_end",
								contentIndex: session.textContentIndex,
								content: session.textBuffer,
								partial: session.out,
							});
							session.textContentIndex = -1;
						}
						if (e.reason === "aborted") {
							session.out.stopReason = "aborted";
							endWith(session, { type: "error", reason: "aborted", error: session.out });
						} else {
							session.out.stopReason = "stop";
							endWith(session, { type: "done", reason: "stop", message: session.out });
						}
						return;
					}
				}
			});

			handle.on("tool-call-parked", (entry) => {
				if (activeSession !== session) {
					// Late-arriving park after supersede — drain synthetically
					// so CC's MCP shim doesn't hang.
					try {
						entry.deliverResult(
							[{ type: "text", text: ABORTED_TOOL_RESULT_TEXT }],
							true,
						);
					} catch {}
					return;
				}
				// Queue the parked entry; correlate FIFO with any pending
				// tool-use transcript event. The handshake log line
				// (`mcp handler: <tool> [<toolUseId>] — awaiting pi`) is emitted
				// from correlateParked() once both sides are paired, so the
				// `[<id>]` in the log is always the Anthropic toolUseId that
				// scenario-lib asserts against.
				session.pendingParkedEntries.push({
					name: entry.name,
					deliverResult: entry.deliverResult,
				});
				correlateParked(session);
			});

			handle.on("done", (d) => {
				writeBridgeLogLine(
					`streamSimple: caching session=${handle.sessionId.slice(0, 8)} done=${d.reason}`,
				);
				if (activeSession === session) {
					if (d.reason === "aborted") {
						writeBridgeLogLine(
							`onAbort: session=${handle.sessionId.slice(0, 8)}, pendingResolvers=${session.pendingEntries.size} (deferred drain — waiting for pi's next event)`,
						);
						// FM1 (D15): if abort fires while pi is awaiting a tool
						// result, surface aborted to the pi stream explicitly so
						// pi's TUI doesn't go silent.
						const awaitingPi = session.pendingEntries.size + session.pendingParkedEntries.length > 0;
						if (awaitingPi) {
							writeBridgeLogLine(
								`pushAbortedError: pi was awaiting tool result, surfacing aborted to pi stream (pendingEntries=${session.pendingEntries.size})`,
							);
						}
						if (!session.ended) {
							session.out.stopReason = "aborted";
							endWith(session, { type: "error", reason: "aborted", error: session.out });
						}
						// D15: PRESERVE warm-resume cache across abort when the turn
						// was at a clean boundary (no pending tool calls AND model
						// had emitted some content). Empirically CC's --resume can
						// load a SIGINT-truncated JSONL ONLY if the model wrote at
						// least one complete assistant content block; bail-out before
						// any model output leaves the JSONL too thin for --resume.
						const hadContent = session.totalContentIndex > 0;
						if (!awaitingPi && hadContent) {
							cachedSessionId = handle.sessionId;
							cachedSessionCwd = session.cwd;
							writeBridgeLogLine(
								`warm-resume: cached sid=${handle.sessionId.slice(0, 8)} cwd=${session.cwd} (across abort, D15)`,
							);
						} else {
							writeBridgeLogLine(
								`warm-resume: skipping cache after abort (pendingResolvers=${session.pendingEntries.size}, hadContent=${hadContent})`,
							);
							clearWarmResumeCache("abort-thin-jsonl");
						}
						session.wasAborted = true;
						// Passive cleanup if no pi event lands within 5s.
						setTimeout(() => {
							if (activeSession === session && session.wasAborted) {
								writeBridgeLogLine(
									`onAbort: passive cleanup (no pi event landed within 5s) session=${handle.sessionId.slice(0, 8)}`,
								);
								activeSession = null;
							}
						}, 5000);
						return; // Do NOT null activeSession.
					} else if (d.reason === "error") {
						if (!session.ended) {
							session.out.stopReason = "error";
							session.out.errorMessage = d.errorMessage;
							endWith(session, { type: "error", reason: "error", error: session.out });
						}
						clearWarmResumeCache("error");
					} else if (d.reason === "stop-settled") {
						// D22 warm-resume cache: the JSONL now contains the full
						// turn (user prompt + assistant response + any tool
						// round-trips). Cache this CC session_id so the next
						// fresh user turn can spawn with --resume.
						cachedSessionId = handle.sessionId;
						cachedSessionCwd = session.cwd;
						writeBridgeLogLine(
							`warm-resume: cached sid=${handle.sessionId.slice(0, 8)} cwd=${session.cwd}`,
						);
					}
					// stop-settled is handled via transcript "done" above.
					activeSession = null;
				}
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const out = newTurnOutput(model.id);
			out.stopReason = "error";
			out.errorMessage = `streamClaudeViaPty: ${msg}`;
			try {
				stream.push({ type: "start", partial: out });
				stream.push({ type: "error", reason: "error", error: out });
				stream.end();
			} catch {}
			if (activeSession?.modelId === model.id && !activeSession.handle) {
				activeSession = null;
			}
		}
	})();
}

// Test-only hook: reset module state between integration test runs.
export function __resetActiveSessionForTests(): void {
	activeSession = null;
	cachedSessionId = null;
	cachedSessionCwd = null;
	lastSentMessageHashes = null;
}
