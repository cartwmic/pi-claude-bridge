// src/driver/transcript.ts
//
// Transcript JSONL tailer + event emitter (D4 + Phase 0 T0.3 schema).
//
// Architecture:
//   1. Caller provides the deterministically-computed transcript path
//      (per D18; bridge computes from --session-id + realpath(cwd)).
//   2. On start(): establish a parent-directory `fs.watch` watching for the
//      file to appear (plus a polling fallback for macOS reliability).
//   3. When the file appears, open it for read-tail. As new bytes arrive,
//      split on newline boundaries, JSON.parse each complete line, emit
//      a structured event keyed by the entry's `type` field.
//   4. Stop is signaled externally via stopSettle(); the tailer enters a
//      bounded settle window (default 250ms or until `system/stop_hook_summary`
//      observed) during which it continues to read, then closes.
//
// Event taxonomy (consumed by bridge stream layer):
//   - "text-delta"      assistant content block, type:"text"
//   - "tool-use"        assistant content block, type:"tool_use"
//   - "thinking-delta"  assistant content block, type:"thinking" | "redacted_thinking"
//   - "usage"           assistant.message.usage payload (or attached at turn-end)
//   - "warn"            unknown JSONL type or malformed line
//   - "error"           transcript missing/unreadable
//   - "done"            settle window closed
//
// NOT a terminal emulator and NOT an interpreter — just a JSONL stream
// projection. The bridge's stream layer consumes events and maps them onto
// pi-ai's StreamEvent shape.

import { existsSync, FSWatcher, readFileSync, statSync, watch } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { EventEmitter } from "node:events";

// --- Type definitions ------------------------------------------------------

export interface UsagePayload {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Ephemeral 1h cache (separate from 5m, per Phase 0 T0.3). */
	cacheCreate1h?: number;
	cacheCreate5m?: number;
}

export type TranscriptEvent =
	| { kind: "text-delta"; text: string; sourceUuid: string; timestamp?: string }
	| { kind: "tool-use"; toolUseId: string; name: string; input: unknown; sourceUuid: string; timestamp?: string }
	| { kind: "thinking-delta"; text: string; signature?: string; redacted: boolean; sourceUuid: string; timestamp?: string }
	| { kind: "usage"; usage: UsagePayload; model?: string; stopReason?: string }
	| { kind: "warn"; reason: string; lineOffset?: number; preview?: string }
	| { kind: "error"; errorMessage: string }
	| { kind: "done"; reason: "stop-settled" | "aborted" };

export interface TranscriptTailerOptions {
	/** Absolute path the transcript will land at. Computed by caller per D18. */
	transcriptPath: string;
	/** Settle window after stopSettle(). Default 250ms. */
	settleMs?: number;
	/** Poll interval as fallback to fs.watch. Default 100ms. */
	pollIntervalMs?: number;
	/** Max time to wait for file to appear before erroring. Default 30000ms. */
	creationTimeoutMs?: number;
	/** D22 warm-resume: skip pre-existing transcript content. When true, on
	 * file open the read offset is initialized to the current file size, so
	 * only NEW lines appended after this point fire events. Required when
	 * spawning `claude --resume <sid>` because the transcript JSONL already
	 * contains the prior conversation; replaying it would double-emit. */
	startFromEOF?: boolean;
	// Injectables for tests
	now?: () => number;
	setTimer?: (cb: () => void, ms: number) => unknown;
	clearTimer?: (h: unknown) => void;
}

/** Top-level transcript `type` values we recognize (Phase 0 T0.3). */
const KNOWN_TOP_LEVEL_TYPES = new Set([
	"permission-mode",
	"file-history-snapshot",
	"attachment",
	"user",
	"assistant",
	"system",
	"result", // legacy; not observed in interactive but accepted forward-compat
]);

type TailerState =
	| "idle"
	| "waiting-for-file"
	| "tailing"
	| "settling"
	| "closed"
	| "errored";

// --- Implementation --------------------------------------------------------

/**
 * Tails a transcript JSONL file and emits structured events on a Node
 * EventEmitter. Listen via:
 *
 *   tailer.on("event", (e: TranscriptEvent) => { ... });
 *
 * One emitter per turn / per PTY spawn. Re-use across spawns is undefined.
 */
export class TranscriptTailer extends EventEmitter {
	private state: TailerState = "idle";
	private dirWatcher: FSWatcher | undefined;
	private pollTimer: unknown;
	private settleTimer: unknown;
	private creationTimer: unknown;
	private handle: FileHandle | undefined;
	private readOffset = 0;
	private lineBuffer = "";
	private readonly settleMs: number;
	private readonly pollIntervalMs: number;
	private readonly creationTimeoutMs: number;
	private readonly startFromEOF: boolean;
	private readonly setTimerFn: NonNullable<TranscriptTailerOptions["setTimer"]>;
	private readonly clearTimerFn: NonNullable<TranscriptTailerOptions["clearTimer"]>;
	private terminalStopHookSummarySeen = false;
	private readPending = false;
	private readInFlight = false;
	private readQueuedAgain = false;

	constructor(private readonly opts: TranscriptTailerOptions) {
		super();
		this.settleMs = opts.settleMs ?? 250;
		this.pollIntervalMs = opts.pollIntervalMs ?? 100;
		// D27: Opus with large pi-typed-as-user-message context can take >30s
	// before flushing its first transcript line. Default bumped to 90s.
	this.creationTimeoutMs = opts.creationTimeoutMs ?? 90_000;
		this.startFromEOF = opts.startFromEOF ?? false;
		this.setTimerFn = opts.setTimer ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
		this.clearTimerFn = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
	}

	/**
	 * Start watching for the file to appear and tail it once it does.
	 *
	 * Returns synchronously; events arrive asynchronously via emitter.
	 */
	start(): void {
		if (this.state !== "idle") return;
		this.state = "waiting-for-file";

		// If the file already exists (e.g. warm-resume), open immediately.
		if (existsSync(this.opts.transcriptPath)) {
			this.openAndStartTailing();
			return;
		}

		// Watch the parent directory for creation. macOS fs.watch is racy on
		// nested mkdir; pair with a poll loop.
		try {
			const parent = dirname(this.opts.transcriptPath);
			// The parent directory may also not exist yet — watch its parent.
			const watchTarget = existsSync(parent) ? parent : dirname(parent);
			this.dirWatcher = watch(watchTarget, { recursive: true }, () => {
				if (existsSync(this.opts.transcriptPath)) {
					this.openAndStartTailing();
				}
			});
		} catch {
			// fall through to poll-only
		}
		this.pollTimer = this.setTimerFn(() => this.pollForCreation(), this.pollIntervalMs);

		this.creationTimer = this.setTimerFn(() => {
			if (this.state === "waiting-for-file") {
				this.emitError(`transcript file did not appear within ${this.creationTimeoutMs}ms: ${this.opts.transcriptPath}`);
			}
		}, this.creationTimeoutMs);
	}

	/**
	 * Called by the driver when the `Stop` hook fires. Enters a bounded
	 * settle window: continue reading new lines for `settleMs` more, then
	 * close. Window may close early if `system/stop_hook_summary` line is
	 * observed.
	 */
	stopSettle(): void {
		if (this.state === "closed" || this.state === "errored") return;
		if (this.state === "settling") return;
		this.state = "settling";
		// Drain whatever is currently readable, then arm settle timer.
		this.scheduleRead();
		this.settleTimer = this.setTimerFn(() => this.finalizeAfterSettle(), this.settleMs);
	}

	/**
	 * Abort path: tear down immediately, emit `done` with reason aborted.
	 * Subsequent events ignored.
	 */
	abort(): void {
		if (this.state === "closed" || this.state === "errored") return;
		this.state = "closed";
		this.cleanupResources();
		this.emit("event", { kind: "done", reason: "aborted" } satisfies TranscriptEvent);
	}

	/** Inspector. */
	getState(): TailerState {
		return this.state;
	}

	// --- Internal -----------------------------------------------------------

	private pollForCreation(): void {
		this.pollTimer = undefined;
		if (this.state !== "waiting-for-file") return;
		if (existsSync(this.opts.transcriptPath)) {
			this.openAndStartTailing();
		} else {
			this.pollTimer = this.setTimerFn(() => this.pollForCreation(), this.pollIntervalMs);
		}
	}

	private async openAndStartTailing(): Promise<void> {
		if (this.state !== "waiting-for-file") return;
		this.state = "tailing";
		if (this.creationTimer !== undefined) {
			this.clearTimerFn(this.creationTimer);
			this.creationTimer = undefined;
		}
		if (this.dirWatcher) {
			this.dirWatcher.close();
			this.dirWatcher = undefined;
		}
		if (this.pollTimer !== undefined) {
			this.clearTimerFn(this.pollTimer);
			this.pollTimer = undefined;
		}
		try {
			this.handle = await open(this.opts.transcriptPath, "r");
		} catch (err) {
			this.emitError(`failed to open transcript: ${(err as Error).message}`);
			return;
		}
		// D22 warm-resume: skip prior conversation by seeking to current EOF.
		if (this.startFromEOF) {
			try {
				const st = statSync(this.opts.transcriptPath);
				this.readOffset = st.size;
			} catch {
				// Ignore; readOffset stays at 0.
			}
		}
		// Establish a watcher on the file itself for incremental reads.
		try {
			this.dirWatcher = watch(this.opts.transcriptPath, () => this.scheduleRead());
		} catch {
			// Fall back to polling.
		}
		this.pollTimer = this.setTimerFn(() => this.pollForGrowth(), this.pollIntervalMs);
		this.scheduleRead();
	}

	private pollForGrowth(): void {
		this.pollTimer = undefined;
		if (this.state !== "tailing" && this.state !== "settling") return;
		this.scheduleRead();
		this.pollTimer = this.setTimerFn(() => this.pollForGrowth(), this.pollIntervalMs);
	}

	private scheduleRead(): void {
		if (this.readInFlight) {
			// A read is mid-await. Mark that another pass is needed when it completes.
			this.readQueuedAgain = true;
			return;
		}
		if (this.readPending) return;
		this.readPending = true;
		// Defer to next microtask to coalesce many notifications.
		queueMicrotask(() => {
			this.readPending = false;
			this.readInFlight = true;
			this.doRead()
				.catch((err) => {
					this.emitError(`read error: ${(err as Error).message}`);
				})
				.finally(() => {
					this.readInFlight = false;
					if (this.readQueuedAgain) {
						this.readQueuedAgain = false;
						this.scheduleRead();
					}
				});
		});
	}

	private async doRead(): Promise<void> {
		if (!this.handle) return;
		if (this.state !== "tailing" && this.state !== "settling") return;
		let st;
		try {
			st = statSync(this.opts.transcriptPath);
		} catch {
			return;
		}
		if (st.size <= this.readOffset) return;
		const toRead = st.size - this.readOffset;
		const buf = Buffer.allocUnsafe(toRead);
		const { bytesRead } = await this.handle.read(buf, 0, toRead, this.readOffset);
		if (bytesRead <= 0) return;
		this.readOffset += bytesRead;
		this.processBytes(buf.slice(0, bytesRead).toString("utf8"));
	}

	private processBytes(s: string): void {
		this.lineBuffer += s;
		let newlineIdx;
		while ((newlineIdx = this.lineBuffer.indexOf("\n")) !== -1) {
			const line = this.lineBuffer.slice(0, newlineIdx);
			this.lineBuffer = this.lineBuffer.slice(newlineIdx + 1);
			if (!line.trim()) continue;
			this.processLine(line);
		}
	}

	private processLine(line: string): void {
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			this.emit("event", {
				kind: "warn",
				reason: "malformed JSONL line",
				preview: line.slice(0, 200),
			} satisfies TranscriptEvent);
			return;
		}
		const t = entry?.type;
		if (!t || typeof t !== "string") {
			this.emit("event", {
				kind: "warn",
				reason: "JSONL line missing top-level type",
				preview: line.slice(0, 200),
			} satisfies TranscriptEvent);
			return;
		}

		// Drift-detection: unknown top-level types
		if (!KNOWN_TOP_LEVEL_TYPES.has(t)) {
			this.emit("event", {
				kind: "warn",
				reason: `unknown transcript entry type: ${t}`,
				preview: line.slice(0, 200),
			} satisfies TranscriptEvent);
			return;
		}

		// Terminal-marker detection (Phase 0 T0.3): system/stop_hook_summary
		if (t === "system" && entry?.subtype === "stop_hook_summary") {
			this.terminalStopHookSummarySeen = true;
			// If we're already settling, close immediately.
			if (this.state === "settling") {
				this.finalizeAfterSettle();
			}
			return;
		}

		// Assistant entry: project to text-delta / tool-use / thinking-delta / usage
		if (t === "assistant") {
			this.projectAssistant(entry);
			return;
		}

		if (t === "result") {
			// Legacy/forward-compat: extract usage if present
			this.maybeEmitUsage(entry);
			return;
		}

		// Other known types (user, attachment, file-history-snapshot, permission-mode)
		// are not projected to bridge events in v1.
	}

	private projectAssistant(entry: any): void {
		const msg = entry?.message;
		if (!msg) return;
		const sourceUuid = entry.uuid;
		const timestamp = entry.timestamp;
		const blocks = Array.isArray(msg.content) ? msg.content : [];
		for (const b of blocks) {
			if (!b || typeof b !== "object") continue;
			switch (b.type) {
				case "text":
					if (typeof b.text === "string") {
						this.emit("event", {
							kind: "text-delta",
							text: b.text,
							sourceUuid,
							timestamp,
						} satisfies TranscriptEvent);
					}
					break;
				case "tool_use":
					this.emit("event", {
						kind: "tool-use",
						toolUseId: b.id ?? "",
						name: b.name ?? "",
						input: b.input ?? {},
						sourceUuid,
						timestamp,
					} satisfies TranscriptEvent);
					break;
				case "thinking":
				case "redacted_thinking":
					this.emit("event", {
						kind: "thinking-delta",
						text: typeof b.thinking === "string" ? b.thinking : "",
						signature: typeof b.signature === "string" ? b.signature : undefined,
						redacted: b.type === "redacted_thinking",
						sourceUuid,
						timestamp,
					} satisfies TranscriptEvent);
					break;
				default:
					this.emit("event", {
						kind: "warn",
						reason: `unknown assistant content block type: ${b.type}`,
					} satisfies TranscriptEvent);
			}
		}
		// Usage is attached to the assistant entry per Phase 0 T0.3.
		this.maybeEmitUsage(entry);
	}

	private maybeEmitUsage(entry: any): void {
		const u = entry?.message?.usage;
		if (!u || typeof u !== "object") return;
		const usage: UsagePayload = {
			input: numOrZero(u.input_tokens),
			output: numOrZero(u.output_tokens),
			cacheRead: numOrZero(u.cache_read_input_tokens),
			cacheWrite: numOrZero(u.cache_creation_input_tokens),
			cacheCreate1h: u.cache_creation?.ephemeral_1h_input_tokens,
			cacheCreate5m: u.cache_creation?.ephemeral_5m_input_tokens,
		};
		this.emit("event", {
			kind: "usage",
			usage,
			model: entry?.message?.model,
			stopReason: entry?.message?.stop_reason,
		} satisfies TranscriptEvent);
	}

	private finalizeAfterSettle(): void {
		if (this.state === "closed" || this.state === "errored") return;
		this.state = "closed";
		// Drain any final bytes.
		this.doRead()
			.catch(() => {})
			.finally(() => {
				if (this.lineBuffer.trim()) {
					// Try to process incomplete tail as a best-effort.
					this.processLine(this.lineBuffer);
					this.lineBuffer = "";
				}
				this.cleanupResources();
				this.emit("event", { kind: "done", reason: "stop-settled" } satisfies TranscriptEvent);
			});
	}

	private emitError(message: string): void {
		if (this.state === "closed" || this.state === "errored") return;
		this.state = "errored";
		this.cleanupResources();
		this.emit("event", { kind: "error", errorMessage: message } satisfies TranscriptEvent);
	}

	private cleanupResources(): void {
		if (this.creationTimer !== undefined) {
			this.clearTimerFn(this.creationTimer);
			this.creationTimer = undefined;
		}
		if (this.settleTimer !== undefined) {
			this.clearTimerFn(this.settleTimer);
			this.settleTimer = undefined;
		}
		if (this.pollTimer !== undefined) {
			this.clearTimerFn(this.pollTimer);
			this.pollTimer = undefined;
		}
		if (this.dirWatcher) {
			try { this.dirWatcher.close(); } catch {}
			this.dirWatcher = undefined;
		}
		if (this.handle) {
			void this.handle.close().catch(() => {});
			this.handle = undefined;
		}
	}
}

function numOrZero(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Convenience: compute the deterministic transcript path from a cwd + uuid.
 * Per D18 + Phase 0 F1, cwd MUST be passed through `fs.realpathSync` first
 * by the caller (this function does NOT realpath — it assumes caller did).
 */
export function computeTranscriptPath(homeDir: string, realpathedCwd: string, uuid: string): string {
	// CC's encoding replaces BOTH `/` AND `.` with `-`. Without the dot
	// substitution, a cwd containing a dot-prefixed segment (e.g.
	// `.test-output`) produces a different encoded directory than CC writes
	// to, and the tailer hangs waiting for a file that never appears in our
	// computed path. Discovered via s18/s19 sandbox-cwd scenarios.
	const encodedCwd = realpathedCwd.replaceAll("/", "-").replaceAll(".", "-");
	return `${homeDir}/.claude/projects/${encodedCwd}/${uuid}.jsonl`;
}
