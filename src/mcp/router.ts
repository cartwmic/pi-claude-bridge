// Per-invocation MCP router. Shim calls are execution-authoritative; selected-
// driver tool_use records are observations joined only for D32 id correlation.

import { randomBytes } from "node:crypto";
import {
	createIpcServer,
	generateSocketPath,
	type IpcServer,
	type ToolCallRequest,
	type ToolCallResponse,
	type CaptureStashRequest,
	type CaptureValidationFailedRequest,
	type ToolResultContent,
} from "./ipc.js";

export type ToolResult = { content: ToolResultContent; isError?: boolean };

export type ToolDef = {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
};

export type RouterLogger = {
	debug: (...a: any[]) => void;
	info: (...a: any[]) => void;
	warn: (...a: any[]) => void;
	error: (...a: any[]) => void;
};

const NOOP_LOG: RouterLogger = {
	debug() {},
	info() {},
	warn() {},
	error() {},
};

const BRIDGED_PREFIX = "mcp__custom-tools__";
const CORRELATION_DRAIN_TEXT = "Bridge tool-call correlation failed; invocation was invalidated.";
const TEARDOWN_DRAIN_TEXT = "Bridge invocation ended before the tool result was delivered.";
const MAX_CAPTURE_EVIDENCE_BYTES = 500;

export type ParkedCallInfo = {
	/** Stable resolver key shown to pi and returned in pi toolResult.id. */
	piId: string;
	shimRequestId: string;
	/** Bare router-declared tool name. */
	name: string;
	arguments: Record<string, unknown>;
	argsKey: string;
	/** Driver/model id is metadata only and never replaces piId. */
	modelId?: string;
};

export type DriverToolUseObservation = {
	batchId: string;
	modelId: string;
	name: string;
	arguments: Record<string, unknown>;
};

export type CorrelationFailure = {
	code: "tool-call-correlation-mismatch";
	message: string;
	expectedObservationCount: number;
	shimCallCount: number;
	invalidateResumeHint: true;
};

export type CaptureValidationFailure = {
	attempt: number;
	field: string;
	message: string;
};

export type RouterOptions = {
	socketPath?: string;
	logger?: RouterLogger;
	mintPiId?: () => string;
	onPark?: (info: ParkedCallInfo) => void;
	onCorrelationFailure?: (failure: CorrelationFailure) => void;
};

export type Router = {
	readonly socketPath: string;
	readonly toolDefs: ToolDef[];
	readonly pendingResolvers: Map<string, (result: ToolResult) => void>;
	readonly pendingResults: Map<string, ToolResult>;
	start: () => Promise<void>;
	declareTools: (defs: ToolDef[]) => void;
	deliver: (piToolResultId: string, result: ToolResult) => void;
	observeToolUse: (observation: DriverToolUseObservation) => "accepted" | "duplicate" | "ignored" | "failed";
	sealToolUseBatch: (batchId: string) => CorrelationFailure | undefined;
	finalizeToolUseCorrelation: () => CorrelationFailure | undefined;
	getCorrelationFailure: () => CorrelationFailure | undefined;
	resolvePiIdForModelId: (modelId: string) => string | undefined;
	getCaptureStash: () => Record<string, unknown> | undefined;
	getCaptureValidationFailure: () => CaptureValidationFailure | undefined;
	listParkedCalls: () => ParkedCallInfo[];
	readonly everRoutedToolCall: boolean;
	stop: () => Promise<void>;
};

type Observation = {
	batchId: string;
	modelId: string;
	name: string;
	arguments: Record<string, unknown>;
	argsKey: string;
	piId?: string;
};

type ObservationBatch = {
	id: string;
	observations: Observation[];
	sealed: boolean;
};

type PendingCall = {
	info: ParkedCallInfo;
	key: string;
	declaredModelId?: string;
	settled: boolean;
};

type RequestRecord = {
	signature: string;
	promise: Promise<ToolCallResponse>;
};

/** Stable canonical serialization used for both argument matching and dedupe. */
export function canonicalizeArgs(args: Record<string, unknown>): string {
	const sortDeep = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(sortDeep);
		if (value !== null && typeof value === "object") {
			const out: Record<string, unknown> = {};
			for (const key of Object.keys(value as Record<string, unknown>).sort()) {
				out[key] = sortDeep((value as Record<string, unknown>)[key]);
			}
			return out;
		}
		return value;
	};
	return JSON.stringify(sortDeep(args ?? {}));
}

function normalizeToolName(name: string): string | undefined {
	if (name.startsWith(BRIDGED_PREFIX)) {
		const bare = name.slice(BRIDGED_PREFIX.length);
		return bare.length > 0 ? bare : undefined;
	}
	// Shim receives bare names because MCP strips server qualification.
	return name.length > 0 && !name.startsWith("mcp__") ? name : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function truncateUtf8(value: string, maxBytes = MAX_CAPTURE_EVIDENCE_BYTES): string {
	const bytes = Buffer.from(value, "utf8");
	if (bytes.length <= maxBytes) return value;
	let end = maxBytes;
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end).toString("utf8");
}

function safeEvidence(value: unknown): string {
	const text = typeof value === "string" ? value : String(value ?? "");
	return truncateUtf8(text.replace(/[\u0000-\u001f\u007f]/g, " "));
}

export function createRouter(opts: RouterOptions = {}): Router {
	const log = opts.logger ?? NOOP_LOG;
	const socketPath = opts.socketPath ?? generateSocketPath();
	const mintPiId = opts.mintPiId ?? (() => `pi-${randomBytes(8).toString("hex")}`);

	let toolDefs: ToolDef[] = [];
	const pendingResolvers = new Map<string, (result: ToolResult) => void>();
	const pendingResults = new Map<string, ToolResult>();
	const parked = new Map<string, ParkedCallInfo>();
	const requestsByShimId = new Map<string, RequestRecord>();
	const batches = new Map<string, ObservationBatch>();
	const batchOrder: ObservationBatch[] = [];
	const observationsByModelId = new Map<string, Observation>();
	const aliases = new Map<string, string>();
	const unmatchedCalls: PendingCall[] = [];
	let captureStash: Record<string, unknown> | undefined;
	let captureValidationFailure: CaptureValidationFailure | undefined;
	let everRoutedToolCall = false;
	let correlationFailure: CorrelationFailure | undefined;
	let stopped = false;
	let stopPromise: Promise<void> | undefined;

	const counts = () => ({
		expected: batchOrder.reduce((sum, batch) => sum + batch.observations.length, 0),
		shim: Array.from(observationsByModelId.values()).filter((observation) => observation.piId !== undefined).length,
	});

	const drain = (text: string): void => {
		for (const [piId, resolve] of Array.from(pendingResolvers.entries())) {
			pendingResolvers.delete(piId);
			resolve({ content: [{ type: "text", text }], isError: true });
		}
		pendingResults.clear();
	};

	const fail = (message: string): CorrelationFailure => {
		if (correlationFailure) return correlationFailure;
		const { expected, shim } = counts();
		correlationFailure = {
			code: "tool-call-correlation-mismatch",
			message,
			expectedObservationCount: expected,
			shimCallCount: shim + unmatchedCalls.length,
			invalidateResumeHint: true,
		};
		log.error({ event: "router.correlation.failed", ...correlationFailure }, message);
		drain(CORRELATION_DRAIN_TEXT);
		try {
			opts.onCorrelationFailure?.(correlationFailure);
		} catch (error) {
			log.error({ error: error instanceof Error ? error.message : String(error) }, "router: correlation failure callback threw");
		}
		return correlationFailure;
	};

	const pair = (observation: Observation, call: PendingCall): void => {
		observation.piId = call.info.piId;
		call.info.modelId = observation.modelId;
		if (!call.settled) aliases.set(observation.modelId, call.info.piId);
		const index = unmatchedCalls.indexOf(call);
		if (index >= 0) unmatchedCalls.splice(index, 1);
		log.debug(
			{ batchId: observation.batchId, modelId: observation.modelId, piId: call.info.piId, name: observation.name },
			"router: joined driver observation to stable pi resolver",
		);
	};

	const tryPair = (): void => {
		if (correlationFailure || stopped) return;
		for (const batch of batchOrder) {
			for (const observation of batch.observations) {
				if (observation.piId) continue;
				const call = unmatchedCalls.find((candidate) =>
					candidate.key === `${observation.name}\u0000${observation.argsKey}` &&
					(candidate.declaredModelId === undefined || candidate.declaredModelId === observation.modelId));
				if (call) pair(observation, call);
			}
		}
	};

	const reconcileSealed = (batch: ObservationBatch): CorrelationFailure | undefined => {
		if (!batch.sealed || correlationFailure) return correlationFailure;
		// Do not treat unmatched calls as overflow for this batch yet. claude-p
		// publishes every assistant batch together at terminal result, so a shim
		// call already present when batch N seals may belong to batch N+1, whose
		// observations have not reached the router callback yet. Exact canonical
		// pairing continues as observations arrive; finalizeToolUseCorrelation()
		// fails closed once every driver batch has been published.
		tryPair();
		return undefined;
	};

	const handleNewToolCall = async (req: ToolCallRequest): Promise<ToolCallResponse> => {
		if (stopped || correlationFailure) {
			return { kind: "tools/call:response", id: req.id, content: [{ type: "text", text: correlationFailure?.message ?? TEARDOWN_DRAIN_TEXT }], isError: true };
		}
		const name = normalizeToolName(req.name);
		if (!name || !isRecord(req.arguments)) {
			const failure = fail(`invalid bridged shim call ${JSON.stringify(req.name)}`);
			return { kind: "tools/call:response", id: req.id, content: [{ type: "text", text: failure.message }], isError: true };
		}

		const piId = mintPiId();
		if (parked.has(piId) || pendingResolvers.has(piId)) {
			const failure = fail(`router minted duplicate active pi resolver id ${piId}`);
			return { kind: "tools/call:response", id: req.id, content: [{ type: "text", text: failure.message }], isError: true };
		}
		const argsKey = canonicalizeArgs(req.arguments);
		const declaredModelId = typeof req.modelToolUseId === "string" && req.modelToolUseId.length > 0
			? req.modelToolUseId
			: undefined;
		const info: ParkedCallInfo = { piId, shimRequestId: req.id, name, arguments: req.arguments, argsKey, modelId: declaredModelId };
		const call: PendingCall = { info, key: `${name}\u0000${argsKey}`, declaredModelId, settled: false };
		parked.set(piId, info);
		unmatchedCalls.push(call);
		if (declaredModelId) aliases.set(declaredModelId, piId);

		const resultPromise = new Promise<ToolResult>((resolve) => {
			const early = pendingResults.get(piId);
			if (early) {
				pendingResults.delete(piId);
				resolve(early);
				return;
			}
			pendingResolvers.set(piId, resolve);
		});

		everRoutedToolCall = true;
		try {
			opts.onPark?.(info);
		} catch (error) {
			log.error({ error: error instanceof Error ? error.message : String(error), piId }, "router: onPark callback threw");
		}

		tryPair();

		const result = await resultPromise;
		call.settled = true;
		parked.delete(piId);
		pendingResolvers.delete(piId);
		// Unpaired metadata stays until observation reconciliation. This preserves
		// observation/result order independence without retaining a live resolver.
		if (info.modelId) aliases.delete(info.modelId);
		return { kind: "tools/call:response", id: req.id, content: result.content, isError: result.isError };
	};

	const onToolCall = (req: ToolCallRequest): Promise<ToolCallResponse> => {
		const signature = `${req.name}\u0000${canonicalizeArgs(isRecord(req.arguments) ? req.arguments : {})}\u0000${req.modelToolUseId ?? ""}`;
		const prior = requestsByShimId.get(req.id);
		if (prior) {
			if (prior.signature !== signature) {
				const failure = fail(`duplicate shim request id ${req.id} carried different call metadata`);
				return Promise.resolve({ kind: "tools/call:response", id: req.id, content: [{ type: "text", text: failure.message }], isError: true });
			}
			return prior.promise;
		}
		const promise = handleNewToolCall(req);
		requestsByShimId.set(req.id, { signature, promise });
		return promise;
	};

	const onCaptureStash = (req: CaptureStashRequest): void => {
		if (captureStash !== undefined) {
			log.warn({ id: req.id }, "router: capture-stash arrived after a stash already exists; keeping first");
			return;
		}
		captureStash = req.arguments;
		captureValidationFailure = undefined;
		log.debug({ id: req.id }, "router: capture args stashed");
	};

	const onCaptureValidationFailed = (req: CaptureValidationFailedRequest): void => {
		if (captureStash !== undefined) return;
		if (!Number.isSafeInteger(req.attempt) || req.attempt < 1) {
			log.warn({ attempt: req.attempt }, "router: ignored invalid capture validation attempt");
			return;
		}
		if (captureValidationFailure && req.attempt <= captureValidationFailure.attempt) return;
		captureValidationFailure = {
			attempt: req.attempt,
			field: safeEvidence(req.field),
			message: safeEvidence(req.message),
		};
	};

	const ipc: IpcServer = createIpcServer(socketPath, { onToolCall, onCaptureStash, onCaptureValidationFailed });

	return {
		socketPath,
		get toolDefs() { return toolDefs; },
		pendingResolvers,
		pendingResults,
		start: () => ipc.listen(),
		declareTools: (defs) => { toolDefs = defs.slice(); },
		deliver: (piToolResultId, result) => {
			if (stopped || correlationFailure) return;
			const resolve = pendingResolvers.get(piToolResultId);
			if (resolve) {
				pendingResolvers.delete(piToolResultId);
				resolve(result);
				return;
			}
			pendingResults.set(piToolResultId, result);
			log.debug({ piToolResultId }, "router: deliver before park — stashed in pendingResults");
		},
		observeToolUse: (input) => {
			if (stopped || correlationFailure) return "failed";
			if (!input.name.startsWith(BRIDGED_PREFIX)) return "ignored";
			const name = normalizeToolName(input.name);
			// Claude Code may emit a model-authored mcp__custom-tools__* call for
			// a name absent from tools/list, then resolve it internally as "Unknown
			// tool" without ever calling the shim. Such records are not bridge-call
			// observations and must not inflate D32's expected-call count.
			if (name && toolDefs.length > 0 && !toolDefs.some((definition) => normalizeToolName(definition.name) === name)) {
				log.debug({ batchId: input.batchId, modelId: input.modelId, name }, "router: ignored unadvertised custom tool observation");
				return "ignored";
			}
			if (!name || typeof input.modelId !== "string" || input.modelId.length === 0 || !isRecord(input.arguments)) {
				fail("invalid bridged driver tool observation");
				return "failed";
			}
			const argsKey = canonicalizeArgs(input.arguments);
			const prior = observationsByModelId.get(input.modelId);
			if (prior) {
				if (prior.name === name && prior.argsKey === argsKey && prior.batchId === input.batchId) return "duplicate";
				fail(`duplicate model tool id ${input.modelId} carried different observation metadata`);
				return "failed";
			}
			let batch = batches.get(input.batchId);
			if (!batch) {
				batch = { id: input.batchId, observations: [], sealed: false };
				batches.set(input.batchId, batch);
				batchOrder.push(batch);
			}
			if (batch.sealed) {
				fail(`driver observation arrived after batch ${input.batchId} was sealed`);
				return "failed";
			}
			const observation: Observation = { batchId: input.batchId, modelId: input.modelId, name, arguments: input.arguments, argsKey };
			batch.observations.push(observation);
			observationsByModelId.set(input.modelId, observation);
			tryPair();
			return correlationFailure ? "failed" : "accepted";
		},
		sealToolUseBatch: (batchId) => {
			if (stopped || correlationFailure) return correlationFailure;
			const batch = batches.get(batchId);
			if (!batch) return undefined; // batch contained only ignored observations
			if (batch.sealed) return reconcileSealed(batch);
			batch.sealed = true;
			tryPair();
			return reconcileSealed(batch);
		},
		finalizeToolUseCorrelation: () => {
			if (correlationFailure) return correlationFailure;
			for (const batch of batchOrder) {
				if (!batch.sealed || batch.observations.some((observation) => !observation.piId)) {
					return fail(`tool-call correlation ended with unmatched observations in batch ${batch.id}`);
				}
			}
			if (unmatchedCalls.length > 0) return fail("tool-call correlation ended with unmatched shim calls");
			return undefined;
		},
		getCorrelationFailure: () => correlationFailure,
		resolvePiIdForModelId: (modelId) => aliases.get(modelId),
		getCaptureStash: () => captureStash,
		getCaptureValidationFailure: () => captureValidationFailure,
		listParkedCalls: () => Array.from(parked.values()),
		get everRoutedToolCall() { return everRoutedToolCall; },
		stop: () => {
			if (stopPromise) return stopPromise;
			stopped = true;
			drain(TEARDOWN_DRAIN_TEXT);
			aliases.clear();
			unmatchedCalls.length = 0;
			stopPromise = ipc.close();
			return stopPromise;
		},
	};
}
