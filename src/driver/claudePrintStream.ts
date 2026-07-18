// Direct `claude -p --output-format stream-json --include-partial-messages`
// decoder. Unlike the interactive parser, this protocol fails closed: stdout is
// an exact, byte-bounded NDJSON contract and unknown semantic records are errors.

import type {
	DriverStreamEvent,
	DriverStreamUsage,
	ExitInfo,
} from "./stream.js";

export const CLAUDE_PRINT_MAX_NDJSON_LINE_BYTES = 8 * 1024 * 1024;
export const CLAUDE_PRINT_MAX_DIAGNOSTIC_BYTES = 16 * 1024;

const BRIDGED_TOOL_PREFIX = "mcp__custom-tools__";
const OBSERVATIONAL_SYSTEM_SUBTYPES = new Set(["status", "api_retry"]);
const STREAM_EVENT_TYPES = new Set([
	"message_start",
	"content_block_start",
	"content_block_delta",
	"content_block_stop",
	"message_delta",
	"message_stop",
]);
const MESSAGE_STOP_REASONS = new Set(["end_turn", "tool_use", "max_tokens", "stop_sequence"]);
const ERROR_RESULT_SUBTYPES = new Set([
	"error_during_execution",
	"error_max_turns",
	"error_max_budget_usd",
	"error_max_structured_output_retries",
]);

export type ClaudePrintTerminalOutcome =
	| {
		kind: "result";
		subtype: "success";
		sessionId: string;
		result: string;
		totalCostUsd: number;
		stopReason: "end_turn";
		invalidateResumeHint: false;
	}
	| {
		kind: "error";
		subtype: string;
		sessionId: string;
		errorMessage: string;
		totalCostUsd: number;
		invalidateResumeHint: true;
	}
	| {
		kind: "aborted";
		sessionId: string | null;
		invalidateResumeHint: false;
	}
	| {
		kind: "protocol-error";
		errorMessage: string;
		invalidateResumeHint: true;
	};

export interface ClaudePrintStreamLogger {
	debug?(...args: unknown[]): void;
	warn?(...args: unknown[]): void;
}

export interface ClaudePrintStreamParserOptions {
	onEvent: (event: DriverStreamEvent) => void;
	logger?: ClaudePrintStreamLogger;
	onTurnAccepted?: () => void;
	/** Process adapter closes stdin only after one structurally valid terminal record. */
	onTerminalRecord?: () => void;
}

export interface ClaudePrintEndOfStreamArgs {
	aborted?: boolean;
	exitInfo?: ExitInfo;
	stderrTail?: string;
}

type PartialBlock = {
	type: "text" | "thinking" | "tool_use";
	name?: string;
	id?: string;
};

type ParsedTerminal = {
	subtype: "success" | string;
	isError: boolean;
	result: string;
	stopReason: unknown;
	terminalReason: unknown;
	sessionId: string;
	totalCostUsd: number;
	billing: DriverStreamUsage;
};

const NOOP_LOGGER: ClaudePrintStreamLogger = {};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function mapUsage(raw: unknown, source: string): DriverStreamUsage {
	if (!isRecord(raw)) throw new Error(`${source} usage must be an object`);
	if (!finiteNonNegative(raw.input_tokens) || !finiteNonNegative(raw.output_tokens)) {
		throw new Error(`${source} usage requires non-negative input_tokens and output_tokens`);
	}
	const optional = (key: "cache_read_input_tokens" | "cache_creation_input_tokens"): number => {
		const value = raw[key];
		if (value === undefined) return 0;
		if (!finiteNonNegative(value)) throw new Error(`${source} usage.${key} must be non-negative`);
		return value;
	};
	const input = raw.input_tokens;
	const output = raw.output_tokens;
	const cacheRead = optional("cache_read_input_tokens");
	const cacheWrite = optional("cache_creation_input_tokens");
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
	};
}

function utf8Excerpt(bytes: Buffer): string {
	const capped = bytes.subarray(0, CLAUDE_PRINT_MAX_DIAGNOSTIC_BYTES);
	return new TextDecoder("utf-8", { fatal: false }).decode(capped);
}

function exitDescription(exitInfo?: ExitInfo, stderrTail?: string): string {
	const details: string[] = [];
	if (exitInfo?.code !== undefined && exitInfo.code !== null) details.push(`exit code ${exitInfo.code}`);
	if (exitInfo?.signal !== undefined && exitInfo.signal !== null) details.push(`signal ${String(exitInfo.signal)}`);
	const tail = stderrTail?.trim();
	if (tail) details.push(`last stderr: ${tail}`);
	return details.length > 0 ? `; ${details.join("; ")}` : "";
}

/**
 * One parser instance owns one direct subprocess stdout stream. `write()` works
 * in raw bytes and never retains more than one 8 MiB pending line. Terminal
 * delivery is deferred until `endOfStream()` so duplicate/missing results cannot
 * produce a false successful completion.
 */
export class ClaudePrintStreamParser {
	private readonly onEvent: (event: DriverStreamEvent) => void;
	private readonly logger: ClaudePrintStreamLogger;
	private readonly onTurnAccepted?: () => void;
	private readonly onTerminalRecord?: () => void;
	private pending = Buffer.alloc(0);
	private ended = false;
	private frozen = false;
	private localAbort = false;
	private emittedError = false;
	private outcome: ClaudePrintTerminalOutcome | null = null;
	private sessionId: string | null = null;
	private initSeen = false;
	private terminalCount = 0;
	private terminal: ParsedTerminal | null = null;
	private messageOpen = false;
	private messageDeltaSeen = false;
	private blocks = new Map<number, PartialBlock>();
	private sawPartialMessage = false;
	private lastAssistantUsage: DriverStreamUsage | null = null;
	private observedToolIds = new Set<string>();
	private _turnAccepted = false;

	constructor(options: ClaudePrintStreamParserOptions) {
		this.onEvent = options.onEvent;
		this.logger = options.logger ?? NOOP_LOGGER;
		this.onTurnAccepted = options.onTurnAccepted;
		this.onTerminalRecord = options.onTerminalRecord;
	}

	get pendingBufferBytes(): number {
		return this.pending.length;
	}

	get turnAccepted(): boolean {
		return this._turnAccepted;
	}

	/** Freeze content/protocol mutation immediately when caller initiates abort. */
	markLocalAbort(): void {
		if (this.ended || this.localAbort) return;
		this.localAbort = true;
		this.frozen = true;
		this.pending = Buffer.alloc(0);
	}

	write(chunk: string | Buffer): void {
		if (this.ended || this.frozen || this.localAbort) return;
		const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
		let start = 0;
		while (start < bytes.length && !this.frozen) {
			const newline = bytes.indexOf(0x0a, start);
			const end = newline === -1 ? bytes.length : newline;
			const segmentLength = end - start;
			if (this.pending.length + segmentLength > CLAUDE_PRINT_MAX_NDJSON_LINE_BYTES) {
				const excerptParts: Buffer[] = [];
				let excerptBytes = 0;
				for (const part of [this.pending, bytes.subarray(start, end)]) {
					if (excerptBytes >= CLAUDE_PRINT_MAX_DIAGNOSTIC_BYTES) break;
					const slice = part.subarray(0, CLAUDE_PRINT_MAX_DIAGNOSTIC_BYTES - excerptBytes);
					excerptParts.push(slice);
					excerptBytes += slice.length;
				}
				const excerpt = utf8Excerpt(Buffer.concat(excerptParts, excerptBytes));
				this.pending = Buffer.alloc(0);
				this.fail(`claude-print NDJSON line exceeds 8 MiB byte limit; excerpt: ${excerpt}`);
				return;
			}
			if (segmentLength > 0) {
				const segment = bytes.subarray(start, end);
				this.pending = this.pending.length === 0
					? Buffer.from(segment)
					: Buffer.concat([this.pending, segment], this.pending.length + segment.length);
			}
			if (newline === -1) return;
			const complete = this.pending;
			this.pending = Buffer.alloc(0);
			this.handleLine(complete);
			start = newline + 1;
		}
	}

	endOfStream(args: ClaudePrintEndOfStreamArgs = {}): ClaudePrintTerminalOutcome {
		if (this.ended) return this.outcome ?? this.protocolOutcome("claude-print parser ended without an outcome");
		if (args.aborted) this.markLocalAbort();
		if (this.localAbort) {
			this.ended = true;
			this.outcome = { kind: "aborted", sessionId: this.sessionId, invalidateResumeHint: false };
			return this.outcome;
		}

		if (!this.frozen && this.pending.length > 0) {
			const tail = this.pending;
			this.pending = Buffer.alloc(0);
			this.handleLine(tail);
		}
		if (this.outcome?.kind === "protocol-error") {
			this.ended = true;
			return this.outcome;
		}
		if (this.messageOpen || this.blocks.size > 0) {
			this.fail("claude-print stdout ended with an incomplete top-level partial block lifecycle");
		} else if (this.terminalCount !== 1 || this.terminal === null) {
			this.fail(`claude-print stdout closed before exactly one terminal result${exitDescription(args.exitInfo, args.stderrTail)}`);
		} else if (!this.initSeen || this.sessionId === null) {
			this.fail("claude-print terminal result arrived without system/init session metadata");
		} else if (this.terminal.subtype === "success" && !this.sawPartialMessage) {
			this.fail("claude-print success is missing required top-level partial message lifecycle");
		} else if (this.terminal.subtype === "success" && this.lastAssistantUsage === null) {
			this.fail("claude-print success is missing final top-level assistant usage");
		}
		if (this.frozen) {
			this.ended = true;
			return this.outcome!;
		}

		const terminal = this.terminal!;
		if (terminal.subtype === "success") {
			const context = this.lastAssistantUsage!;
			for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
				if (terminal.billing[key] < context[key]) {
					this.fail(`claude-print terminal cumulative usage.${key} conflicts with final assistant usage`);
					this.ended = true;
					return this.outcome!;
				}
			}
			this.onEvent({ kind: "usage", usage: context, billing: terminal.billing });
			this.onEvent({ kind: "done", reason: "result" });
			this.outcome = {
				kind: "result",
				subtype: "success",
				sessionId: terminal.sessionId,
				result: terminal.result,
				totalCostUsd: terminal.totalCostUsd,
				stopReason: "end_turn",
				invalidateResumeHint: false,
			};
		} else {
			const errorMessage = `claude-print terminal ${terminal.subtype}: ${terminal.result}`;
			this.onEvent({ kind: "error", errorMessage });
			this.outcome = {
				kind: "error",
				subtype: terminal.subtype,
				sessionId: terminal.sessionId,
				errorMessage: terminal.result,
				totalCostUsd: terminal.totalCostUsd,
				invalidateResumeHint: true,
			};
		}
		this.ended = true;
		return this.outcome;
	}

	private handleLine(raw: Buffer): void {
		if (this.frozen || this.localAbort) return;
		let line = raw;
		if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
		if (line.length === 0 || /^\s*$/.test(line.toString("utf8"))) return;
		let value: unknown;
		try {
			value = JSON.parse(line.toString("utf8"));
		} catch {
			this.fail(`claude-print malformed NDJSON; excerpt: ${utf8Excerpt(line)}`);
			return;
		}
		if (!isRecord(value)) {
			this.fail("claude-print NDJSON record must be a JSON object");
			return;
		}
		this.handleRecord(value);
	}

	private handleRecord(record: Record<string, unknown>): void {
		const type = record.type;
		if (typeof type !== "string") {
			this.fail("claude-print record requires string type");
			return;
		}
		if (this.terminalCount > 0 && type !== "result") {
			this.fail(`claude-print ${type} record arrived after terminal result`);
			return;
		}
		switch (type) {
			case "system":
				this.handleSystem(record);
				return;
			case "rate_limit_event":
				this.logObservation(type);
				return;
			case "stream_event":
				this.handleStreamEvent(record);
				return;
			case "assistant":
				this.handleAssistant(record);
				return;
			case "result":
				this.handleResult(record);
				return;
			default:
				this.fail(`claude-print unknown top-level type "${type}"`);
		}
	}

	private handleSystem(record: Record<string, unknown>): void {
		const subtype = record.subtype;
		if (subtype === "init") {
			if (this.initSeen) {
				this.fail("claude-print received more than one system/init record");
				return;
			}
			const sessionId = record.session_id;
			if (typeof sessionId !== "string" || sessionId.length === 0) {
				this.fail("claude-print system/init requires session_id");
				return;
			}
			this.initSeen = true;
			this.sessionId = sessionId;
			return;
		}
		if (typeof subtype === "string" && OBSERVATIONAL_SYSTEM_SUBTYPES.has(subtype)) {
			this.logObservation(`system/${subtype}`);
			return;
		}
		this.fail(`claude-print unknown system subtype "${String(subtype)}"`);
	}

	private handleStreamEvent(record: Record<string, unknown>): void {
		if (record.parent_tool_use_id !== null) {
			if (typeof record.parent_tool_use_id !== "string") {
				this.fail("claude-print stream_event parent_tool_use_id must be null or string");
				return;
			}
			this.logObservation("nested stream_event");
			return;
		}
		if (!this.requireSession(record)) return;
		const event = record.event;
		if (!isRecord(event) || typeof event.type !== "string") {
			this.fail("claude-print stream_event requires event.type");
			return;
		}
		if (!STREAM_EVENT_TYPES.has(event.type)) {
			this.fail(`claude-print unknown stream_event subtype "${event.type}"`);
			return;
		}
		switch (event.type) {
			case "message_start":
				this.handleMessageStart(event);
				return;
			case "content_block_start":
				this.handleBlockStart(event);
				return;
			case "content_block_delta":
				this.handleBlockDelta(event);
				return;
			case "content_block_stop":
				this.handleBlockStop(event);
				return;
			case "message_delta":
				this.handleMessageDelta(event);
				return;
			case "message_stop":
				this.handleMessageStop();
		}
	}

	private handleMessageStart(event: Record<string, unknown>): void {
		if (this.messageOpen || this.blocks.size > 0) {
			this.fail("claude-print message_start arrived before prior message_stop");
			return;
		}
		if (!isRecord(event.message)) {
			this.fail("claude-print message_start requires message object");
			return;
		}
		this.messageOpen = true;
		this.messageDeltaSeen = false;
		this.sawPartialMessage = true;
		if (!this._turnAccepted) {
			this._turnAccepted = true;
			this.onTurnAccepted?.();
		}
	}

	private handleBlockStart(event: Record<string, unknown>): void {
		if (!this.messageOpen) {
			this.fail("claude-print content_block_start outside message lifecycle");
			return;
		}
		const index = this.requireIndex(event.index, "content_block_start");
		if (index === null) return;
		if (this.blocks.has(index)) {
			this.fail(`claude-print duplicate content_block_start index ${index}`);
			return;
		}
		const content = event.content_block;
		if (!isRecord(content) || !["text", "thinking", "tool_use"].includes(String(content.type))) {
			this.fail(`claude-print unknown content_block_start type "${String(isRecord(content) ? content.type : undefined)}"`);
			return;
		}
		const type = content.type as PartialBlock["type"];
		const block: PartialBlock = { type };
		if (type === "tool_use") {
			if (typeof content.id !== "string" || typeof content.name !== "string" || !isRecord(content.input)) {
				this.fail("claude-print tool_use block requires id, name, and object input");
				return;
			}
			block.id = content.id;
			block.name = content.name;
		} else {
			const field = type === "text" ? "text" : "thinking";
			if (typeof content[field] !== "string") {
				this.fail(`claude-print ${type} block requires string ${field}`);
				return;
			}
			this.onEvent({ kind: "content-block-start", blockType: type });
			if (content[field].length > 0) {
				this.onEvent(type === "text"
					? { kind: "text-delta", text: content[field] }
					: { kind: "thinking-delta", text: content[field] });
			}
		}
		this.blocks.set(index, block);
	}

	private handleBlockDelta(event: Record<string, unknown>): void {
		const index = this.requireIndex(event.index, "content_block_delta");
		if (index === null) return;
		const block = this.blocks.get(index);
		if (!this.messageOpen || !block) {
			this.fail(`claude-print content_block_delta index ${index} without active block`);
			return;
		}
		const delta = event.delta;
		if (!isRecord(delta) || typeof delta.type !== "string") {
			this.fail("claude-print content_block_delta requires delta.type");
			return;
		}
		if (delta.type === "text_delta") {
			if (block.type !== "text" || typeof delta.text !== "string") return this.deltaMismatch(block.type, delta.type);
			this.onEvent({ kind: "text-delta", text: delta.text });
			return;
		}
		if (delta.type === "thinking_delta") {
			if (block.type !== "thinking" || typeof delta.thinking !== "string") return this.deltaMismatch(block.type, delta.type);
			this.onEvent({ kind: "thinking-delta", text: delta.thinking });
			return;
		}
		if (delta.type === "signature_delta") {
			if (block.type !== "thinking" || typeof delta.signature !== "string") return this.deltaMismatch(block.type, delta.type);
			return;
		}
		if (delta.type === "input_json_delta") {
			if (block.type !== "tool_use" || typeof delta.partial_json !== "string") return this.deltaMismatch(block.type, delta.type);
			return;
		}
		this.fail(`claude-print unknown content_block_delta subtype "${delta.type}"`);
	}

	private deltaMismatch(blockType: string, deltaType: string): void {
		this.fail(`claude-print ${deltaType} does not match active ${blockType} block`);
	}

	private handleBlockStop(event: Record<string, unknown>): void {
		const index = this.requireIndex(event.index, "content_block_stop");
		if (index === null) return;
		const block = this.blocks.get(index);
		if (!this.messageOpen || !block) {
			this.fail(`claude-print content_block_stop index ${index} without active block`);
			return;
		}
		this.blocks.delete(index);
		if (block.type !== "tool_use") this.onEvent({ kind: "content-block-end", blockType: block.type });
	}

	private handleMessageDelta(event: Record<string, unknown>): void {
		if (!this.messageOpen || this.blocks.size > 0 || this.messageDeltaSeen) {
			this.fail("claude-print message_delta violates partial message lifecycle");
			return;
		}
		if (!isRecord(event.delta) || !MESSAGE_STOP_REASONS.has(String(event.delta.stop_reason))) {
			this.fail(`claude-print unknown message_delta stop_reason "${String(isRecord(event.delta) ? event.delta.stop_reason : undefined)}"`);
			return;
		}
		this.messageDeltaSeen = true;
	}

	private handleMessageStop(): void {
		if (!this.messageOpen || this.blocks.size > 0 || !this.messageDeltaSeen) {
			this.fail("claude-print message_stop violates partial message lifecycle");
			return;
		}
		this.messageOpen = false;
		this.messageDeltaSeen = false;
	}

	private handleAssistant(record: Record<string, unknown>): void {
		if (record.parent_tool_use_id !== null) {
			if (typeof record.parent_tool_use_id !== "string") {
				this.fail("claude-print assistant parent_tool_use_id must be null or string");
				return;
			}
			this.logObservation("nested assistant");
			return;
		}
		if (!this.requireSession(record)) return;
		const message = record.message;
		if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
			this.fail("claude-print assistant requires assistant message content array");
			return;
		}
		try {
			this.lastAssistantUsage = mapUsage(message.usage, "final assistant");
		} catch (error) {
			this.fail((error as Error).message);
			return;
		}
		if (!(message.stop_reason === null || message.stop_reason === undefined || MESSAGE_STOP_REASONS.has(String(message.stop_reason)))) {
			this.fail(`claude-print assistant has unknown stop_reason "${String(message.stop_reason)}"`);
			return;
		}
		for (const value of message.content) {
			if (!isRecord(value) || !["text", "thinking", "tool_use"].includes(String(value.type))) {
				this.fail(`claude-print unknown assistant content type "${String(isRecord(value) ? value.type : undefined)}"`);
				return;
			}
			if (value.type === "text") {
				if (typeof value.text !== "string") return this.fail("claude-print complete text block requires text");
				continue;
			}
			if (value.type === "thinking") {
				if (typeof value.thinking !== "string") return this.fail("claude-print complete thinking block requires thinking");
				continue;
			}
			if (typeof value.id !== "string" || typeof value.name !== "string" || !isRecord(value.input)) {
				this.fail("claude-print complete tool_use requires id, name, and object input");
				return;
			}
			if (!value.name.startsWith(BRIDGED_TOOL_PREFIX)) {
				this.logObservation(`dropped tool_use ${value.name}`);
				continue;
			}
			if (this.observedToolIds.has(value.id)) continue;
			this.observedToolIds.add(value.id);
			this.onEvent({ kind: "tool-use", toolUseId: value.id, name: value.name, arguments: value.input });
		}
	}

	private handleResult(record: Record<string, unknown>): void {
		this.terminalCount++;
		if (this.terminalCount > 1) {
			this.fail("claude-print received more than one terminal result");
			return;
		}
		if (!this.requireSession(record)) return;
		const subtype = record.subtype;
		if (!(subtype === "success" || (typeof subtype === "string" && ERROR_RESULT_SUBTYPES.has(subtype)))) {
			this.fail(`claude-print unknown result subtype "${String(subtype)}"`);
			return;
		}
		if (typeof record.result !== "string") {
			this.fail(`claude-print ${subtype} result requires string result`);
			return;
		}
		if (!finiteNonNegative(record.total_cost_usd)) {
			this.fail(`claude-print ${subtype} result requires non-negative total_cost_usd`);
			return;
		}
		let billing: DriverStreamUsage;
		try {
			billing = mapUsage(record.usage, "terminal result");
		} catch (error) {
			this.fail((error as Error).message);
			return;
		}
		if (subtype === "success") {
			if (record.is_error !== false) return this.fail("claude-print success result requires is_error false");
			if (record.stop_reason !== "end_turn") return this.fail("claude-print success result requires stop_reason end_turn");
			if (record.terminal_reason !== undefined && record.terminal_reason !== "completed") {
				return this.fail("claude-print success result requires terminal_reason completed");
			}
		} else {
			if (record.is_error !== true) return this.fail(`claude-print ${subtype} result requires is_error true`);
			if (!(record.stop_reason === null || record.stop_reason === undefined)) {
				return this.fail(`claude-print ${subtype} result has incompatible stop_reason`);
			}
		}
		this.terminal = {
			subtype,
			isError: subtype !== "success",
			result: record.result,
			stopReason: record.stop_reason,
			terminalReason: record.terminal_reason,
			sessionId: record.session_id as string,
			totalCostUsd: record.total_cost_usd,
			billing,
		};
		this.onTerminalRecord?.();
	}

	private requireSession(record: Record<string, unknown>): boolean {
		if (!this.initSeen || this.sessionId === null) {
			this.fail(`claude-print ${String(record.type)} arrived before system/init`);
			return false;
		}
		if (record.session_id !== this.sessionId) {
			this.fail(`claude-print session_id mismatch: expected ${this.sessionId}, got ${String(record.session_id)}`);
			return false;
		}
		return true;
	}

	private requireIndex(value: unknown, source: string): number | null {
		if (!Number.isSafeInteger(value) || (value as number) < 0) {
			this.fail(`claude-print ${source} requires non-negative integer index`);
			return null;
		}
		return value as number;
	}

	private logObservation(type: string): void {
		this.logger.debug?.({ event: "claudePrint.stream.observation", type }, "claude-print observational record ignored");
	}

	private protocolOutcome(errorMessage: string): ClaudePrintTerminalOutcome {
		return { kind: "protocol-error", errorMessage, invalidateResumeHint: true };
	}

	private fail(errorMessage: string): void {
		if (this.localAbort || this.outcome?.kind === "protocol-error") return;
		this.frozen = true;
		this.pending = Buffer.alloc(0);
		this.outcome = this.protocolOutcome(errorMessage);
		this.logger.warn?.({ event: "claudePrint.stream.protocolError", errorMessage }, errorMessage);
		if (!this.emittedError) {
			this.emittedError = true;
			this.onEvent({ kind: "error", errorMessage });
		}
	}
}
