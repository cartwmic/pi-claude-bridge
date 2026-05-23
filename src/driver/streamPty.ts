// src/driver/streamPty.ts
//
// T1.10 PTY-driven streamSimple path. Selected when CLAUDE_BRIDGE_DRIVER=pty.
//
// v0 scope: cold-start fresh-turn execution.
//   - Text-only positional prompt (image content stripped with warn).
//   - Bridged MCP tool surface (router parks tool_call frames; deliverResult
//     routes pi's eventual tool_result back to the model).
//   - AbortSignal propagation.
//   - One turn at a time, no supersede / divergence / cache for v0; the
//     SDK path's stack-of-frames machinery is preserved for Phase 3 cutover
//     by porting the existing index.ts state into this driver layer in a
//     follow-up.
//
// Public surface: `streamClaudeViaPty(model, context, options)` returns an
// `AssistantMessageEventStream` that pi-ai consumes.

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
import { spawnDriver } from "./pty.js";
import type { RouterToolDefinition } from "../mcp/router.js";
import type { TranscriptEvent } from "./transcript.js";

// --- Helpers -------------------------------------------------------------

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
	// In production: dist/driver/streamPty.js → ../mcp/shim.js = dist/mcp/shim.js.
	// In dev (tsx-loaded source): src/driver/streamPty.ts → ../mcp/shim.ts. tsx
	// resolves the .js extension to .ts at runtime, but the SHIM is invoked as
	// a CHILD PROCESS via node-pty's spawn of `claude` which spawns it via
	// the MCP stdio transport — that child is a fresh Node process WITHOUT
	// tsx loaded. So in dev we MUST point at the built dist/mcp/shim.js, not
	// the .ts source. The build pipeline (npm run build) emits dist/ from
	// the project root, so we walk up from this file: src/driver/streamPty.ts
	// (or dist/driver/streamPty.js) → ../../dist/mcp/shim.js.
	const hereUrl = import.meta.url;
	// Walk two levels up (driver → src OR dist, then up to project root),
	// then descend into dist/mcp/shim.js.
	return new URL("../../dist/mcp/shim.js", hereUrl).pathname;
}

// --- Entry point ---------------------------------------------------------

export interface StreamPtyExtras {
	/** Pre-built system prompt (already combined per main-provider rules). */
	systemPrompt: string;
	/** Stream factory provided by caller (so index.ts owns the event-stream type). */
	makeStream: () => AssistantMessageEventStream;
	/** Active tools (output-capture path will call a separate runCaptureQueryPty). */
	tools: Tool[];
	/** Working directory for `claude` spawn. */
	cwd: string;
}

/**
 * v0 PTY-path streamSimple replacement. Returns the pi-ai event stream.
 *
 * Behavior:
 *   - Spawn driver with the resolved CLI args, listen for transcript events,
 *     project onto the pi-ai stream.
 *   - First text-delta → emit start, text_start, text_delta.
 *   - Subsequent text-deltas → emit text_delta.
 *   - tool_use observed in transcript → emit toolcall_start + toolcall_end +
 *     done(toolUse). The router-side parked tool_call is what causes the
 *     subsequent pi tool execution + streamSimple(tool_result) call; for v0
 *     each pi-side resolution is fire-and-forget (we don't yet preserve
 *     stack state for follow-ups; that's Phase 3).
 *   - Stop hook + settle window → done(stop) with final usage.
 *   - Abort signal → driver.abort() → done(error, reason: aborted).
 */
export function streamClaudeViaPty(
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	extras: StreamPtyExtras,
): AssistantMessageEventStream {
	const stream = extras.makeStream();
	const out = newTurnOutput(model.id);
	let started = false;
	let ended = false;
	let textBuffer = "";
	let textContentIndex = -1;
	let totalContentIndex = 0;

	const { prompt, imagesDropped } = buildPromptText(context.messages);
	if (imagesDropped > 0) {
		// emit warn via stderr (caller can inspect via debug log if needed)
		process.stderr.write(`pi-claude-bridge: stripped ${imagesDropped} image block(s) from main-provider prompt (v1 limitation)\n`);
	}

	const ensureStarted = () => {
		if (started) return;
		started = true;
		stream.push({ type: "start", partial: out });
	};

	const endWith = (
		ev: { type: "done"; reason: "stop" | "toolUse"; message: AssistantMessage } |
			{ type: "error"; reason: "aborted" | "error"; error: AssistantMessage },
	) => {
		if (ended) return;
		ended = true;
		ensureStarted();
		stream.push(ev as any);
		stream.end();
	};

	(async () => {
		try {
			const tools = toolsToRouterDefs(extras.tools);
			writeBridgeLogLine(`streamSimple: PTY spawn model=${model.id} promptLen=${prompt.length} sysLen=${extras.systemPrompt.length} tools=${tools.length}`);
			// Scenario-lib compat: emit "fresh query" log line with resume= field.
			// v0 streamPty cold-starts every turn (warm-resume is v1.1.0 work), so
			// the resume value is always "no". When warm-resume lands, switch to
			// the cached session id.
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

			writeBridgeLogLine(`streamSimple: spawned session=${handle.sessionId.slice(0, 8)} transcriptPath=${handle.transcriptPath}`);
			handle.on("hook", (e: { event: string; payload: Record<string, unknown> }) => {
				writeBridgeLogLine(`streamSimple: hook event=${e.event} session=${handle.sessionId.slice(0, 8)}`);
			});
			handle.on("transcript", (e: TranscriptEvent) => {
				if (ended) return;
				switch (e.kind) {
					case "text-delta": {
						ensureStarted();
						if (textContentIndex === -1) {
							textContentIndex = totalContentIndex++;
							out.content.push({ type: "text", text: "" });
							stream.push({ type: "text_start", contentIndex: textContentIndex, partial: out });
						}
						const delta = e.text;
						textBuffer += delta;
						(out.content[textContentIndex] as any).text = textBuffer;
						stream.push({
							type: "text_delta",
							contentIndex: textContentIndex,
							delta,
							partial: out,
						});
						return;
					}
					case "thinking-delta": {
						ensureStarted();
						const idx = totalContentIndex++;
						out.content.push({ type: "thinking", thinking: e.text, thinkingSignature: e.signature ?? "" } as any);
						stream.push({ type: "thinking_start", contentIndex: idx, partial: out });
						if (e.text) {
							stream.push({ type: "thinking_delta", contentIndex: idx, delta: e.text, partial: out });
						}
						stream.push({ type: "thinking_end", contentIndex: idx, content: e.text, partial: out });
						return;
					}
					case "tool-use": {
						ensureStarted();
						// Close any in-flight text block.
						if (textContentIndex !== -1) {
							stream.push({
								type: "text_end",
								contentIndex: textContentIndex,
								content: textBuffer,
								partial: out,
							});
							textContentIndex = -1;
							textBuffer = "";
						}
						const idx = totalContentIndex++;
						// Translate `mcp__custom-tools__foo` back to `foo` for pi.
						const piToolName = e.name.startsWith("mcp__custom-tools__")
							? e.name.slice("mcp__custom-tools__".length)
							: e.name;
						const toolCall: ToolCall = {
							type: "toolCall" as const,
							id: e.toolUseId || "toolu_" + randomBytes(8).toString("hex"),
							name: piToolName,
							arguments: (e.input ?? {}) as Record<string, unknown>,
						};
						out.content.push({
							type: "toolCall",
							id: toolCall.id,
							name: piToolName,
							arguments: toolCall.arguments,
						} as any);
						stream.push({ type: "toolcall_start", contentIndex: idx, partial: out });
						stream.push({
							type: "toolcall_end",
							contentIndex: idx,
							toolCall,
							partial: out,
						});
						out.stopReason = "toolUse";
						endWith({ type: "done", reason: "toolUse", message: out });
						return;
					}
					case "usage": {
						out.usage.input += e.usage.input;
						out.usage.output += e.usage.output;
						out.usage.cacheRead += e.usage.cacheRead;
						out.usage.cacheWrite += e.usage.cacheWrite;
						out.usage.totalTokens = out.usage.input + out.usage.output;
						return;
					}
					case "warn":
						// Surfaced via stderr; tailer keeps going.
						return;
					case "error": {
						out.stopReason = "error";
						out.errorMessage = e.errorMessage;
						endWith({ type: "error", reason: "error", error: out });
						return;
					}
					case "done": {
						// Flush any in-flight text block.
						if (textContentIndex !== -1) {
							stream.push({
								type: "text_end",
								contentIndex: textContentIndex,
								content: textBuffer,
								partial: out,
							});
							textContentIndex = -1;
						}
						if (e.reason === "aborted") {
							out.stopReason = "stop";
							endWith({ type: "error", reason: "aborted", error: out });
						} else {
							out.stopReason = "stop";
							endWith({ type: "done", reason: "stop", message: out });
						}
						return;
					}
				}
			});

			handle.on("tool-call-parked", (entry) => {
				// Scenario-lib compat: emit "mcp handler: <tool> [<id>] — awaiting pi"
				// log line so scenario-lib's tool-handler counters work the same
				// as on the SDK path. SDK path used the SHORT tool name (no
				// `mcp__custom-tools__` prefix); strip for compat.
				const shortName = entry.name.replace(/^mcp__custom-tools__/, "");
				writeBridgeLogLine(`mcp handler: ${shortName} [${entry.id}] — awaiting pi`);
				// v0: we don't await pi's eventual tool_result delivery here
				// (no stack/frame integration yet). The transcript path's
				// tool-use block has already emitted `done(toolUse)`. To
				// avoid a stale-tool-call hang on the model side, deliver a
				// synthetic stub immediately so the shim returns. Phase 3
				// will rewire this through the full frame machinery.
				try {
					entry.deliverResult(
						[{ type: "text", text: "[pi: tool execution deferred; see follow-up message]" }],
						false,
					);
					writeBridgeLogLine(`tool-result delivery: ${shortName} [${entry.id}]`);
				} catch {}
			});

			handle.on("done", (d) => {
				// Emit a 'caching session=' compatible log line into the bridge
				// debug log so scenario-lib's scn_send completion detector still
				// fires on the PTY path. (Originally an SDK-path signal.)
				writeBridgeLogLine(`streamSimple: caching session=${handle.sessionId.slice(0, 8)} done=${d.reason}`);
				if (d.reason === "aborted") {
					// Scenario-lib compat: SDK-era abort signal.
					writeBridgeLogLine(`onAbort: session=${handle.sessionId.slice(0, 8)}`);
					out.stopReason = "stop";
					endWith({ type: "error", reason: "aborted", error: out });
				} else if (d.reason === "error") {
					out.stopReason = "error";
					out.errorMessage = d.errorMessage;
					endWith({ type: "error", reason: "error", error: out });
				}
				// stop-settled is handled via transcript "done" event above.
			});

			// Scenario-lib compat: emit per-turn usage line when transcript reports usage.
			handle.on("transcript", (e: TranscriptEvent) => {
				if (e.kind !== "usage") return;
				const u = e.usage;
				writeBridgeLogLine(
					`usage: cacheRead=${u.cacheRead} cacheWrite=${u.cacheWrite} input=${u.input} output=${u.output}`,
				);
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			out.stopReason = "error";
			out.errorMessage = `streamClaudeViaPty: ${msg}`;
			endWith({ type: "error", reason: "error", error: out });
		}
	})();

	return stream;
}
