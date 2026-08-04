// Selected-driver forced-tool capture path.
//
// Capture owns a dedicated process, router, shim, socket, readiness sentinel,
// and fresh session. It never reads or mutates main-frame/cache/history state.

import { randomBytes, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
	Tool,
} from "@mariozechner/pi-ai";
import type {
	ClaudePDoneResult,
	ClaudePSpawnConfig,
	PromptSource,
	SystemPromptSource,
} from "./driver/claudeP.js";
import { mapPiReasoningToClaudeEffort } from "./driver/effort.js";
import type { DriverStreamEvent, DriverStreamUsage } from "./driver/stream.js";
import { createRouter, type ToolDef } from "./mcp/router.js";

export type CaptureDriverKind = "claude-p" | "claude-print";

export interface CaptureDriverHandle {
	readonly pid: number | undefined;
	abort(): void;
	readonly done: Promise<ClaudePDoneResult>;
}

export interface CaptureDriverSpawnOptions {
	onEvent: (event: DriverStreamEvent) => void;
	logger: CaptureLogger;
	executable: string;
	diagnosticsDir?: string;
	/** Capture subprocess cwd. Main invocation cwd is never reused here. */
	cwd: string;
}

/** Adapter-owned single-attempt capture spawn. Capture never uses resilience. */
export interface CaptureDriverAdapter {
	readonly kind: CaptureDriverKind;
	spawnCapture(config: ClaudePSpawnConfig, options: CaptureDriverSpawnOptions): CaptureDriverHandle;
}

/** Pure/stateless dependencies. Main cache/frame/hash state is intentionally absent. */
export interface CaptureDeps {
	newTurnOutput: (model: Model<any>) => AssistantMessage;
	buildColdStartPrompt: (messages: Context["messages"]) => string;
	calculateCost: (model: Model<any>, usage: AssistantMessage["usage"]) => void;
	resolveShimPath: () => string;
	shimNodeArgs: (shimPath: string) => string[];
	resolveDriverExecutable: (kind: CaptureDriverKind) => string;
	writeOverflowTmp: (prefix: string, content: string) => string;
	logger: { child: (bindings: Record<string, unknown>) => CaptureLogger };
	execPath: string;
	mcpServerName: string;
	promptFileThresholdBytes: number;
	diagnosticsDir?: string;
	resolveDebugFile?: (sessionId: string, driver: CaptureDriverKind) => string | undefined;
}

export interface CaptureLogger {
	debug: (...args: unknown[]) => void;
	info: (...args: unknown[]) => void;
	warn: (...args: unknown[]) => void;
	error: (...args: unknown[]) => void;
	child: (bindings: Record<string, unknown>) => CaptureLogger;
}

/**
 * Run one isolated forced-MCP capture through owning invocation's pinned driver.
 * Emits exactly start then one terminal done(toolUse)/error event.
 */
export async function runCapture(
	model: Model<any>,
	captureTool: Tool,
	cleanedSchema: Record<string, unknown>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	stream: AssistantMessageEventStream,
	driver: CaptureDriverAdapter,
	deps: CaptureDeps,
): Promise<void> {
	const log = deps.logger.child({
		model: model.id,
		mode: "capture",
		driver: driver.kind,
		captureTool: captureTool.name,
	});
	const signal = options?.signal;

	if (signal?.aborted) {
		finishPreflightError(model, stream, deps, "aborted", "Operation aborted by user");
		return;
	}

	const systemPromptText = context.systemPrompt ?? "";
	const replayPrompt = deps.buildColdStartPrompt(context.messages);
	if (!systemPromptText && !replayPrompt) {
		finishPreflightError(
			model,
			stream,
			deps,
			"error",
			"capture path: both systemPrompt and prompt are empty — the model has nothing to act on. Provide at least one non-empty message or a non-empty systemPrompt.",
		);
		return;
	}

	let imageCount = 0;
	for (const message of context.messages) {
		const content = Array.isArray(message.content) ? message.content : [];
		for (const block of content) if ((block as { type?: string }).type === "image") imageCount++;
	}
	if (imageCount > 0) {
		log.warn(
			{ imageCount },
			`capture: dropping ${imageCount} image block(s) — selected driver ${driver.kind} capture is text-only`,
		);
	}

	const startOut = deps.newTurnOutput(model);
	safePush(stream, { type: "start", partial: startOut });

	let router: ReturnType<typeof createRouter> | undefined;
	let handle: CaptureDriverHandle | undefined;
	let handleSettled = false;
	let aborted = false;
	let terminalSent = false;
	let cleaned = false;
	let mcpReadyFile: string | undefined;
	const temporaryPromptFiles: string[] = [];
	let lastUsage: DriverStreamUsage | undefined;
	let lastDriverError: string | undefined;
	const observedCaptureArguments: string[] = [];

	const onAbort = () => {
		if (terminalSent || aborted) return;
		aborted = true;
		handle?.abort();
	};
	if (signal) signal.addEventListener("abort", onAbort, { once: true });

	const cleanup = async () => {
		if (cleaned) return;
		cleaned = true;
		if (signal) signal.removeEventListener("abort", onAbort);
		try { await router?.stop(); }
		catch (error) { log.warn({ error: errorMessage(error) }, "capture: router cleanup failed"); }
		for (const path of [mcpReadyFile, ...temporaryPromptFiles]) {
			if (!path) continue;
			try { rmSync(path, { force: true }); }
			catch (error) { log.warn({ path, error: errorMessage(error) }, "capture: artifact cleanup failed"); }
		}
	};

	try {
		router = createRouter({ logger: log });
		const toolDefs: ToolDef[] = [{
			name: captureTool.name,
			description: captureTool.description,
			inputSchema: cleanedSchema,
		}];
		router.declareTools(toolDefs);
		await router.start();
		if (aborted || signal?.aborted) throw new CaptureAbort();

		const shimPath = deps.resolveShimPath();
		const toolsB64 = Buffer.from(JSON.stringify(toolDefs), "utf8").toString("base64");
		mcpReadyFile = `${router.socketPath}.ready`;
		const mcpConfig = JSON.stringify({
			mcpServers: {
				[deps.mcpServerName]: {
					command: deps.execPath,
					args: [
						...deps.shimNodeArgs(shimPath),
						"--socket", router.socketPath,
						"--mode", "capture",
						"--capture-tool", captureTool.name,
						"--tools", toolsB64,
						"--ready-file", mcpReadyFile,
					],
				},
			},
		});

		// Tenet T5 (capture-path prompt fidelity): the static system prompt equals
		// the caller's bytes verbatim. Bridge-owned forcing/readiness guidance
		// belongs only to the user control suffix.
		const systemPrompt = systemPromptSource(
			systemPromptText,
			deps.promptFileThresholdBytes,
			() => deps.writeOverflowTmp("pcb-cap-sysprompt", systemPromptText),
		);
		if (systemPrompt.kind === "file") temporaryPromptFiles.push(systemPrompt.path);

		const controlSuffix = buildCaptureControlSuffix(
			driver.kind,
			deps.mcpServerName,
			captureTool,
			cleanedSchema,
		);
		const promptText = replayPrompt
			? `${replayPrompt}\n\n${controlSuffix}`
			: controlSuffix;
		const prompt = userPromptSource(
			promptText,
			deps.promptFileThresholdBytes,
			() => deps.writeOverflowTmp("pcb-cap-prompt", promptText),
		);
		if (prompt.kind === "file") temporaryPromptFiles.push(prompt.path);

		const captureSessionId = randomUUID();
		const config: ClaudePSpawnConfig = {
			model: model.id,
			effort: mapPiReasoningToClaudeEffort(options?.reasoning),
			systemPrompt,
			prompt,
			mcpConfig,
			session: { kind: "fresh", sessionId: captureSessionId },
			debugFile: deps.resolveDebugFile?.(captureSessionId, driver.kind),
			// claude-p fork consumes this as --mcp-ready-file Enter gate. Direct
			// adapter replaces it with its private pre-NDJSON readiness sentinel.
			mcpReadyFile,
		};

		const qualifiedCaptureName = `mcp__${deps.mcpServerName}__${captureTool.name}`;
		handle = driver.spawnCapture(config, {
			onEvent: (event) => {
				// Capture suppresses all intermediate pi events. Terminal billing is
				// authoritative; observed tool_use is diagnostics-only cross-check.
				if (event.kind === "usage") lastUsage = event.billing ?? event.usage;
				else if (event.kind === "error") lastDriverError = event.errorMessage;
				else if (event.kind === "tool-use" && event.name === qualifiedCaptureName) {
					observedCaptureArguments.push(canonicalJson(event.arguments));
				}
			},
			logger: log,
			executable: deps.resolveDriverExecutable(driver.kind),
			diagnosticsDir: deps.diagnosticsDir,
			cwd: tmpdir(),
		});

		log.debug(
			{ messages: context.messages.length, isolatedCwd: tmpdir(), effort: config.effort ?? null },
			`capture: spawned ${driver.kind} for ${captureTool.name}`,
		);

		const result = await handle.done;
		handleSettled = true;
		if (aborted || result.stopReason === "aborted") throw new CaptureAbort();

		const stash = router.getCaptureStash();
		const validationFailure = router.getCaptureValidationFailure();
		const out = deps.newTurnOutput(model);
		applyUsageOnce(out, lastUsage, model, deps);

		if (stash !== undefined && result.stopReason === "result") {
			const matchingObservation = observedCaptureArguments.includes(canonicalJson(stash));
			if (!matchingObservation) {
				log.warn(
					{ observedCaptureCalls: observedCaptureArguments.length, captureTool: captureTool.name },
					"capture: divergent capture observation; trusting schema-valid IPC stash",
				);
			}
			out.stopReason = "toolUse";
			out.content = [{
				type: "toolCall",
				id: `toolu_${randomBytes(8).toString("hex")}`,
				name: captureTool.name,
				arguments: stash,
			}];
			log.debug({ captureTool: captureTool.name, driver: driver.kind }, "capture: completed");
			await cleanup();
			terminalSent = true;
			safePush(stream, { type: "done", reason: "toolUse", message: out });
			safeEnd(stream);
			return;
		}

		out.stopReason = "error";
		out.errorMessage = stash !== undefined
			? lastDriverError ?? `capture path: ${driver.kind} did not complete with a successful terminal result (exitCode=${result.exitCode ?? "null"})`
			: validationFailure
				? `capture tool "${captureTool.name}" argument validation failed on attempt ${validationFailure.attempt} at ${validationFailure.field}: ${validationFailure.message}`
				: lastDriverError ?? (result.stopReason === "error"
					? `capture path: ${driver.kind} exited abnormally (exitCode=${result.exitCode ?? "null"}) before the model called capture tool "${captureTool.name}"`
					: `model did not call capture tool "${captureTool.name}" (turn ended with no IPC-stashed arguments)`);
		log.warn({ stopReason: result.stopReason, exitCode: result.exitCode }, `capture: ${out.errorMessage}`);
		await cleanup();
		terminalSent = true;
		safePush(stream, { type: "error", reason: "error", error: out });
		safeEnd(stream);
	} catch (error) {
		if (!handleSettled) handle?.abort();
		const wasAborted = error instanceof CaptureAbort || aborted || signal?.aborted;
		const out = deps.newTurnOutput(model);
		applyUsageOnce(out, lastUsage, model, deps);
		out.stopReason = wasAborted ? "aborted" : "error";
		out.errorMessage = wasAborted
			? "Operation aborted by user"
			: `capture path: ${driver.kind} failed: ${errorMessage(error)}`;
		if (!terminalSent) {
			await cleanup();
			terminalSent = true;
			safePush(stream, { type: "error", reason: wasAborted ? "aborted" : "error", error: out });
			safeEnd(stream);
		}
	} finally {
		await cleanup();
	}
}

/** Compatibility export for downstream imports while implementation is driver-neutral. */
export const runClaudePCapture = runCapture;

function systemPromptSource(text: string, thresholdBytes: number, writeFile: () => string): SystemPromptSource {
	return Buffer.byteLength(text, "utf8") > thresholdBytes
		? { kind: "file", path: writeFile() }
		: { kind: "text", text };
}

function userPromptSource(text: string, thresholdBytes: number, writeFile: () => string): PromptSource {
	return Buffer.byteLength(text, "utf8") > thresholdBytes
		? { kind: "file", path: writeFile() }
		: { kind: "positional", text };
}

function buildCaptureControlSuffix(
	driver: CaptureDriverKind,
	mcpServerName: string,
	captureTool: Tool,
	cleanedSchema: Record<string, unknown>,
): string {
	const readiness = driver === "claude-p"
		? "If the required tool is not visible yet, call `WaitForMcpServers`, wait for connection, then call it."
		: "Bridge readiness gate has completed before this user frame; the required tool is available for direct use.";
	const completion = driver === "claude-p"
		// claude-p needs visible post-tool assistant text to detect TUI completion;
		// a tool-only final response can end in its StopTimeout despite a valid stash.
		? "Always finish with exact standalone text `CAPTURE_COMPLETE` and end the turn, even if the tool was not called or failed. This completion marker does not replace the required tool call."
		: "After the tool succeeds, end the turn without prose.";
	return [
		"<bridge_capture_control>",
		"You are in structured capture mode.",
		`You MUST call the \`${captureTool.name}\` tool exactly once through the connected \`${mcpServerName}\` MCP server.`,
		"Do not summarize in plain text. Do not end the turn until the capture tool has been called successfully.",
		readiness,
		completion,
		`Tool arguments MUST satisfy this JSON schema: ${JSON.stringify(cleanedSchema)}`,
		"</bridge_capture_control>",
	].join("\n");
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function applyUsageOnce(
	out: AssistantMessage,
	usage: DriverStreamUsage | undefined,
	model: Model<any>,
	deps: CaptureDeps,
): void {
	const mapped = usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
	out.usage.input = mapped.input;
	out.usage.output = mapped.output;
	out.usage.cacheRead = mapped.cacheRead;
	out.usage.cacheWrite = mapped.cacheWrite;
	out.usage.totalTokens = mapped.totalTokens || mapped.input + mapped.output + mapped.cacheRead + mapped.cacheWrite;
	deps.calculateCost(model, out.usage);
}

function finishPreflightError(
	model: Model<any>,
	stream: AssistantMessageEventStream,
	deps: CaptureDeps,
	reason: "aborted" | "error",
	message: string,
): void {
	const out = deps.newTurnOutput(model);
	out.stopReason = reason;
	out.errorMessage = message;
	safePush(stream, { type: "start", partial: out });
	safePush(stream, { type: "error", reason, error: out });
	safeEnd(stream);
}

class CaptureAbort extends Error {}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function safePush(stream: AssistantMessageEventStream, event: Parameters<AssistantMessageEventStream["push"]>[0]): void {
	try { stream.push(event); } catch { /* stream may already be closed */ }
}

function safeEnd(stream: AssistantMessageEventStream): void {
	try { stream.end(); } catch { /* stream may already be closed */ }
}
