// src/driver/pty.ts
//
// PTY driver. Owns the lifecycle of one `claude` invocation:
//   1. Pre-spawn: generate uuid + socket path; start IPC router; build
//      settings + mcp-config JSON; compute transcript path.
//   2. Spawn `claude` via node-pty with all flags.
//   3. Attach trust-dialog scanner (D25).
//   4. Start transcript tailer on the computed path.
//   5. Bridge events from router (toolCall / hookEvent / captureStash) +
//      transcript (text-delta / tool-use / thinking-delta / usage / done /
//      warn / error) onto the driver's own EventEmitter surface.
//   6. Abort: SIGINT → 3s grace → SIGKILL; tear down per D15.
//
// The driver does NOT know about pi's StreamEvent shape. The bridge stream
// layer in index.ts subscribes to driver events and projects them onto pi.

import { EventEmitter } from "node:events";
import { realpathSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { stripAnsi } from "./ansi.js";
import { buildSettingsJson, buildMcpConfigJson, buildAllowedToolsArg } from "./settings.js";
import { TranscriptTailer, computeTranscriptPath, type TranscriptEvent } from "./transcript.js";
import {
	Router,
	type RouterOptions,
	type RouterToolDefinition,
	type ToolResultContent,
} from "../mcp/router.js";
import { generateSocketPath } from "../mcp/ipc.js";

// =============================================================================
// TrustDialogScanner (D25)
// =============================================================================

export const TRUST_DIALOG_TRIGGERS: readonly string[] = Object.freeze([
	"Quick safety check",
	"Accessing workspace:",
]);

export const TRUST_DIALOG_ANSWER = "\r";
export const TRUST_DIALOG_BUFFER_LIMIT = 4096;
export const TRUST_DIALOG_DEFAULT_DIALOG_TIMEOUT_MS = 5000;
export const TRUST_DIALOG_DEFAULT_HARD_TIMEOUT_MS = 30000;

export type TrustDialogScannerState =
	| "scanning"
	| "answered"
	| "closed-no-dialog"
	| "transcript-seen"
	| "failed";

export interface TrustDialogScannerOptions {
	onAnswer: (data: string) => void;
	onFailure: (reason: string) => void;
	dialogTimeoutMs?: number;
	hardTimeoutMs?: number;
	setTimer?: (cb: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
}

type TimerHandle = unknown;

/**
 * State machine that consumes PTY output bytes and answers the workspace-
 * trust dialog when it appears (per D25).
 */
export class TrustDialogScanner {
	private state: TrustDialogScannerState = "scanning";
	private buffer = "";
	private dialogTimer: TimerHandle = undefined;
	private hardTimer: TimerHandle = undefined;
	private started = false;
	private readonly dialogTimeoutMs: number;
	private readonly hardTimeoutMs: number;
	private readonly setTimerFn: NonNullable<TrustDialogScannerOptions["setTimer"]>;
	private readonly clearTimerFn: NonNullable<TrustDialogScannerOptions["clearTimer"]>;

	constructor(private readonly opts: TrustDialogScannerOptions) {
		this.dialogTimeoutMs = opts.dialogTimeoutMs ?? TRUST_DIALOG_DEFAULT_DIALOG_TIMEOUT_MS;
		this.hardTimeoutMs = opts.hardTimeoutMs ?? TRUST_DIALOG_DEFAULT_HARD_TIMEOUT_MS;
		this.setTimerFn = opts.setTimer ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
		this.clearTimerFn = opts.clearTimer ?? ((h: TimerHandle) => clearTimeout(h as ReturnType<typeof setTimeout>));
	}

	start(): void {
		if (this.started) return;
		this.started = true;
		this.dialogTimer = this.setTimerFn(() => this.onDialogWindowElapsed(), this.dialogTimeoutMs);
		this.hardTimer = this.setTimerFn(() => this.onHardTimeoutElapsed(), this.hardTimeoutMs);
	}

	feed(chunk: string): void {
		if (this.state !== "scanning") return;
		this.buffer += chunk;
		let stripped = stripAnsi(this.buffer);
		if (stripped.length > TRUST_DIALOG_BUFFER_LIMIT) {
			stripped = stripped.slice(-TRUST_DIALOG_BUFFER_LIMIT);
		}
		this.buffer = stripped;
		for (const trigger of TRUST_DIALOG_TRIGGERS) {
			if (stripped.includes(trigger)) {
				this.answer();
				return;
			}
		}
	}

	notifyTranscriptCreated(): void {
		if (this.state === "failed" || this.state === "transcript-seen") return;
		this.state = "transcript-seen";
		this.clearAllTimers();
	}

	getState(): TrustDialogScannerState {
		return this.state;
	}

	cancel(): void {
		if (this.state === "failed" || this.state === "transcript-seen") return;
		this.state = "transcript-seen";
		this.clearAllTimers();
	}

	private answer(): void {
		this.state = "answered";
		if (this.dialogTimer !== undefined) {
			this.clearTimerFn(this.dialogTimer);
			this.dialogTimer = undefined;
		}
		try { this.opts.onAnswer(TRUST_DIALOG_ANSWER); } catch {}
		this.buffer = "";
	}

	private onDialogWindowElapsed(): void {
		this.dialogTimer = undefined;
		if (this.state === "scanning") {
			this.state = "closed-no-dialog";
			this.buffer = "";
		}
	}

	private onHardTimeoutElapsed(): void {
		this.hardTimer = undefined;
		if (this.state === "transcript-seen" || this.state === "failed") return;
		const reason =
			this.state === "answered"
				? `trust-scanner: ${this.hardTimeoutMs}ms elapsed; dialog was answered but transcript never appeared`
				: this.state === "closed-no-dialog"
					? `trust-scanner: ${this.hardTimeoutMs}ms elapsed; no dialog detected and transcript never appeared`
					: `trust-scanner: ${this.hardTimeoutMs}ms elapsed with neither dialog detection nor transcript creation`;
		this.state = "failed";
		this.clearAllTimers();
		try { this.opts.onFailure(reason); } catch {}
	}

	private clearAllTimers(): void {
		if (this.dialogTimer !== undefined) {
			this.clearTimerFn(this.dialogTimer);
			this.dialogTimer = undefined;
		}
		if (this.hardTimer !== undefined) {
			this.clearTimerFn(this.hardTimer);
			this.hardTimer = undefined;
		}
	}
}

// =============================================================================
// Spawn orchestrator
// =============================================================================

/**
 * Abstraction over `node-pty` so tests can inject a mock.
 *
 * Real impl: `import * as pty from "node-pty"; ptySpawn = pty.spawn`.
 * Injected via setPtySpawn() for unit tests.
 */
export interface IPtyProcess {
	pid: number;
	write(data: string): void;
	kill(signal?: string): void;
	onData(cb: (data: string) => void): void;
	onExit(cb: (e: { exitCode: number; signal?: number | string }) => void): void;
	resize?(cols: number, rows: number): void;
}

export type PtySpawnFn = (
	file: string,
	args: string[],
	opts: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv },
) => IPtyProcess;

let _ptySpawn: PtySpawnFn | undefined;

export function setPtySpawn(fn: PtySpawnFn): void {
	_ptySpawn = fn;
}

async function loadPtySpawn(): Promise<PtySpawnFn> {
	if (_ptySpawn) return _ptySpawn;
	const m: any = await import("node-pty");
	return m.spawn as PtySpawnFn;
}

/**
 * Configuration for one driver spawn (one turn).
 */
export interface SpawnDriverOptions {
	/** Path to the `claude` binary. Default: looked up via PATH. */
	claudeBin?: string;
	/** Path to the shim JS file. Default: resolved via require.resolve. */
	shimPath: string;
	/** Resolved model id (CLI value). */
	model: string;
	/** User prompt — text only (positional CLI arg). */
	prompt: string;
	/** System prompt content. */
	systemPrompt: string;
	/** Working directory (lexical; realpath'd internally). */
	cwd: string;
	/** Mode: main = router parks tool_calls; capture = local stash. */
	mode: "main" | "capture";
	/** Tools to advertise via the shim. */
	tools: RouterToolDefinition[];
	/** Optional: capture-tool details for D16/D21 path. */
	capture?: { toolName: string; schema: unknown };
	/** Optional: warm-resume session id (D22). When present, --resume is used
	 *  instead of --session-id, and transcript path uses this id. */
	resumeSessionId?: string;
	/** Optional pi AbortSignal. */
	signal?: AbortSignal;
	/** PTY dimensions. Default 100x30. */
	cols?: number;
	rows?: number;
	/** Abort grace window before SIGKILL. Default 3000ms. */
	abortGraceMs?: number;
	/** Transcript settle window. Default 250ms. */
	settleMs?: number;
	/** Auto-answer trust dialog. Default true (per D25). */
	autoAnswerTrustDialog?: boolean;
	/** Override the env passed to the spawned binary. Default process.env. */
	env?: NodeJS.ProcessEnv;
}

/**
 * Events emitted by the driver. Pi's stream layer subscribes to these and
 * translates onto pi-ai's StreamEvent shape.
 *
 * - "transcript"  → TranscriptEvent passthrough
 * - "tool-call-parked" → router parked a tool_call; await deliverResult()
 * - "captured-args" → capture mode received stash
 * - "hook" → SessionStart or Stop hook fired
 * - "done" → driver lifecycle finished (success, abort, or error already emitted)
 */
export interface DriverEvents {
	transcript: TranscriptEvent;
	"tool-call-parked": {
		id: string;
		name: string;
		arguments: unknown;
		deliverResult: (content: ToolResultContent, isError?: boolean) => void;
	};
	"captured-args": unknown;
	hook: { event: "SessionStart" | "Stop"; payload: Record<string, unknown> };
	done: { reason: "stop-settled" | "aborted" | "error"; errorMessage?: string };
	pty_exit: { exitCode: number; signal?: number | string };
}

export interface DriverHandle {
	on<K extends keyof DriverEvents>(event: K, listener: (payload: DriverEvents[K]) => void): DriverHandle;
	off<K extends keyof DriverEvents>(event: K, listener: (payload: DriverEvents[K]) => void): DriverHandle;
	once<K extends keyof DriverEvents>(event: K, listener: (payload: DriverEvents[K]) => void): DriverHandle;
	/** Abort the turn. Sends SIGINT, then SIGKILL after grace. Resolves when fully torn down. */
	abort(): Promise<void>;
	/** Pre-computed transcript path (for diagnostics). */
	readonly transcriptPath: string;
	/** Generated session id (or resumed). */
	readonly sessionId: string;
	/** Router instance (for capture-result harvesting + D15 preservation). */
	readonly router: Router;
	/** Promise that resolves when the driver lifecycle is done. */
	readonly done: Promise<DriverEvents["done"]>;
}

class DriverHandleImpl extends EventEmitter implements DriverHandle {
	public readonly transcriptPath: string;
	public readonly sessionId: string;
	public readonly router: Router;
	public readonly done: Promise<DriverEvents["done"]>;
	private doneResolve!: (v: DriverEvents["done"]) => void;
	private aborted = false;
	private settled = false;
	private erroredEmitted = false;
	private ptyExited = false;

	constructor(
		sessionId: string,
		transcriptPath: string,
		router: Router,
		private readonly proc: IPtyProcess,
		private readonly tailer: TranscriptTailer,
		private readonly opts: SpawnDriverOptions,
	) {
		super();
		this.sessionId = sessionId;
		this.transcriptPath = transcriptPath;
		this.router = router;
		this.done = new Promise<DriverEvents["done"]>((resolve) => {
			this.doneResolve = resolve;
		});
	}

	on<K extends keyof DriverEvents>(event: K, listener: (payload: DriverEvents[K]) => void): this {
		return super.on(event as string, listener as (...args: any[]) => void);
	}
	off<K extends keyof DriverEvents>(event: K, listener: (payload: DriverEvents[K]) => void): this {
		return super.off(event as string, listener as (...args: any[]) => void);
	}
	once<K extends keyof DriverEvents>(event: K, listener: (payload: DriverEvents[K]) => void): this {
		return super.once(event as string, listener as (...args: any[]) => void);
	}

	emitTyped<K extends keyof DriverEvents>(event: K, payload: DriverEvents[K]): void {
		this.emit(event as string, payload);
	}

	async abort(): Promise<void> {
		if (this.aborted) return;
		this.aborted = true;
		// Per D15: transcript stream into aborted mode immediately.
		this.tailer.abort();
		// Send SIGINT, grace, then SIGKILL.
		try { this.proc.kill("SIGINT"); } catch {}
		await new Promise<void>((resolve) => {
			let done = false;
			const finish = () => {
				if (done) return;
				done = true;
				clearTimeout(killTimer);
				this.off("pty_exit", onExit);
				resolve();
			};
			const onExit = () => finish();
			this.once("pty_exit", onExit);
			const killTimer = setTimeout(() => {
				try { this.proc.kill("SIGKILL"); } catch {}
				finish();
			}, this.opts.abortGraceMs ?? 3000);
		});
		// Per D15: preserve router state, detach socket.
		await this.router.preserveAndDetachFromPty();
		this.finalize({ reason: "aborted" });
	}

	finalize(payload: DriverEvents["done"]): void {
		if (this.settled) return;
		this.settled = true;
		this.emitTyped("done", payload);
		this.doneResolve(payload);
	}

	markErrored(errorMessage: string): void {
		if (this.erroredEmitted) return;
		this.erroredEmitted = true;
		this.finalize({ reason: "error", errorMessage });
	}

	markPtyExit(exitCode: number, signal?: number | string): void {
		if (this.ptyExited) return;
		this.ptyExited = true;
		this.emitTyped("pty_exit", { exitCode, signal });
	}

	getPty(): IPtyProcess { return this.proc; }
	get isAborted(): boolean { return this.aborted; }
}

/**
 * Top-level driver spawn. Returns a DriverHandle once the PTY is spawned
 * (the actual model run happens asynchronously; subscribe to events).
 */
export async function spawnDriver(opts: SpawnDriverOptions): Promise<DriverHandle> {
	const realCwd = realpathSync(opts.cwd);
	const sessionId = opts.resumeSessionId ?? randomUUID();
	const transcriptPath = computeTranscriptPath(homedir(), realCwd, sessionId);
	const socketPath = generateSocketPath();
	const env = { ...(opts.env ?? process.env) };

	// Build a tools-file for the shim.
	const toolsFileDir = mkdtempSync(join(tmpdir(), "pi-bridge-tools-"));
	const toolsFilePath = join(toolsFileDir, "tools.json");
	writeFileSync(toolsFilePath, JSON.stringify({
		tools: opts.tools,
		captureSchema: opts.capture?.schema,
	}));

	// Start router on the socket.
	const router = new Router({
		mode: opts.mode,
		tools: opts.tools,
		socketPath,
	});
	await router.listen();

	// Build CLI args.
	const settings = buildSettingsJson({ shimPath: opts.shimPath, socketPath });
	const mcpConfig = buildMcpConfigJson({ shimPath: opts.shimPath, socketPath });

	const args: string[] = [];
	if (opts.resumeSessionId) {
		args.push("--resume", opts.resumeSessionId);
	} else {
		args.push("--session-id", sessionId);
	}
	args.push("--model", opts.model);
	// --system-prompt: if large, write to file and use --system-prompt-file (T0.11)
	if (opts.systemPrompt.length > 50_000) {
		const spPath = join(toolsFileDir, "sysprompt.txt");
		writeFileSync(spPath, opts.systemPrompt);
		args.push("--system-prompt-file", spPath);
	} else {
		args.push("--system-prompt", opts.systemPrompt);
	}
	args.push("--mcp-config", mcpConfig);
	args.push("--strict-mcp-config");
	args.push("--setting-sources", "");
	args.push("--permission-mode", "bypassPermissions");
	args.push("--dangerously-skip-permissions");
	args.push("--settings", settings);
	args.push("--allowedTools", buildAllowedToolsArg());
	// Capture mode: also disable slash commands (F4 mitigation).
	if (opts.mode === "capture") {
		args.push("--disable-slash-commands");
	}
	// Positional prompt
	args.push(opts.prompt);

	// Spawn PTY.
	const ptySpawn = await loadPtySpawn();
	const proc = ptySpawn(
		opts.claudeBin ?? "claude",
		args,
		{
			name: "xterm-256color",
			cols: opts.cols ?? 100,
			rows: opts.rows ?? 30,
			cwd: realCwd,
			env,
		},
	);

	// Start transcript tailer.
	const tailer = new TranscriptTailer({
		transcriptPath,
		settleMs: opts.settleMs ?? 250,
	});

	const handle = new DriverHandleImpl(sessionId, transcriptPath, router, proc, tailer, opts);

	// Wire transcript → driver events
	tailer.on("event", (e: TranscriptEvent) => {
		handle.emitTyped("transcript", e);
		if (e.kind === "done" || e.kind === "error") {
			if (e.kind === "error") {
				handle.markErrored(e.errorMessage);
			} else {
				handle.finalize({ reason: e.reason === "aborted" ? "aborted" : "stop-settled" });
			}
		}
	});
	tailer.start();

	// Trust scanner
	let scanner: TrustDialogScanner | undefined;
	if (opts.autoAnswerTrustDialog !== false) {
		scanner = new TrustDialogScanner({
			onAnswer: (d) => proc.write(d),
			onFailure: (msg) => {
				try { proc.kill("SIGKILL"); } catch {}
				handle.markErrored(msg);
			},
		});
		scanner.start();
	}

	// PTY data → scanner
	proc.onData((data) => {
		if (scanner) scanner.feed(data);
	});
	proc.onExit((e) => {
		handle.markPtyExit(e.exitCode, e.signal);
		if (scanner) scanner.cancel();
		// If the PTY exited unexpectedly (before Stop hook fired settle), the
		// transcript tailer's "error" / "done" path will surface; nothing
		// more to do here unless it's an early error.
		// Per "unexpected driver exit" AC: if exit happens before Stop, emit
		// error. We rely on tailer emitting error via creationTimeoutMs;
		// also surface a synthetic error if the tailer is still in
		// waiting-for-file state when PTY exits.
		if (!handle.isAborted) {
			// Defer: give the tailer a moment to settle if it can.
			setTimeout(() => {
				// If we haven't finalized by 500ms post-exit and not aborted,
				// declare driver exit error.
				if (!handle["settled"]) {
					handle.markErrored(`claude PTY exited before stop hook (exitCode=${e.exitCode}, signal=${e.signal})`);
				}
			}, 500);
		}
	});

	// Router events
	router.on("toolCall", (entry) => {
		handle.emitTyped("tool-call-parked", {
			id: entry.id,
			name: entry.name,
			arguments: entry.arguments,
			deliverResult: (content, isError = false) => {
				router.deliverToolResult(entry.id, content, isError);
			},
		});
	});
	router.on("captureStash", (args) => {
		handle.emitTyped("captured-args", args);
	});
	router.on("hookEvent", (e: { event: string; payload: Record<string, unknown>; resolve: (stdout: string) => void }) => {
		handle.emitTyped("hook", { event: e.event as "SessionStart" | "Stop", payload: e.payload });
		// Send Stop → trigger transcript settle.
		if (e.event === "Stop") {
			tailer.stopSettle();
		}
		// Respond {} to all hooks; claude expects a JSON object on stdout.
		e.resolve("{}");
	});

	// Plumb pi AbortSignal
	if (opts.signal) {
		if (opts.signal.aborted) {
			// Don't actually abort during construction; defer to next tick
			queueMicrotask(() => { void handle.abort(); });
		} else {
			opts.signal.addEventListener("abort", () => { void handle.abort(); }, { once: true });
		}
	}

	// On done, always close router (if not aborted; abort already detached).
	handle.once("done", async () => {
		if (!handle.isAborted) {
			await router.close().catch(() => {});
		}
	});

	return handle;
}
