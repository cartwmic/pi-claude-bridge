// src/capture.ts
//
// T2.1 forced-MCP-tool-call capture path on the PTY driver. Replaces the
// SDK-backed runCaptureQuery for the new path.
//
// Contract (output-capture spec):
//   - Caller provides exactly one capture tool with object-root schema.
//   - We spawn a driver in `mode: "capture"` with that single tool advertised.
//   - The shim handles tools/call locally per D16/D21: validates args,
//     stashes via IPC, returns deterministic success → model emits end_turn.
//   - We harvest router.capturedArgs and synthesize a toolCall content block.
//   - If model never calls the tool (done arrives with no capturedArgs):
//     emit error per output-capture.surface-absent-capture-tool-call-as-error.
//   - Hermetic: cwd = os.tmpdir() per Decision 12.
//   - ctx.systemPrompt forwarded VERBATIM (constitution V).

import { randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
	Tool,
} from "@mariozechner/pi-ai";
import { spawnDriver } from "./driver/pty.js";

function newCaptureOutput(modelId: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages" as any,
		provider: "claude-bridge" as any,
		model: modelId,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function flattenMsgText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const b of content as any[]) {
		if (b && b.type === "text" && typeof b.text === "string") parts.push(b.text);
	}
	return parts.join("");
}

function buildCaptureColdStartPrompt(messages: Context["messages"]): { prompt: string; hasImages: boolean } {
	let hasImages = false;
	const has = (c: unknown) => {
		if (!Array.isArray(c)) return;
		for (const b of c) if (b && (b as any).type === "image") hasImages = true;
	};
	const out: string[] = [];
	for (const m of messages) {
		has(m.content);
		const t = flattenMsgText(m.content);
		if (!t) continue;
		out.push(`[${m.role}] ${t}`);
	}
	return { prompt: out.join("\n"), hasImages };
}

function resolveShimPath(): string {
	const req = createRequire(import.meta.url);
	try { return req.resolve("../dist/mcp/shim.js"); }
	catch { return new URL("./mcp/shim.js", import.meta.url).pathname; }
}

export interface CaptureRunOptions {
	captureTool: Tool;
	cleanedSchema: Record<string, unknown>;
	makeStream: () => AssistantMessageEventStream;
}

/**
 * Execute one capture turn via the PTY driver.
 *
 * Returns the pi-ai event stream. On success the stream emits start + done
 * with one synthesized toolCall content block carrying the captured args.
 */
export function runCaptureQueryPty(
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	opts: CaptureRunOptions,
): AssistantMessageEventStream {
	const stream = opts.makeStream();
	const out = newCaptureOutput(model.id);
	let started = false;
	let ended = false;

	const ensureStarted = () => {
		if (started) return;
		started = true;
		stream.push({ type: "start", partial: out } as any);
	};
	const endError = (msg: string) => {
		if (ended) return;
		ended = true;
		ensureStarted();
		out.stopReason = "error";
		out.errorMessage = msg;
		stream.push({ type: "error", reason: "error", error: out } as any);
		stream.end();
	};

	const { prompt, hasImages } = buildCaptureColdStartPrompt(context.messages);
	if (hasImages) {
		endError("pi-claude-bridge: capture path rejects image content (v1 limitation per claude-tui-driver.image-content-handling-in-v1)");
		return stream;
	}

	(async () => {
		const cwd = realpathSync(mkdtempSync(join(tmpdir(), "pi-bridge-capture-")));
		const captureName = `mcp__custom-tools__${opts.captureTool.name}`;
		try {
			const handle = await spawnDriver({
				shimPath: resolveShimPath(),
				model: model.id,
				prompt,
				systemPrompt: context.systemPrompt ?? "", // verbatim (constitution V)
				cwd,
				mode: "capture",
				tools: [{
					name: captureName,
					description: opts.captureTool.description ?? "",
					inputSchema: opts.cleanedSchema,
				}],
				capture: { toolName: captureName, schema: opts.cleanedSchema },
				signal: options?.signal as AbortSignal | undefined,
			});

			handle.on("transcript", (e) => {
				if (e.kind === "usage") {
					out.usage.input += e.usage.input;
					out.usage.output += e.usage.output;
					out.usage.cacheRead += e.usage.cacheRead;
					out.usage.cacheWrite += e.usage.cacheWrite;
					out.usage.totalTokens = out.usage.input + out.usage.output;
				}
			});

			const done = await handle.done;
			if (done.reason === "aborted") {
				if (ended) return;
				ended = true;
				ensureStarted();
				stream.push({ type: "error", reason: "aborted", error: out } as any);
				stream.end();
				return;
			}
			if (done.reason === "error") {
				endError(`capture path driver error: ${done.errorMessage}`);
				return;
			}
			// done === stop-settled: harvest capturedArgs
			const captured = handle.router.capturedArgs;
			if (captured === undefined) {
				endError(`output-capture: model emitted no valid call to capture tool '${opts.captureTool.name}'`);
				return;
			}
			const toolCallId = "toolu_" + randomBytes(8).toString("hex");
			out.stopReason = "toolUse";
			out.content = [{
				type: "toolCall",
				id: toolCallId,
				name: opts.captureTool.name,
				arguments: captured as Record<string, unknown>,
			} as any];
			if (ended) return;
			ended = true;
			ensureStarted();
			stream.push({ type: "done", reason: "toolUse", message: out } as any);
			stream.end();
		} catch (err) {
			endError(`capture path spawn error: ${(err as Error).message}`);
		}
	})();

	return stream;
}
