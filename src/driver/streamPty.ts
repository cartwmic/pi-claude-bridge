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

function newTurnOutput(modelId: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages" as any,
		provider: "claude-bridge" as any,
		model: modelId,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
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
 * shim's advertised set. Names use the `mcp__custom-tools__*` prefix.
 */
function toolsToRouterDefs(tools: Tool[]): RouterToolDefinition[] {
	return tools.map((t) => ({
		name: `mcp__custom-tools__${t.name}`,
		description: t.description ?? "",
		inputSchema: t.parameters ?? { type: "object" },
	}));
}

function resolveShimPath(): string {
	const hereUrl = import.meta.url;
	return new URL("../../dist/mcp/shim.js", hereUrl).pathname;
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
	// pendingEntries: keyed by Anthropic toolUseId (the id pi sees). Populated
	// only after a tool-use transcript event + tool-call-parked event are
	// paired via FIFO (see correlateParked).
	pendingEntries: Map<string, PendingEntry>;
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
		session.pendingEntries.set(toolUseId, entry);
		const shortName = entry.name.replace(/^mcp__custom-tools__/, "");
		writeBridgeLogLine(`mcp handler: ${shortName} [${toolUseId}] — awaiting pi`);
	}
}

let activeSession: ActiveSession | null = null;

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
		writeBridgeLogLine(
			`streamSimple: tool-result delivery, ${trailing.length} results, ${session.pendingEntries.size} resolvers waiting`,
		);

		// Re-wire the active session's stream to the NEW pi-ai stream so
		// subsequent transcript events (text-deltas, next tool_use, Stop)
		// flow into pi's TUI.
		resetTurnState(session, stream, model.id);

		// Deliver each result to its parked entry. CC will resume generating.
		for (const r of trailing) {
			const entry = session.pendingEntries.get(r.id);
			if (!entry) {
				writeBridgeLogLine(
					`streamSimple: orphan tool-result id=${r.id} (no parked entry; ignoring)`,
				);
				continue;
			}
			session.pendingEntries.delete(r.id);
			const shortName = entry.name.replace(/^mcp__custom-tools__/, "");
			try {
				entry.deliverResult(
					[{ type: "text" as const, text: r.content || "" }],
					r.isError,
				);
				writeBridgeLogLine(
					`tool-result delivery: ${shortName} [${r.id}]${r.isError ? " (isError)" : ""}`,
				);
			} catch (err) {
				writeBridgeLogLine(
					`tool-result delivery failed: ${shortName} [${r.id}] err=${(err as Error)?.message ?? String(err)}`,
				);
			}
		}
		return stream;
	}

	// ---- Case 2: orphaned tool result (no active session) ----
	if (lastMsg?.role === "toolResult") {
		writeBridgeLogLine(
			`streamSimple: orphaned tool-result, no active session — emitting aborted`,
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
			`streamSimple: superseding active frame (pendingEntries=${totalPending}), interrupting`,
		);
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
	const { prompt, imagesDropped } = buildPromptText(context.messages);
	if (imagesDropped > 0) {
		process.stderr.write(
			`pi-claude-bridge: stripped ${imagesDropped} image block(s) from main-provider prompt (v1 limitation)\n`,
		);
	}

	(async () => {
		try {
			const tools = toolsToRouterDefs(extras.tools);
			writeBridgeLogLine(
				`streamSimple: PTY spawn model=${model.id} promptLen=${prompt.length} sysLen=${extras.systemPrompt.length} tools=${tools.length}`,
			);
			writeBridgeLogLine(`streamSimple: fresh query resume=no model=${model.id}`);
			const handle = await spawnDriver({
				shimPath: resolveShimPath(),
				model: model.id,
				prompt,
				systemPrompt: extras.systemPrompt,
				cwd: extras.cwd,
				mode: "main",
				tools,
				signal: options?.signal as AbortSignal | undefined,
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
				pendingEntries: new Map(),
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
						const piToolName = e.name.startsWith("mcp__custom-tools__")
							? e.name.slice("mcp__custom-tools__".length)
							: e.name;
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
						session.out.usage.input += e.usage.input;
						session.out.usage.output += e.usage.output;
						session.out.usage.cacheRead += e.usage.cacheRead;
						session.out.usage.cacheWrite += e.usage.cacheWrite;
						session.out.usage.totalTokens = session.out.usage.input + session.out.usage.output;
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
							session.out.stopReason = "stop";
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
						writeBridgeLogLine(`onAbort: session=${handle.sessionId.slice(0, 8)}`);
						if (!session.ended) {
							session.out.stopReason = "stop";
							endWith(session, { type: "error", reason: "aborted", error: session.out });
						}
					} else if (d.reason === "error") {
						if (!session.ended) {
							session.out.stopReason = "error";
							session.out.errorMessage = d.errorMessage;
							endWith(session, { type: "error", reason: "error", error: session.out });
						}
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
}
