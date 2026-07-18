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
	// Direct partial streams expose explicit content-block lifecycle. Interactive
	// claude-p continues emitting deltas only; index.ts infers boundaries there.
	| { kind: "content-block-start"; blockType: "text" | "thinking" }
	| { kind: "content-block-end"; blockType: "text" | "thinking" }
	| { kind: "text-delta"; text: string }
	| { kind: "thinking-delta"; text: string }
	// Observational only (D32): carries the model's `toolu_…` id + name + full
	// argument object for streaming/UX. Routing/correlation is the shim+router's.
	| { kind: "tool-use"; toolUseId: string; name: string; arguments: unknown }
	// `usage` = CONTEXT-window usage (the final API call's input-side tokens — the
	// real window occupancy). `billing` = CUMULATIVE turn usage (Claude Code's
	// `result.usage`, the exact sum across every round) for cost. They differ for
	// multi-round turns; index.ts reports context tokens to pi but derives cost
	// from billing.
	| { kind: "usage"; usage: DriverStreamUsage; billing: DriverStreamUsage }
	| { kind: "done"; reason: "result" } // terminal `result` line seen
	| { kind: "error"; errorMessage: string };

/**
 * Warm-resume stale-turn DIAGNOSTIC (detection-only — 2026-06-04). Emitted once at
 * turn-end on a `--resume` turn so we can confirm/measure the stale-result race
 * (production: a resume turn delivered the PRIOR turn's byte-identical result because
 * claude-p latched the REPLAYED terminal state before the live turn ran). NONE of
 * these change delivery; they are purely observed and logged. Signals, in order of
 * robustness:
 *   - numTurns: claude-p's own `result.num_turns` (advances on every real turn; a
 *     stale turn leaves it frozen at the prior value).
 *   - livePromptAfterBoundary: a real user-PROMPT line appeared AFTER the final
 *     `last-prompt` replay marker (i.e. the live turn's prompt was actually processed).
 *     This is the primary stale discriminator — self-contained, no text/count heuristic.
 *   - livePromptTextMatched: a prompt line matched the prompt the bridge sent (cross-check).
 */
export interface ResumeDiag {
	numTurns: number | null;
	promptLineCount: number;
	sawReplayBoundary: boolean;
	livePromptAfterBoundary: boolean;
	livePromptTextMatched: boolean;
	lastReplayedPrompt: string | null;
	terminatedBy: "result" | "endOfStream";
	/** Primary heuristic: replay seen but no live prompt followed the final boundary. */
	staleSuspected: boolean;
}

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

// ── Warm-resume stale-turn diagnostic helpers (detection-only) ───────────────

/** Extract a user line's prompt text (string content, or joined text blocks). */
function extractPromptText(rec: Record<string, unknown>): string | null {
	const message = rec.message;
	if (!message || typeof message !== "object") return null;
	const content = (message as Record<string, unknown>).content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const parts: string[] = [];
		for (const b of content) {
			if (b && typeof b === "object" && (b as Record<string, unknown>).type === "text") {
				const t = (b as Record<string, unknown>).text;
				if (typeof t === "string") parts.push(t);
			}
		}
		return parts.length ? parts.join("") : null;
	}
	return null;
}

/** Whitespace-normalized comparison: does this user line carry the prompt we sent? */
function promptTextMatches(rec: Record<string, unknown>, expected: string): boolean {
	const got = extractPromptText(rec);
	if (got === null) return false;
	const a = got.replace(/\s+/g, " ").trim();
	const b = expected.replace(/\s+/g, " ").trim();
	if (a.length === 0 || b.length === 0) return false;
	return a === b || a.includes(b) || b.includes(a);
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
	/**
	 * Warm-resume RE-ECHO suppression (G5). On a `--resume` turn, claude-p 0.1.0
	 * drains the FULL replayed transcript to stdout before the live turn, so without
	 * this every prior assistant text/tool block would be re-emitted as a new event,
	 * corrupting pi's turn output (the whole transcript prepended to the new turn).
	 *
	 * When `true`, the parser emits ONLY the LIVE turn: the segment of content
	 * AFTER the LAST real user-PROMPT line, up to the terminal `result`. It does so
	 * by buffering content events and DISCARDING the buffer each time a new real
	 * user-prompt line arrives — so whatever survives at the terminal `result` is
	 * exactly the final (live) turn's content, which is then flushed in order,
	 * followed by usage + done.
	 *
	 * A "real user-PROMPT line" is a `type:"user"` line whose `message.content` is a
	 * string OR an array carrying NO `tool_result` blocks. A tool_result `user` line
	 * (content = array of `tool_result` blocks) is NOT a prompt boundary — it does
	 * not discard the buffer — so a live turn's tool rounds are preserved intact.
	 *
	 * This "emit only the last segment" rule is robust where a prompt-count or
	 * prompt-text boundary is not: it is immune to (a) the resumed transcript
	 * persisting a different number of prior prompts than pi's history (e.g. after
	 * an aborted turn), and (b) the SAME prompt text recurring across turns (a count
	 * or first-match-text boundary would mis-fire; "last segment" cannot).
	 *
	 * Default `false`/undefined → suppression DISABLED: events emit live as they are
	 * parsed (byte-for-byte identical to pre-G5 behavior). Fresh turns and all
	 * existing callers are unaffected. Only warm-resume turns should pass `true`.
	 */
	suppressResumeReplay?: boolean;
	/**
	 * The prompt text the bridge sent for THIS turn (warm-resume only). Used purely
	 * for the stale-turn diagnostic (ResumeDiag.livePromptTextMatched) — does a
	 * user-prompt line in the stream match what we sent? Never affects delivery.
	 */
	livePromptText?: string;
	/**
	 * Detection-only sink for the warm-resume stale-turn diagnostic (see ResumeDiag).
	 * Called at most once, at turn-end, only when suppressResumeReplay is true. Never
	 * affects parsed events or delivery — the driver wires this to logging + a raw
	 * stream dump when staleSuspected.
	 */
	onResumeDiag?: (diag: ResumeDiag) => void;
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
	/**
	 * The last N lines of the child's captured stderr (driver-diagnostics).
	 * WHERE present, appended to the premature-termination error message so an
	 * upstream cause (PromptNotAccepted / StopTimeout / Anthropic stream error) is
	 * visible to pi without opening the per-spawn debug file. Ignored on a clean
	 * `result` or an aborted exit (no error event is emitted there).
	 */
	stderrTail?: string;
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

	/**
	 * Warm-resume RE-ECHO suppression (G5). When true, content events are buffered
	 * and the buffer is DISCARDED on each new real user-prompt line, so only the
	 * LIVE turn (the final segment after the last prompt) survives to be flushed at
	 * the terminal `result`. False → events emit live (fresh / default behavior).
	 */
	private readonly suppressResumeReplay: boolean;
	/**
	 * Buffer of live-turn content events held back during warm-resume suppression.
	 * Reset to [] whenever a new real user-prompt line arrives (discarding any
	 * replayed prior-turn content), then flushed in order at the terminal `result`.
	 */
	private liveTurnBuffer: DriverStreamEvent[] = [];

	// Per-call usage of the LAST assistant message that carried real input-side
	// tokens. claude-p's terminal `result.usage` is the CUMULATIVE sum across all
	// rounds (wrong for a context-window indicator); this final per-call usage is
	// the true window occupancy. Captured in handleAssistant, emitted at `result`.
	private lastAssistantUsage: DriverStreamUsage | null = null;

	// Per-message-id usage of the LIVE turn's rounds — the BILLING (cost) basis.
	// claude-p's terminal `result.usage` sums EVERY assistant line it streams, and
	// that stream is doubly polluted: (a) it RE-EMITS each message ~2-3× (same
	// message id repeated), and (b) on `--resume` it REPLAYS the full prior
	// transcript before the live turn. So `result.usage` over-counts billing by
	// the duplicates AND the whole replayed history — observed as `billTotal`
	// growing monotonically with session length and ≈2× the deduped total, which
	// inflated session cost. Keying per message id collapses the re-emits; clearing
	// on each user-prompt boundary (handleUser) discards replayed prior turns, so
	// at `result` only the live turn's distinct rounds remain. Summed → true turn
	// billing. (Context usage stays lastAssistantUsage — the last single per-call —
	// so it was always correct; only billing was wrong.)
	private liveBillingById = new Map<string, DriverStreamUsage>();
	private liveBillingNoIdSeq = 0;

	// ── Warm-resume stale-turn diagnostic (detection-only; see ResumeDiag) ──────
	private readonly livePromptText?: string;
	private readonly onResumeDiag?: (diag: ResumeDiag) => void;
	private diagNumTurns: number | null = null;
	private diagPromptLineCount = 0;
	private diagSawReplayBoundary = false;
	/** Set false on each `last-prompt`, true on each real prompt → true iff a prompt followed the FINAL boundary. */
	private diagPromptAfterBoundary = false;
	private diagLivePromptTextMatched = false;
	private diagLastReplayedPrompt: string | null = null;
	private diagEmitted = false;

	constructor(opts: ClaudePStreamParserOptions) {
		this.onEvent = opts.onEvent;
		this.logger = opts.logger ?? NOOP_LOGGER;
		this.suppressResumeReplay = opts.suppressResumeReplay === true;
		this.livePromptText = opts.livePromptText;
		this.onResumeDiag = opts.onResumeDiag;
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

		// Warm-resume suppression: if the stream ends with no terminal `result`
		// (premature exit OR abort), flush whatever live-turn content was buffered
		// so the aborted partial is the LIVE turn's text — NOT lost, and NOT the
		// replayed prefix. (On a clean turn the result handler already flushed.)
		if (this.suppressResumeReplay && !this.resultSeen && this.liveTurnBuffer.length > 0) {
			const buffered = this.liveTurnBuffer;
			this.liveTurnBuffer = [];
			for (const ev of buffered) this.onEvent(ev);
		}

		this.ended = true;

		// Stale-turn diagnostic for resume turns that ended without a clean `result`
		// (premature exit or abort) — emit once (no-op if handleResult already did).
		this.emitResumeDiag("endOfStream");

		if (this.resultSeen) return; // clean turn-end already emitted
		if (args.aborted) return; // intentional abort — not an error

		this.onEvent({
			kind: "error",
			errorMessage: this.prematureMessage(args.exitInfo, args.stderrTail),
		});
	}

	/** Length (chars) of the unparsed trailing partial line at this moment.
	 *  Surfaced in the driver's in-flight state dump (driver-diagnostics). */
	get pendingBufferLength(): number {
		return this.buffer.length;
	}

	// ── internals ────────────────────────────────────────────────────────────

	private prematureMessage(exitInfo?: ExitInfo, stderrTail?: string): string {
		const parts = ["claude-p stdout closed before a terminal `result` line (premature termination)"];
		if (exitInfo) {
			if (exitInfo.code !== undefined && exitInfo.code !== null) {
				parts.push(`exit code ${exitInfo.code}`);
			}
			if (exitInfo.signal !== undefined && exitInfo.signal !== null) {
				parts.push(`signal ${String(exitInfo.signal)}`);
			}
		}
		const base = parts.join("; ");
		const tail = stderrTail?.trim();
		return tail ? `${base} — last stderr:\n${tail}` : base;
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

		// Warm-resume replay boundary marker. On `--resume`, claude-p emits one
		// `last-prompt` after each REPLAYED turn; the LIVE prompt is the user line
		// that follows the FINAL one. Capture it for the stale-turn diagnostic and
		// skip the drift warning it would otherwise produce (it is expected, not drift).
		if (type === "last-prompt") {
			const lp = rec.lastPrompt;
			if (typeof lp === "string") this.diagLastReplayedPrompt = lp;
			this.diagSawReplayBoundary = true;
			this.diagPromptAfterBoundary = false; // awaiting a prompt AFTER this boundary
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
				// `user` lines carry either a real user PROMPT or tool_result blocks.
				// Classify: a real prompt advances the warm-resume suppression gate
				// (and on the live prompt, releases it); a tool_result line does not.
				// The held-call round-trip is owned by the shim+router (D32), so we
				// emit NO event for tool_result here — it is purely observational and
				// would duplicate the shim's authoritative view. Surfacing nothing
				// keeps the turn in flight without side effects.
				this.handleUser(rec);
				return;
			case "result":
				this.handleResult(rec);
				return;
		}
	}

	/**
	 * Emit a content event. With warm-resume suppression OFF (fresh/default), this
	 * passes straight through (live, byte-for-byte unchanged). With suppression ON,
	 * the event is BUFFERED instead — it will be flushed only if it is still in the
	 * buffer at the terminal `result` (i.e. it belongs to the live turn, the final
	 * segment after the last user-prompt line). Replayed prior-turn content is
	 * discarded when the next user-prompt line resets the buffer (see handleUser).
	 */
	private emit(event: DriverStreamEvent): void {
		if (!this.suppressResumeReplay) {
			this.onEvent(event);
			return;
		}
		this.liveTurnBuffer.push(event);
	}

	/**
	 * Classify a `user` line. With warm-resume suppression ON, a real user-PROMPT
	 * line marks a (possibly replayed) turn boundary: DISCARD the buffer so any
	 * content accumulated for a prior replayed turn is dropped, and start fresh for
	 * the segment that follows. Whatever segment is in the buffer at the terminal
	 * `result` is the LIVE turn. A tool_result `user` line (array of tool_result
	 * blocks) is NOT a prompt boundary — it must NOT discard the live turn's content
	 * accumulated so far (the live turn may include tool rounds).
	 *
	 * We emit NO event for either kind here: the held-call round-trip is owned by
	 * the shim+router (D32), so tool_result is purely observational and would
	 * duplicate the shim's authoritative view.
	 */
	private handleUser(rec: Record<string, unknown>): void {
		if (!this.suppressResumeReplay) return; // fresh/default: nothing to track
		if (!this.isUserPromptLine(rec)) return; // tool_result line — not a boundary
		// Stale-turn diagnostic (detection-only): count real prompts, mark that a
		// prompt followed the most recent replay boundary, and cross-check against the
		// prompt the bridge sent. None of this affects delivery.
		this.diagPromptLineCount++;
		this.diagPromptAfterBoundary = true;
		if (this.livePromptText && promptTextMatches(rec, this.livePromptText)) {
			this.diagLivePromptTextMatched = true;
		}
		// New prompt boundary → discard any buffered (replayed) prior-turn content
		// AND its billing rounds, so only the live turn's usage survives to `result`.
		this.liveTurnBuffer = [];
		this.liveBillingById.clear();
		this.liveBillingNoIdSeq = 0;
	}

	/**
	 * A real user PROMPT line vs a tool_result line. claude-p renders a prompt's
	 * `message.content` as a STRING, and a tool_result's as an ARRAY of blocks
	 * whose `type` is `tool_result`. We treat content as a prompt unless it is an
	 * array containing at least one `tool_result` block (robust: an array prompt
	 * with text/image blocks but no tool_result still counts as a prompt).
	 */
	private isUserPromptLine(rec: Record<string, unknown>): boolean {
		const message = rec.message;
		if (message === null || typeof message !== "object") {
			// No message object: treat as a non-prompt (do not advance the gate).
			return false;
		}
		const content = (message as Record<string, unknown>).content;
		if (typeof content === "string") return true;
		if (Array.isArray(content)) {
			for (const block of content) {
				if (block && typeof block === "object" && (block as Record<string, unknown>).type === "tool_result") {
					return false; // a tool_result block → this is a tool-result line
				}
			}
			return true; // array with no tool_result blocks → a prompt
		}
		return false;
	}

	private handleAssistant(rec: Record<string, unknown>): void {
		const message = rec.message;
		if (message === null || typeof message !== "object") return;
		// Capture this API call's usage as the running "context size". Each
		// assistant message carries its own per-call usage; the LAST one with real
		// input-side tokens is the final call = the true context-window occupancy.
		// Guard against message_start / partial frames that report all-zero usage.
		const perCall = this.mapUsage((message as Record<string, unknown>).usage);
		if (perCall.input + perCall.cacheRead + perCall.cacheWrite > 0) {
			this.lastAssistantUsage = perCall;
			// Record this round's usage for billing, keyed by message id so a
			// re-emitted duplicate of the SAME message (claude-p echoes each line
			// 2-3×) collapses to one entry rather than N-counting. A missing id
			// (never observed) falls back to a unique key so the round still counts.
			const mid = (message as Record<string, unknown>).id;
			const key = typeof mid === "string" && mid.length > 0 ? mid : `__noid:${this.liveBillingNoIdSeq++}`;
			this.liveBillingById.set(key, perCall);
		}
		const content = (message as Record<string, unknown>).content;
		if (!Array.isArray(content)) return;

		for (const block of content) {
			if (block === null || typeof block !== "object") continue;
			const b = block as Record<string, unknown>;
			switch (b.type) {
				case "text": {
					// Faithful passthrough: claude-p is a model completion endpoint. Whatever
					// the model returned — including a tool call it (wrongly) emitted as TEXT
					// rather than as a structured call — is part of the response and reaches
					// the user/terminal/history verbatim. The bridge does NOT rewrite model
					// output; content-based scrubbing can't tell a real leak from a legitimate
					// discussion of the tool-call format (they're identical), so it must not try.
					const text = b.text;
					if (typeof text === "string" && text.length > 0) {
						this.emit({ kind: "text-delta", text });
					}
					break;
				}
				case "thinking": {
					const thinking = b.thinking;
					if (typeof thinking === "string" && thinking.length > 0) {
						this.emit({ kind: "thinking-delta", text: thinking });
					}
					break;
				}
				case "tool_use": {
					const name = b.name;
					// Drop built-in / native tools (WaitForMcpServers, etc.): only
					// the bridged mcp__* namespace is surfaced (D32 observational).
					if (!isBridgedToolName(name)) break;
					const id = typeof b.id === "string" ? b.id : "";
					this.emit({
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
		// Terminal marker (claude-p emits NO stop_reason; `result` itself ends the
		// turn). There is exactly one `result` per spawn and it follows the live
		// turn. With warm-resume suppression ON, FLUSH the buffered live-turn content
		// now (everything accumulated since the last user-prompt line — i.e. the live
		// turn's text/thinking/tool_use in order), then emit usage + done directly so
		// the terminal pair is NEVER buffered/suppressed.
		if (this.suppressResumeReplay && this.liveTurnBuffer.length > 0) {
			const buffered = this.liveTurnBuffer;
			this.liveTurnBuffer = [];
			for (const ev of buffered) this.onEvent(ev);
		}
		// `result.usage` is the CUMULATIVE turn usage (exact sum over all rounds) →
		// use it for cost (billing). For the context-window indicator emit the LAST
		// per-call usage (real window occupancy); fall back to billing if no
		// assistant usage was seen (e.g. a zero-round turn).
		// BILLING is the live turn's distinct rounds (deduped, replay discarded) —
		// NOT claude-p's `result.usage`, which over-counts re-emits + replayed
		// history. Fall back to `result.usage` only if no live round carried usage
		// (e.g. a zero-round turn), where the two coincide.
		const billing = this.sumLiveBilling() ?? this.mapUsage(rec.usage);
		const usage = this.lastAssistantUsage ?? billing;
		this.onEvent({ kind: "usage", usage, billing });
		this.resultSeen = true;
		this.onEvent({ kind: "done", reason: "result" });
		// Stale-turn diagnostic: claude-p's own turn counter (advances on every real
		// turn; frozen on a stale replay). Emit the diagnostic once, at turn-end.
		const nt = rec.num_turns;
		if (typeof nt === "number") this.diagNumTurns = nt;
		this.emitResumeDiag("result");
	}

	/**
	 * Emit the warm-resume stale-turn diagnostic exactly once at turn-end (resume
	 * turns only). Detection-only: never alters parsed events. `staleSuspected` is the
	 * primary discriminator — claude-p replayed (≥1 `last-prompt`) but NO real prompt
	 * followed the final boundary, i.e. the live turn never ran and the terminal
	 * `result` reflects the replayed state (the production bug). The driver wires
	 * onResumeDiag to logging + a raw-stream dump when this fires.
	 */
	private emitResumeDiag(terminatedBy: "result" | "endOfStream"): void {
		if (!this.suppressResumeReplay || this.diagEmitted || !this.onResumeDiag) return;
		this.diagEmitted = true;
		this.onResumeDiag({
			numTurns: this.diagNumTurns,
			promptLineCount: this.diagPromptLineCount,
			sawReplayBoundary: this.diagSawReplayBoundary,
			livePromptAfterBoundary: this.diagPromptAfterBoundary,
			livePromptTextMatched: this.diagLivePromptTextMatched,
			lastReplayedPrompt: this.diagLastReplayedPrompt,
			terminatedBy,
			staleSuspected: this.diagSawReplayBoundary && !this.diagPromptAfterBoundary,
		});
	}

	/**
	 * Sum the live turn's per-round usage (already deduped by message id, with
	 * replayed prior turns discarded at each prompt boundary) into the turn's
	 * billing total. Returns null when no live round carried real usage so the
	 * caller can fall back to `result.usage`.
	 */
	private sumLiveBilling(): DriverStreamUsage | null {
		if (this.liveBillingById.size === 0) return null;
		let input = 0, output = 0, cacheRead = 0, cacheWrite = 0;
		for (const u of this.liveBillingById.values()) {
			input += u.input;
			output += u.output;
			cacheRead += u.cacheRead;
			cacheWrite += u.cacheWrite;
		}
		return { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite };
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
