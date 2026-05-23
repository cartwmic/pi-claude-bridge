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
import { buildSettingsJson, buildMcpConfigJson } from "./settings.js";
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

// =============================================================================
// InkQuiescenceTracker (D26)
// =============================================================================
//
// Used by the typed-injection sequence to wait for the `claude` Ink TUI to
// finish its initial render (and any subsequent burst of redraws) before we
// type the prompt into the PTY input. Ink applies bracketed-paste /
// burst-input heuristics that can swallow our `\r` if it arrives in the same
// output burst as the prompt bytes — the quiescence wait + later debounce
// together defeat that.
//
// Track `lastOutputAtMs` updated on every `proc.onData` call. `waitForQuiescent`
// polls every `pollMs` and returns when `now - lastOutputAtMs >= silentMs` OR
// when `ceilingMs` elapses. Returns the wait outcome so callers can log
// ceiling-hits as a warn-level event.

export const INK_QUIESCENCE_DEFAULT_SILENT_MS = 80;
export const INK_QUIESCENCE_DEFAULT_CEILING_MS = 2000;
export const INK_QUIESCENCE_DEFAULT_POLL_MS = 15;
export const INK_ENTER_DEBOUNCE_DEFAULT_MS = 120;
export const SESSION_START_WAIT_DEFAULT_MS = 15000;

export interface InkQuiescenceTrackerOptions {
	silentMs?: number;
	ceilingMs?: number;
	pollMs?: number;
	/** Injectable clock for unit tests. Defaults to `Date.now`. */
	now?: () => number;
	/** Injectable scheduler for unit tests. Defaults to `setTimeout`. */
	sleep?: (ms: number) => Promise<void>;
}

export type InkQuiescenceOutcome = "quiescent" | "ceiling-hit";

export class InkQuiescenceTracker {
	private lastOutputAtMs = 0;
	private readonly silentMs: number;
	private readonly ceilingMs: number;
	private readonly pollMs: number;
	private readonly now: () => number;
	private readonly sleep: (ms: number) => Promise<void>;

	constructor(opts: InkQuiescenceTrackerOptions = {}) {
		this.silentMs = opts.silentMs ?? INK_QUIESCENCE_DEFAULT_SILENT_MS;
		this.ceilingMs = opts.ceilingMs ?? INK_QUIESCENCE_DEFAULT_CEILING_MS;
		this.pollMs = opts.pollMs ?? INK_QUIESCENCE_DEFAULT_POLL_MS;
		this.now = opts.now ?? (() => Date.now());
		this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
	}

	/** Call from `proc.onData` on every output chunk. */
	noteOutput(): void {
		this.lastOutputAtMs = this.now();
	}

	/** Resolve when PTY has been silent for `silentMs` OR after `ceilingMs`. */
	async waitForQuiescent(): Promise<InkQuiescenceOutcome> {
		const waitStart = this.now();
		while (true) {
			const now = this.now();
			if (now - waitStart >= this.ceilingMs) return "ceiling-hit";
			if (this.lastOutputAtMs !== 0 && now - this.lastOutputAtMs >= this.silentMs) {
				return "quiescent";
			}
			await this.sleep(this.pollMs);
		}
	}
}

/**
 * D27: Compose a single typed user message that bundles the pi system
 * prompt content + the user's actual prompt.
 *
 * Why: see design D27. Anthropic's interactive-mode billing/safety
 * classifier rejects `--system-prompt*` payloads above a content-density
 * threshold (returns `API Error: 400 "out of extra usage"` even when
 * overage is disabled and the account has 99% budget remaining). The
 * same content delivered as a typed user message is accepted normally.
 *
 * Shape: `<system_context>\n<systemPrompt>\n</system_context>\n\n<userPrompt>`
 *
 * If `systemPrompt` is empty or only whitespace, returns `userPrompt` verbatim
 * so we don't add useless wrapper tags to small messages.
 *
 * The model treats the wrapped block as user-provided context, which is
 * functionally identical to system-prompt content for the response. The
 * only behavioral difference is the conversation-role attribution, which
 * does not affect pi's expected outputs.
 */
export function composeBundledUserMessage(
	systemPrompt: string,
	userPrompt: string,
): string {
	if (!systemPrompt || !systemPrompt.trim()) return userPrompt;
	return `<system_context>\n${systemPrompt}\n</system_context>\n\n${userPrompt}`;
}

/**
 * Type a prompt into a PTY input stream using the D26 two-write debounced
 * sequence. Defeats Ink's bracketed-paste burst-merging that otherwise
 * lands `\r` in the input buffer instead of triggering submit.
 *
 * Sequence:
 *   1. `proc.write(prompt)`
 *   2. await `debounceMs` (default 120ms)
 *   3. `proc.write("\r")`
 */
export async function typePromptWithDebounce(
	proc: { write: (s: string) => void },
	prompt: string,
	debounceMs: number = INK_ENTER_DEBOUNCE_DEFAULT_MS,
	sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
	proc.write(prompt);
	await sleep(debounceMs);
	proc.write("\r");
}

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

// T4.7 — runtime version check, executed at most once per bridge process,
// at the first spawn (NOT at extension load time, per R9). Warns if the
// detected `claude --version` falls outside the tested-against range.
const TESTED_AGAINST_RANGE = { major: 2, minorMin: 1, minorMax: 1 };
let _versionCheckDone = false;
async function runVersionCheckOnce(claudeBin: string): Promise<void> {
	if (_versionCheckDone) return;
	_versionCheckDone = true;
	try {
		const { execFileSync } = await import("node:child_process");
		const out = execFileSync(claudeBin, ["--version"], { encoding: "utf8", timeout: 5000 });
		const m = out.match(/(\d+)\.(\d+)\.(\d+)/);
		if (!m) return;
		const maj = Number(m[1]);
		const min = Number(m[2]);
		if (maj !== TESTED_AGAINST_RANGE.major || min < TESTED_AGAINST_RANGE.minorMin || min > TESTED_AGAINST_RANGE.minorMax) {
			// eslint-disable-next-line no-console
			console.warn(
				`pi-claude-bridge: claude ${out.trim()} is outside tested-against range ` +
				`(>=${TESTED_AGAINST_RANGE.major}.${TESTED_AGAINST_RANGE.minorMin}.x <=${TESTED_AGAINST_RANGE.major}.${TESTED_AGAINST_RANGE.minorMax}.x). ` +
				`Behavior may diverge.`,
			);
		}
	} catch {
		// Best-effort: missing-binary or stat failure surfaces elsewhere.
	}
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
	/** User prompt — text only. Delivered via typed-input post-`SessionStart`
	 * per D26 (NOT as a positional CLI arg). */
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
	/** D26: Ink quiescence silent window before typing. Default 80ms. */
	inkQuiescenceMs?: number;
	/** D26: Ink quiescence ceiling — type-anyway after this. Default 2000ms. */
	inkMaxWaitMs?: number;
	/** D26: Inter-write debounce between prompt bytes and `\r`. Default 120ms. */
	inkEnterDebounceMs?: number;
	/** D26: How long to wait for `SessionStart` hook before erroring. Default 15000ms. */
	sessionStartWaitMs?: number;
	/** D27: How long to wait for the transcript file to appear after the
	 * model starts processing. Default 90000ms (Opus + large pi sysprompt
	 * can take 30–60s). */
	transcriptCreationTimeoutMs?: number;
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
	const mcpConfig = buildMcpConfigJson({
		shimPath: opts.shimPath,
		socketPath,
		toolsFile: toolsFilePath,
		captureTool: opts.capture?.toolName,
	});

	const args: string[] = [];
	if (opts.resumeSessionId) {
		args.push("--resume", opts.resumeSessionId);
	} else {
		args.push("--session-id", sessionId);
	}
	args.push("--model", opts.model);
	// D27 (2026-05-22): DO NOT pass `--system-prompt[-file]`. Empirically, ANY
	// substantive system prompt content delivered via `--system-prompt*` flags
	// to interactive `claude` trips Anthropic's billing/safety classifier
	// (returns `API Error: 400 "out of extra usage"` even when overage is
	// disabled and budget is 99% available). Even `--append-system-prompt-file`
	// fails. The same content typed as a user message succeeds. We deliver
	// `opts.systemPrompt` as the LEADING segment of the typed user message
	// post-SessionStart (D26 sequence), wrapped in `<system_context>` tags.
	// Constitution V (capture path verbatim sysprompt) is preserved because
	// the capture path receives `opts.systemPrompt` and types it before
	// `opts.prompt` — the model sees the exact same content in the same order,
	// just on the user role channel instead of system role. See design D27.
	args.push("--mcp-config", mcpConfig);
	args.push("--strict-mcp-config");
	args.push("--setting-sources", "");
	args.push("--permission-mode", "bypassPermissions");
	args.push("--dangerously-skip-permissions");
	args.push("--settings", settings);
	// NOTE on --allowedTools: claude's commander parser declares it as
	// variadic (`<tools...>`), which consumes ALL subsequent positional
	// arguments — including our positional PROMPT. Dropping it is safe:
	// the bridged surface is already isolated by `--strict-mcp-config`
	// (no user MCP servers), `--setting-sources ""` (no user/project/local
	// settings), and the inline `permissions.deny` set in --settings (all
	// native built-ins blocked). The `mcp__custom-tools__*` namespace is
	// already the only callable surface.
	// Capture mode: also disable slash commands (F4 mitigation).
	if (opts.mode === "capture") {
		args.push("--disable-slash-commands");
	}
	// NB (D26, 2026-05-22): the pi user prompt is NOT passed as a positional
	// CLI argument. The positional form triggers `claude`'s internal
	// headless-auto-submit code path whose request shape is rejected by
	// Anthropic's OAuth interactive-mode tier cap (`API Error: 400`
	// "out of extra usage"). The prompt is typed into the TUI input post-
	// `SessionStart` per the InkQuiescenceTracker + typePromptWithDebounce
	// sequence below. Reference: smithersai/claude-p. See design.md D26.

	// Spawn PTY.
	const ptySpawn = await loadPtySpawn();
	await runVersionCheckOnce(opts.claudeBin ?? "claude");
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
		creationTimeoutMs: opts.transcriptCreationTimeoutMs,
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

	// Ink quiescence tracker (D26) — fed by every PTY output chunk; consulted
	// by the typed-injection sequence to know when Ink has stopped redrawing.
	const quiescence = new InkQuiescenceTracker({
		silentMs: opts.inkQuiescenceMs,
		ceilingMs: opts.inkMaxWaitMs,
	});

	// PTY data → scanner + quiescence tracker
	proc.onData((data) => {
		if (scanner) scanner.feed(data);
		quiescence.noteOutput();
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
	// Typed-injection state (D26)
	let sessionStartFired = false;
	let promptTyped = false;
	router.on("hookEvent", (e: { event: string; payload: Record<string, unknown>; resolve: (stdout: string) => void }) => {
		handle.emitTyped("hook", { event: e.event as "SessionStart" | "Stop", payload: e.payload });
		// Send Stop → trigger transcript settle.
		if (e.event === "Stop") {
			tailer.stopSettle();
		}
		// SessionStart → trigger typed-prompt injection (D26).
		if (e.event === "SessionStart" && !sessionStartFired && !promptTyped) {
			sessionStartFired = true;
			// SessionStart firing proves claude is past the workspace-trust gate.
			// Stop the trust scanner so its 30s hard-timeout doesn't fire later
			// (e.g. when Opus + large pi context takes >30s to first transcript line).
			if (scanner) scanner.cancel();
			void (async () => {
				try {
					await quiescence.waitForQuiescent();
					if (handle.isAborted) return;
					// D27: bundle system prompt + user prompt into a single typed
					// user message. The system content goes in <system_context>
					// tags; the user prompt follows. If systemPrompt is empty,
					// just type the user prompt verbatim.
					const bundled = composeBundledUserMessage(opts.systemPrompt, opts.prompt);
					await typePromptWithDebounce(
						proc,
						bundled,
						opts.inkEnterDebounceMs ?? INK_ENTER_DEBOUNCE_DEFAULT_MS,
					);
					promptTyped = true;
				} catch (err) {
					handle.markErrored(
						`typed-injection failed: ${(err as Error)?.message ?? String(err)}`,
					);
				}
			})();
		}
		// Respond {} to all hooks; claude expects a JSON object on stdout.
		e.resolve("{}");
	});

	// SessionStart timeout failsafe (D26). If the hook doesn't fire within
	// `sessionStartWaitMs` of spawn, declare it a hard error; the prompt is
	// undeliverable without it.
	const sessionStartTimeoutMs = opts.sessionStartWaitMs ?? SESSION_START_WAIT_DEFAULT_MS;
	setTimeout(() => {
		if (sessionStartFired) return;
		if (handle.isAborted) return;
		try { proc.kill("SIGKILL"); } catch {}
		handle.markErrored(
			`SessionStart hook did not fire within ${sessionStartTimeoutMs}ms; prompt cannot be delivered (D26)`,
		);
	}, sessionStartTimeoutMs);

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
