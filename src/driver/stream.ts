// src/driver/stream.ts
//
// claude-p stdout stream parser (T1.4).
//
// Consumes claude-p's `--output-format stream-json --verbose` STDOUT — the raw
// interactive transcript, newline-delimited JSON — incrementally, and emits a
// driver-INTERNAL structured event stream (DriverStreamEvent). This type is NOT
// pi-ai's event type; index.ts (T1.9) translates it into pi-facing events. The
// decoupling is deliberate (design D27): the bridge reads nothing under
// `~/.claude/`, it parses what claude-p flushes live on stdout.
//
// Design anchors:
//   - D27: event source is claude-p stream-json stdout; turn-end is the
//          terminal `result` line (claude-p emits NO `stop_reason`). The
//          interactive schema is noisier than `claude -p`: leading
//          mode/permission-mode/file-history-snapshot/attachment/ai-title
//          lines, user content as a string, a built-in WaitForMcpServers
//          tool_use, trailing system/stop_hook_summary + system/turn_duration,
//          and a `result` envelope with `usage` but no `stop_reason`.
//   - D32: tool_use events are OBSERVATIONAL (UX correlation). Authoritative
//          routing of held calls to pi's toolResult is owned by the MCP shim +
//          router, NOT by this parser. A tool_use block does NOT end the turn;
//          the turn stays in flight (the MCP shim holds the call open).
//
// Testability: no subprocess, no claude-p spawning, no pi-ai imports. Bytes are
// fed via write(); the subprocess lifecycle is signaled via endOfStream(). The
// driver (T1.3) pipes child.stdout into write() and calls endOfStream() on the
// child's 'exit'/'close'.

// ---------------------------------------------------------------------------
// Public event union (driver-internal; index.ts translates to pi-ai events)
// ---------------------------------------------------------------------------

export type DriverStreamUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
};

export type DriverStreamEvent =
	| { kind: "text-delta"; text: string }
	| { kind: "thinking-delta"; text: string }
	// Observational only (D32): carries the model's `toolu_…` id + name + full
	// argument object for streaming/UX. Routing/correlation is the shim+router's.
	| { kind: "tool-use"; toolUseId: string; name: string; arguments: unknown }
	| { kind: "usage"; usage: DriverStreamUsage }
	| { kind: "done"; reason: "result" } // terminal `result` line seen
	| { kind: "error"; errorMessage: string };

// ---------------------------------------------------------------------------
// Schema constants
// ---------------------------------------------------------------------------

/** Top-level `type` values that carry content we map to events. */
const CONTENT_TYPES: ReadonlySet<string> = new Set(["user", "assistant", "result"]);

/**
 * Top-level `type` values that are claude-p interactive noise — filtered to no
 * event, no warning. `system` is conditional: only the known stop_hook_summary
 * / turn_duration subtypes are noise (handled below), other system subtypes
 * fall through to drift detection.
 */
const NOISE_TYPES: ReadonlySet<string> = new Set([
	"mode",
	"permission-mode",
	"file-history-snapshot",
	"attachment",
	"ai-title",
]);

/** Known-noise `system` subtypes (trailing lifecycle markers). */
const NOISE_SYSTEM_SUBTYPES: ReadonlySet<string> = new Set([
	"stop_hook_summary",
	"turn_duration",
]);

/**
 * Built-in tool names that must never surface as a `tool-use` event. We surface
 * ONLY tools in the `mcp__…__…` namespace (the bridged custom tools); any other
 * tool_use name — `WaitForMcpServers` or any native tool the disallow set let
 * through — is dropped silently (it is claude-p / agent-loop internal, not a pi
 * tool execution).
 */
function isBridgedToolName(name: unknown): name is string {
	return typeof name === "string" && name.startsWith("mcp__");
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

/** Minimal pino-compatible logger surface this parser needs. */
export interface StreamLogger {
	warn(...args: unknown[]): void;
}

const NOOP_LOGGER: StreamLogger = { warn() {} };

// ---------------------------------------------------------------------------
// Parser options
// ---------------------------------------------------------------------------

export interface ClaudePStreamParserOptions {
	/** Sink for parsed events. */
	onEvent: (event: DriverStreamEvent) => void;
	/** Optional logger for warn-level drift/malformed notices. Defaults to no-op. */
	logger?: StreamLogger;
}

/** Information about how the claude-p subprocess ended. */
export interface ExitInfo {
	code?: number | null;
	signal?: NodeJS.Signals | number | null;
}

export interface EndOfStreamArgs {
	/** True if the driver aborted the turn (SIGINT/SIGTERM). Suppresses error. */
	aborted: boolean;
	/** Exit code / signal where available — included in the error message. */
	exitInfo?: ExitInfo;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const MAX_PREFIX = 200; // chars of a bad line to name in the warn log

export class ClaudePStreamParser {
	private readonly onEvent: (event: DriverStreamEvent) => void;
	private readonly logger: StreamLogger;

	/** Partial-line buffer: bytes read before a newline boundary. */
	private buffer = "";
	/** True once a terminal `result` line has been seen. */
	private resultSeen = false;
	/** True once the stream has been finalized (endOfStream called). */
	private ended = false;

	constructor(opts: ClaudePStreamParserOptions) {
		this.onEvent = opts.onEvent;
		this.logger = opts.logger ?? NOOP_LOGGER;
	}

	/**
	 * Feed a chunk of claude-p stdout. Buffers any trailing partial line until a
	 * newline arrives; never attempts to parse partial JSON. Complete lines are
	 * parsed in order. Idempotent after endOfStream() (ignored).
	 */
	write(chunk: string | Buffer): void {
		if (this.ended) return;
		this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");

		let nl: number;
		while ((nl = this.buffer.indexOf("\n")) !== -1) {
			const rawLine = this.buffer.slice(0, nl);
			this.buffer = this.buffer.slice(nl + 1);
			this.handleLine(rawLine);
		}
	}

	/**
	 * Signal that the claude-p subprocess exited / stdout closed. If a complete
	 * line was left unbuffered (no trailing newline), it is processed first. If
	 * no terminal `result` was seen AND the turn was not aborted, emits an
	 * `error` event referencing the premature termination. Aborted exits and
	 * exits after a clean `result` emit nothing here.
	 */
	endOfStream(args: EndOfStreamArgs): void {
		if (this.ended) return;

		// Flush a final newline-less complete line if claude-p didn't terminate it.
		const tail = this.buffer.trim();
		this.buffer = "";
		if (tail.length > 0) {
			this.handleLine(tail);
		}

		this.ended = true;

		if (this.resultSeen) return; // clean turn-end already emitted
		if (args.aborted) return; // intentional abort — not an error

		this.onEvent({
			kind: "error",
			errorMessage: this.prematureMessage(args.exitInfo),
		});
	}

	// ── internals ────────────────────────────────────────────────────────────

	private prematureMessage(exitInfo?: ExitInfo): string {
		const parts = ["claude-p stdout closed before a terminal `result` line (premature termination)"];
		if (exitInfo) {
			if (exitInfo.code !== undefined && exitInfo.code !== null) {
				parts.push(`exit code ${exitInfo.code}`);
			}
			if (exitInfo.signal !== undefined && exitInfo.signal !== null) {
				parts.push(`signal ${String(exitInfo.signal)}`);
			}
		}
		return parts.join("; ");
	}

	private handleLine(rawLine: string): void {
		const trimmed = rawLine.trim();
		if (trimmed.length === 0) return; // blank line — nothing to parse

		let obj: unknown;
		try {
			obj = JSON.parse(trimmed);
		} catch {
			// Malformed JSON: warn naming the prefix, skip, DO NOT end the turn.
			this.logger.warn(
				{ event: "claudeP.stream.malformedLine", prefix: trimmed.slice(0, MAX_PREFIX) },
				"claude-p stdout: skipping malformed (non-JSON) line",
			);
			return;
		}

		if (obj === null || typeof obj !== "object") {
			this.logger.warn(
				{ event: "claudeP.stream.nonObjectLine", prefix: trimmed.slice(0, MAX_PREFIX) },
				"claude-p stdout: skipping non-object JSON line",
			);
			return;
		}

		const rec = obj as Record<string, unknown>;
		const type = rec.type;

		if (typeof type !== "string") {
			this.logger.warn(
				{ event: "claudeP.stream.missingType", prefix: trimmed.slice(0, MAX_PREFIX) },
				"claude-p stdout: line has no string `type` field",
			);
			return;
		}

		// Known-noise filtering (no event, no warning).
		if (NOISE_TYPES.has(type)) return;
		if (type === "system") {
			const subtype = rec.subtype;
			if (typeof subtype === "string" && NOISE_SYSTEM_SUBTYPES.has(subtype)) return;
			// Unknown system subtype → drift.
			this.logger.warn(
				{ event: "claudeP.stream.unknownSystemSubtype", subtype: rec.subtype },
				"claude-p stdout: unknown system subtype (drift) — skipping",
			);
			return;
		}

		if (!CONTENT_TYPES.has(type)) {
			// Valid JSON, unknown top-level type → drift detection warn, skip, continue.
			this.logger.warn(
				{ event: "claudeP.stream.unknownType", unknownType: type },
				`claude-p stdout: unknown top-level type "${type}" (drift) — skipping`,
			);
			return;
		}

		switch (type) {
			case "assistant":
				this.handleAssistant(rec);
				return;
			case "user":
				// `user` lines carry tool_result blocks (and the initial prompt
				// echo). The held-call round-trip is owned by the shim+router
				// (D32), so we emit NO event for tool_result here — it is purely
				// observational and would duplicate the shim's authoritative view.
				// Surfacing nothing keeps the turn in flight without side effects.
				return;
			case "result":
				this.handleResult(rec);
				return;
		}
	}

	private handleAssistant(rec: Record<string, unknown>): void {
		const message = rec.message;
		if (message === null || typeof message !== "object") return;
		const content = (message as Record<string, unknown>).content;
		if (!Array.isArray(content)) return;

		for (const block of content) {
			if (block === null || typeof block !== "object") continue;
			const b = block as Record<string, unknown>;
			switch (b.type) {
				case "text": {
					const text = b.text;
					if (typeof text === "string" && text.length > 0) {
						this.onEvent({ kind: "text-delta", text });
					}
					break;
				}
				case "thinking": {
					const thinking = b.thinking;
					if (typeof thinking === "string" && thinking.length > 0) {
						this.onEvent({ kind: "thinking-delta", text: thinking });
					}
					break;
				}
				case "tool_use": {
					const name = b.name;
					// Drop built-in / native tools (WaitForMcpServers, etc.): only
					// the bridged mcp__* namespace is surfaced (D32 observational).
					if (!isBridgedToolName(name)) break;
					const id = typeof b.id === "string" ? b.id : "";
					this.onEvent({
						kind: "tool-use",
						toolUseId: id,
						name,
						arguments: b.input,
					});
					break;
				}
				default:
					// Unknown block types within a recognized assistant line are
					// ignored (forward-compatible); not turn-ending.
					break;
			}
		}
	}

	private handleResult(rec: Record<string, unknown>): void {
		// Terminal marker (claude-p emits NO stop_reason; `result` itself ends the turn).
		const usage = this.mapUsage(rec.usage);
		this.onEvent({ kind: "usage", usage });
		this.resultSeen = true;
		this.onEvent({ kind: "done", reason: "result" });
	}

	private mapUsage(raw: unknown): DriverStreamUsage {
		const u = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
		const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
		const input = num(u.input_tokens);
		const output = num(u.output_tokens);
		const cacheRead = num(u.cache_read_input_tokens);
		const cacheWrite = num(u.cache_creation_input_tokens);
		return {
			input,
			output,
			cacheRead,
			cacheWrite,
			totalTokens: input + output + cacheRead + cacheWrite,
		};
	}
}
