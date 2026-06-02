// src/capture.ts
//
// claude-p forced-toolcall CAPTURE path (T2.1). The bridge's structured-output
// mechanism on the claude-p driver: instead of the SDK's `outputFormat`, the
// capture tool is advertised as the SOLE MCP tool on a dedicated, single-shot
// claude-p spawn running in capture mode. The shim validates the model's
// arguments against the capture tool's JSON schema locally and stashes the
// validated args to a per-spawn in-process router via IPC; the bridge reads
// `router.getCaptureStash()` at turn-end and synthesizes the pi `toolCall`
// content block.
//
// This mirrors the SDK path's `runCaptureQuery` (index.ts) result shapes
// exactly:
//   - success  → start → done(reason:"toolUse") with ONE toolCall block
//                (name = captureTool.name, arguments = stashed args),
//                stopReason "toolUse", usage/cost from the terminal `result`.
//   - absent   → start → error, stopReason "error" ("model did not call
//                capture tool").
//   - aborted  → start → error(reason:"aborted"), stopReason "aborted".
//
// ISOLATION (spec "Capture path isolation"): this module owns its OWN router,
// socket, shim, and claude-p subprocess. It does NOT read or write the bridge's
// cross-call state (`cachedSessionId`, `cachedSessionCwd`, `lastSentMessageHashes`),
// does NOT touch the active-frame stack, and never supersedes a main-provider
// frame. The bridge passes only the narrow set of pure helpers it needs via
// `deps`; the state variables are deliberately NOT in that set so this code
// CANNOT mutate them.
//
// Design anchors: D16/D21 (shim validates + stashes; stash authoritative),
// D26 (claude-p driver), D28 (native disallow set), spec output-capture
// (synthesized-toolcall-content-block-on-success, surface-absent-capture-tool-
// call-as-error, capture-path-honors-abortsignal, capture-path-isolation).

import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
	Tool,
} from "@mariozechner/pi-ai";
import {
	type ClaudePSpawnConfig,
	type ClaudePHandle,
	type ClaudePDoneResult,
	type SystemPromptSource,
	type PromptSource,
	type SpawnClaudePOptions,
} from "./driver/claudeP.js";
import type { DriverStreamEvent, DriverStreamUsage } from "./driver/stream.js";
import { createRouter, type ToolDef } from "./mcp/router.js";

/** A spawn factory matching `spawnClaudeP` (NOT the resilience wrapper). */
export type CaptureSpawnFactory = (
	cfg: ClaudePSpawnConfig,
	opts: SpawnClaudePOptions,
) => ClaudePHandle;

/**
 * Narrow dependency surface the bridge (index.ts) injects. Deliberately PURE +
 * stateless helpers only — the cross-call state variables (`cachedSessionId`,
 * etc.) are intentionally absent so this module cannot touch them (isolation).
 */
export interface CaptureDeps {
	/** Build a fresh pi AssistantMessage skeleton (same helper the main path uses). */
	newTurnOutput: (model: Model<any>) => AssistantMessage;
	/** Cold-start prompt builder (full pi history → single text prompt). */
	buildColdStartPrompt: (messages: Context["messages"]) => string;
	/** Deep JSON-only clone of a TypeBox/JSON schema (drops symbol metadata). */
	cleanSchemaForSdk: (schema: unknown) => Record<string, unknown>;
	/** Populate usage.cost fields in-place for the given model+usage. */
	calculateCost: (model: Model<any>, usage: AssistantMessage["usage"]) => void;
	/** Resolve the stdio MCP shim path (dist or dev fallback). */
	resolveShimPath: () => string;
	/** Resolve the claude-p binary (JS launcher or bare name). */
	resolveClaudePBin: () => string;
	/** Spill large/multiline content to a tmpfile under os.tmpdir(). */
	writeOverflowTmp: (prefix: string, content: string) => string;
	/** A pino-style child logger already scoped to the pi session. */
	logger: {
		child: (bindings: Record<string, unknown>) => CaptureLogger;
	};
	/** Node executable used to spawn the shim. */
	execPath: string;
	/** MCP server name (`custom-tools`). */
	mcpServerName: string;
	/**
	 * Prepend the claude-p MCP-startup-race guard to the (verbatim) system prompt.
	 * The capture shim is spawned + connected by `claude` ASYNCHRONOUSLY, exactly
	 * like the main path, so the model's first turn can begin before the capture
	 * tool's `mcp__custom-tools__*` roster entry exists. Without a wait instruction
	 * the model (esp. haiku) declines ("I don't have access to <captureTool>; my
	 * only tool is WaitForMcpServers"), no capture is stashed, and the call fails
	 * spuriously. This guard makes the model call `WaitForMcpServers` first. It is
	 * a purely operational preamble (NOT pi-UI material), so it does not violate
	 * constitution V's "no semantic blending" rule. Index.ts owns the text.
	 */
	mcpWaitPreamble: (systemPrompt: string) => string;
	/** >threshold bytes → tmpfile for system prompt / user prompt. */
	promptFileThresholdBytes: number;
	/** Per-spawn wall-clock timeout (seconds). */
	timeoutSeconds: number;
	/** Spawn factory (test seam). Defaults to the real single-shot `spawnClaudeP`. */
	spawnClaudeP: CaptureSpawnFactory;
}

export interface CaptureLogger {
	debug: (...a: unknown[]) => void;
	info: (...a: unknown[]) => void;
	warn: (...a: unknown[]) => void;
	error: (...a: unknown[]) => void;
	child: (bindings: Record<string, unknown>) => CaptureLogger;
}

/**
 * Run a single-shot claude-p forced-toolcall capture and resolve the pi-ai
 * stream. Emits EXACTLY one `start` event, then one terminal `done(toolUse)` or
 * `error` event (suppressing all intermediate text/thinking/tool-use stream
 * events, mirroring the SDK path). Never throws to the caller — every exit path
 * ends the stream.
 *
 * @param model        pi model (model.id → --model; cost calc).
 * @param captureTool  the sole capture tool (its name + JSON schema).
 * @param cleanedSchema JSON-only clone of captureTool.parameters (root must be object).
 * @param context      pi context (messages → prompt; systemPrompt forwarded verbatim).
 * @param options      SimpleStreamOptions (signal, reasoning, cwd).
 * @param stream       pi-ai event stream to resolve.
 * @param deps         injected pure helpers + spawn factory (isolation surface).
 */
export async function runClaudePCapture(
	model: Model<any>,
	captureTool: Tool,
	cleanedSchema: Record<string, unknown>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	stream: AssistantMessageEventStream,
	deps: CaptureDeps,
): Promise<void> {
	const log = deps.logger.child({ model: model.id, mode: "capture-claude-p", captureTool: captureTool.name });
	log.info(`runClaudePCapture: starting capture for tool "${captureTool.name}" model=${model.id}`);

	const signal = options?.signal;

	// ── Pre-flight abort check (before any spawn / router) ────────────────────
	if (signal?.aborted) {
		const out = deps.newTurnOutput(model);
		out.stopReason = "aborted";
		out.errorMessage = "Operation aborted by user";
		safePush(stream, { type: "start", partial: out });
		safePush(stream, { type: "error", reason: "aborted", error: out });
		safeEnd(stream);
		log.info("runClaudePCapture: aborted via signal (pre-flight)");
		return;
	}

	// ── Image content is rejected pre-spawn (capture path is text-only) ───────
	// Per the image spec, image content on the capture path is surfaced as a
	// stopReason error BEFORE spawning (claude-p cannot inject images, and a
	// capture call dropping them silently would mislead the caller).
	let imageCount = 0;
	for (const m of context.messages) {
		const content = Array.isArray(m.content) ? m.content : [];
		for (const b of content) if ((b as { type?: string }).type === "image") imageCount++;
	}
	if (imageCount > 0) {
		const out = deps.newTurnOutput(model);
		out.stopReason = "error";
		out.errorMessage = `capture path: ${imageCount} image content block(s) present — the claude-p capture path is text-only and cannot inject images. Remove image content from a capture-shape call.`;
		safePush(stream, { type: "start", partial: out });
		safePush(stream, { type: "error", reason: "error", error: out });
		safeEnd(stream);
		log.warn({ imageCount }, `runClaudePCapture: rejecting ${imageCount} image block(s) — capture path is text-only`);
		return;
	}

	// ── Build prompt (text-only; systemPrompt forwarded verbatim) ─────────────
	const systemPromptText = context.systemPrompt ?? "";
	const promptString = deps.buildColdStartPrompt(context.messages);

	// Empty-prompt guard: reject only when BOTH systemPrompt and prompt are empty.
	if (!systemPromptText && !promptString) {
		const out = deps.newTurnOutput(model);
		out.stopReason = "error";
		out.errorMessage = "capture path: both systemPrompt and prompt are empty — the model has nothing to act on. Provide at least one non-empty message or a non-empty systemPrompt.";
		safePush(stream, { type: "start", partial: out });
		safePush(stream, { type: "error", reason: "error", error: out });
		safeEnd(stream);
		return;
	}

	// ── Per-spawn router (capture mode) declaring EXACTLY the one capture tool ──
	// We advertise the BARE captureTool.name (claude prefixes it to
	// `mcp__<server>__<name>` for the MODEL itself, matching the main path). The
	// shim, however, receives `tools/call` with the BARE name (MCP strips the
	// server prefix before invoking the tool handler), and its capture-mode gate
	// compares the called name against `--capture-tool`. So --capture-tool MUST be
	// the BARE name — passing the prefixed form would make the shim treat the call
	// as a main-mode forward and PARK it (deadlock).
	const router = createRouter({ logger: log });
	const captureMatchName = captureTool.name;
	const toolDefs: ToolDef[] = [{
		name: captureTool.name,
		description: captureTool.description,
		inputSchema: cleanedSchema,
	}];
	router.declareTools(toolDefs);
	await router.start();

	// ── --mcp-config pointing at the shim in CAPTURE mode ─────────────────────
	const shimPath = deps.resolveShimPath();
	const toolsB64 = Buffer.from(JSON.stringify(toolDefs), "utf-8").toString("base64");
	const mcpConfig = JSON.stringify({
		mcpServers: {
			[deps.mcpServerName]: {
				command: deps.execPath,
				args: [
					shimPath,
					"--socket", router.socketPath,
					"--mode", "capture",
					"--capture-tool", captureMatchName,
					"--tools", toolsB64,
				],
			},
		},
	});

	// System prompt: the pi systemPrompt is forwarded verbatim (constitution V; NO
	// semantic / capture-only addendum), but we PREPEND the MCP-startup-race guard
	// so the model deterministically waits for the (async-connecting) capture shim
	// before declaring the capture tool unavailable. The preamble is operational,
	// not pi-UI material — see CaptureDeps.mcpWaitPreamble.
	const systemPromptWithGuard = deps.mcpWaitPreamble(systemPromptText);
	const systemPrompt: SystemPromptSource = systemPromptWithGuard.length > deps.promptFileThresholdBytes
		? { kind: "file", path: deps.writeOverflowTmp("pcb-cap-sysprompt", systemPromptWithGuard) }
		: { kind: "text", text: systemPromptWithGuard };

	// Prompt: positional, or --input-file when large/multiline.
	const promptSrc: PromptSource = promptString.length > deps.promptFileThresholdBytes
		? { kind: "file", path: deps.writeOverflowTmp("pcb-cap-prompt", promptString) }
		: { kind: "positional", text: promptString };

	// Capture sessions are NEVER warm-resumed (single-shot, hermetic). Fresh uuid.
	const cfg: ClaudePSpawnConfig = {
		model: model.id,
		systemPrompt,
		prompt: promptSrc,
		mcpConfig,
		session: { kind: "fresh", sessionId: randomUUID() },
		timeoutSeconds: deps.timeoutSeconds,
	};

	// ── Collect usage from the driver `usage` event (terminal `result` line) ──
	let lastUsage: DriverStreamUsage | undefined;
	const onEvent = (ev: DriverStreamEvent) => {
		// Suppress all intermediate events on the capture path. Only `usage` is
		// retained (for cost propagation) — text/thinking/tool-use/done/error are
		// observed but not forwarded to pi (we synthesize the terminal shape from
		// the stash + handle.done).
		if (ev.kind === "usage") lastUsage = ev.usage;
	};

	// ── Spawn (single-shot — NO resilience wrapper on the capture path) ───────
	// We pass NO opts.signal to spawnClaudeP; abort is wired below so teardown
	// (router.stop) is centralized in one place.
	const handle = deps.spawnClaudeP(cfg, {
		onEvent,
		logger: log as unknown as SpawnClaudePOptions["logger"],
		binPath: deps.resolveClaudePBin(),
	});

	log.debug(
		{ msgs: context.messages.length, schema: JSON.stringify(cleanedSchema).slice(0, 200) },
		`runClaudePCapture: spawned claude-p model=${model.id} captureTool=${captureTool.name} prompt="${promptString.slice(0, 60)}"`,
	);

	// Push the single `start` event.
	const startOut = deps.newTurnOutput(model);
	safePush(stream, { type: "start", partial: startOut });

	// ── Abort wiring ──────────────────────────────────────────────────────────
	let streamEnded = false;
	let aborted = false;
	const finish = () => {
		// Best-effort router teardown (own socket — disjoint from any main spawn).
		void router.stop().catch(() => {});
	};
	const onAbort = () => {
		if (streamEnded) return;
		aborted = true;
		handle.abort(); // SIGINT → grace → SIGKILL of the claude-p process group.
	};
	if (signal) signal.addEventListener("abort", onAbort, { once: true });

	// ── Wait for the turn to end, then read the authoritative stash ───────────
	const res: ClaudePDoneResult = await handle.done;

	if (streamEnded) {
		finish();
		if (signal) signal.removeEventListener("abort", onAbort);
		return;
	}

	const usage = mapUsage(lastUsage);

	// Aborted wins regardless of how the spawn classified itself.
	if (aborted || res.stopReason === "aborted") {
		streamEnded = true;
		const out = deps.newTurnOutput(model);
		applyUsage(out, usage, model, deps);
		out.stopReason = "aborted";
		out.errorMessage = "Operation aborted by user";
		safePush(stream, { type: "error", reason: "aborted", error: out });
		safeEnd(stream);
		finish();
		if (signal) signal.removeEventListener("abort", onAbort);
		log.info("runClaudePCapture: aborted via signal");
		return;
	}

	const stash = router.getCaptureStash();

	if (stash !== undefined) {
		// ── Success: IPC stash is authoritative (D21). Synthesize toolCall block. ─
		streamEnded = true;
		const out = deps.newTurnOutput(model);
		applyUsage(out, usage, model, deps);
		const toolCallId = "toolu_" + randomBytes(8).toString("hex");
		out.stopReason = "toolUse";
		out.content = [{
			type: "toolCall",
			id: toolCallId,
			name: captureTool.name,
			arguments: stash,
		}];
		log.info(
			{ toolCallId, tool: captureTool.name, in: out.usage.input, out: out.usage.output },
			`runClaudePCapture: success — stash synthesized toolCall for ${captureTool.name}`,
		);
		safePush(stream, { type: "done", reason: "toolUse", message: out });
		safeEnd(stream);
		finish();
		if (signal) signal.removeEventListener("abort", onAbort);
		return;
	}

	// ── Absent: no stash by turn-end → surface as error. ──────────────────────
	streamEnded = true;
	const out = deps.newTurnOutput(model);
	applyUsage(out, usage, model, deps);
	out.stopReason = "error";
	out.errorMessage =
		res.stopReason === "error"
			? `capture path: claude-p exited abnormally (exitCode=${res.exitCode ?? "null"}) before the model called capture tool "${captureTool.name}"`
			: `model did not call capture tool "${captureTool.name}" (turn ended with no IPC-stashed arguments)`;
	log.warn({ stopReason: res.stopReason, exitCode: res.exitCode }, `runClaudePCapture: ${out.errorMessage}`);
	safePush(stream, { type: "error", reason: "error", error: out });
	safeEnd(stream);
	finish();
	if (signal) signal.removeEventListener("abort", onAbort);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Map a driver usage event (already pi-shaped) → AssistantMessage usage numbers. */
function mapUsage(u: DriverStreamUsage | undefined): DriverStreamUsage {
	return u ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
}

/** Apply usage numbers + cost to an AssistantMessage in-place. */
function applyUsage(out: AssistantMessage, usage: DriverStreamUsage, model: Model<any>, deps: CaptureDeps): void {
	out.usage.input = usage.input;
	out.usage.output = usage.output;
	out.usage.cacheRead = usage.cacheRead;
	out.usage.cacheWrite = usage.cacheWrite;
	out.usage.totalTokens = usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	deps.calculateCost(model, out.usage);
}

function safePush(stream: AssistantMessageEventStream, ev: Parameters<AssistantMessageEventStream["push"]>[0]): void {
	try { stream.push(ev); } catch { /* stream may have ended */ }
}

function safeEnd(stream: AssistantMessageEventStream): void {
	try { stream.end(); } catch { /* stream may have ended */ }
}
