import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	closeSync,
	constants as fsConstants,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Writable } from "node:stream";
import {
	CLAUDE_P_DISALLOWED_TOOLS,
	DISALLOWED_TOOLS_VALUE,
	type ClaudePDoneResult,
	type ClaudePLogger,
	type ClaudePSpawnConfig,
	type SystemPromptSource,
} from "./claudeP.js";
import { ClaudePrintStreamParser } from "./claudePrintStream.js";
import type { DriverStreamEvent, DriverToolUseBatch } from "./stream.js";

export const CLAUDE_PRINT_DEFAULT_READY_TIMEOUT_MS = 30_000;
export const CLAUDE_PRINT_MAX_READY_TIMEOUT_MS = 2_147_483_647;
export const CLAUDE_PRINT_ABORT_GRACE_MS = 2_000;
export const CLAUDE_PRINT_SYSTEM_PROMPT_FILE_THRESHOLD_BYTES = 50 * 1024;
export const DEFAULT_CLAUDE_PRINT_BIN = "claude";

export type ClaudePrintAttemptPhase = "ready" | "promptSubmitted" | "turnAccepted" | "terminal";

export interface ClaudePrintLogger extends ClaudePLogger {
	debug?(...args: unknown[]): void;
}

export interface SpawnClaudePrintOptions {
	onEvent: (event: DriverStreamEvent) => void;
	onToolUseBatch?: (batch: DriverToolUseBatch) => void;
	onPhase?: (phase: ClaudePrintAttemptPhase) => void;
	logger?: ClaudePrintLogger;
	binPath?: string;
	signal?: AbortSignal;
	graceMs?: number;
	diagnosticsDir?: string;
	tmpDir?: string;
	env?: NodeJS.ProcessEnv;
	/** Test seam: production uses node:child_process.spawn. */
	spawnImpl?: typeof spawn;
	/** Test seam: production signals detached process groups with process.kill(-pid). */
	killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
}

export interface ClaudePrintHandle {
	readonly pid: number | undefined;
	abort(): void;
	readonly done: Promise<ClaudePDoneResult>;
}

export interface BuildClaudePrintArgsInput {
	systemPrompt: SystemPromptSource;
	mcpConfig: string;
	debugFile?: string;
}

const NOOP_LOGGER: ClaudePrintLogger = { debug() {}, info() {}, warn() {}, error() {} };
const READY_POLL_MS = 5;
const STDERR_TAIL_LINES = 20;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isInsideClaudeMutableState(path: string): boolean {
	const root = resolve(homedir(), ".claude");
	const candidate = resolve(path);
	return candidate === root || candidate.startsWith(`${root}/`);
}

function assertBridgeOwnedPath(path: string, label: string): void {
	if (isInsideClaudeMutableState(path)) {
		throw new Error(`claude-print ${label} must not use mutable Claude state under ~/.claude: ${path}`);
	}
}

/** Parse documented startup-only timeout. No coercion, whitespace, fractions, or timer overflow. */
export function resolveClaudePrintReadyTimeoutMs(
	env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): number {
	const raw = env.CLAUDE_BRIDGE_MCP_READY_TIMEOUT_MS;
	if (raw === undefined || raw === "") return CLAUDE_PRINT_DEFAULT_READY_TIMEOUT_MS;
	if (!/^[1-9]\d*$/.test(raw)) {
		throw new Error(
			`CLAUDE_BRIDGE_MCP_READY_TIMEOUT_MS must be a positive integer no greater than ${CLAUDE_PRINT_MAX_READY_TIMEOUT_MS}; found ${JSON.stringify(raw)}`,
		);
	}
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value > CLAUDE_PRINT_MAX_READY_TIMEOUT_MS) {
		throw new Error(
			`CLAUDE_BRIDGE_MCP_READY_TIMEOUT_MS must be a positive integer no greater than ${CLAUDE_PRINT_MAX_READY_TIMEOUT_MS}; found ${JSON.stringify(raw)}`,
		);
	}
	return value;
}

/** Pure exact argv builder. User content never appears positionally; it arrives as one stdin NDJSON frame. */
export function buildClaudePrintArgs(
	cfg: ClaudePSpawnConfig,
	input: BuildClaudePrintArgsInput,
): string[] {
	const args = [
		"-p",
		"--input-format", "stream-json",
		"--output-format", "stream-json",
		"--verbose",
		"--include-partial-messages",
		"--model", cfg.model,
	];
	if (input.systemPrompt.kind === "text") {
		args.push("--system-prompt", input.systemPrompt.text);
	} else {
		args.push("--system-prompt-file", input.systemPrompt.path);
	}
	args.push(
		"--mcp-config", input.mcpConfig,
		"--strict-mcp-config",
		"--setting-sources", "",
		"--permission-mode", "bypassPermissions",
		"--tools", "",
		"--disallowedTools", DISALLOWED_TOOLS_VALUE,
	);
	if (cfg.session.kind === "fresh") args.push("--session-id", cfg.session.sessionId);
	else args.push("--resume", cfg.session.sessionId);
	if (input.debugFile) args.push("--debug-file", input.debugFile);

	if (args.includes("--bare")) throw new Error("claude-print must not emit --bare");
	if (/\bmcp(__|\b)/i.test(DISALLOWED_TOOLS_VALUE)) {
		throw new Error("claude-print native denylist must not suppress mcp__custom-tools__ tools");
	}
	if (CLAUDE_P_DISALLOWED_TOOLS.length === 0) {
		throw new Error("claude-print defense-in-depth native denylist must not be empty");
	}
	return args;
}

function readPromptSource(source: ClaudePSpawnConfig["prompt"]): string {
	if (source.kind === "positional") return source.text;
	assertBridgeOwnedPath(source.path, "user prompt source");
	return readFileSync(source.path, "utf8");
}

function readSystemPromptSource(source: SystemPromptSource): string {
	if (source.kind === "text") return source.text;
	assertBridgeOwnedPath(source.path, "system prompt source");
	return readFileSync(source.path, "utf8");
}

function writeExclusivePrivateFile(path: string, content: string): void {
	const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
	const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o600);
	try {
		writeFileSync(fd, content, "utf8");
	} finally {
		closeSync(fd);
	}
}

function prepareSystemPrompt(invocationDir: string, text: string): SystemPromptSource {
	if (
		text.includes("\n") ||
		Buffer.byteLength(text, "utf8") >= CLAUDE_PRINT_SYSTEM_PROMPT_FILE_THRESHOLD_BYTES
	) {
		const path = join(invocationDir, "system-prompt.txt");
		writeExclusivePrivateFile(path, text);
		return { kind: "file", path };
	}
	return { kind: "text", text };
}

/** Require one explicit custom-tools server and replace its ready-file argument with invocation-owned sentinel. */
function bindPrivateReadyFile(rawConfig: string, readyFile: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawConfig);
	} catch (error) {
		throw new Error(`claude-print --mcp-config must be inline valid JSON: ${errorMessage(error)}`);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("claude-print --mcp-config root must be an object");
	}
	const root = parsed as Record<string, unknown>;
	const servers = root.mcpServers;
	if (servers === null || typeof servers !== "object" || Array.isArray(servers)) {
		throw new Error("claude-print --mcp-config requires mcpServers object");
	}
	const serverRecord = servers as Record<string, unknown>;
	const names = Object.keys(serverRecord);
	if (names.length !== 1 || names[0] !== "custom-tools") {
		throw new Error("claude-print explicit MCP closure requires exactly mcpServers.custom-tools");
	}
	const server = serverRecord["custom-tools"];
	if (server === null || typeof server !== "object" || Array.isArray(server)) {
		throw new Error("claude-print mcpServers.custom-tools must be an object");
	}
	const definition = server as Record<string, unknown>;
	if (typeof definition.command !== "string" || !Array.isArray(definition.args) || !definition.args.every((v) => typeof v === "string")) {
		throw new Error("claude-print mcpServers.custom-tools requires command and string args");
	}
	const prior = definition.args as string[];
	const next: string[] = [];
	for (let index = 0; index < prior.length; index++) {
		if (prior[index] !== "--ready-file") {
			next.push(prior[index]);
			continue;
		}
		if (index + 1 >= prior.length) throw new Error("claude-print shim --ready-file is missing its path");
		index++;
	}
	next.push("--ready-file", readyFile);
	definition.args = next;
	return JSON.stringify(parsed);
}

function sentinelIsExactlyReady(path: string): boolean {
	let stat;
	try {
		stat = lstatSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
	if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("claude-print readiness sentinel is not a regular file");
	if ((stat.mode & 0o077) !== 0) throw new Error("claude-print readiness sentinel is not owner-only");
	return readFileSync(path, "utf8") === "ready\n";
}

function userFrame(prompt: string): string {
	// Claude Code's streaming-input SDKUserMessage envelope. Session identity is
	// owned by --session-id/--resume; input records carry empty session_id.
	return `${JSON.stringify({
		type: "user",
		message: { role: "user", content: prompt },
		parent_tool_use_id: null,
		session_id: "",
	})}\n`;
}

function failedHandle(
	opts: SpawnClaudePrintOptions,
	sessionId: string,
	message: string,
): ClaudePrintHandle {
	opts.onEvent({ kind: "error", errorMessage: message });
	return {
		pid: undefined,
		abort() {},
		done: Promise.resolve({ stopReason: "error", sessionId, exitCode: null, signal: null }),
	};
}

/**
 * Spawn one authenticated direct print invocation. Readiness deadline is startup-only;
 * after one queued user frame there is no inference watchdog.
 */
export function spawnClaudePrint(cfg: ClaudePSpawnConfig, opts: SpawnClaudePrintOptions): ClaudePrintHandle {
	const logger = opts.logger ?? NOOP_LOGGER;
	const sessionId = cfg.session.sessionId;
	const env: NodeJS.ProcessEnv = { ...process.env, ...opts.env, CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: "0" };
	let timeoutMs: number;
	let prompt: string;
	let systemText: string;
	let invocationDir: string | undefined;
	let args: string[];
	let readyFile: string;
	try {
		timeoutMs = resolveClaudePrintReadyTimeoutMs(env);
		prompt = readPromptSource(cfg.prompt);
		systemText = readSystemPromptSource(cfg.systemPrompt);
		invocationDir = mkdtempSync(join(opts.tmpDir ?? tmpdir(), "pi-claude-print-"));
		chmodSync(invocationDir, 0o700);
		readyFile = join(invocationDir, "mcp.ready");
		const systemPrompt = prepareSystemPrompt(invocationDir, systemText);
		const mcpConfig = bindPrivateReadyFile(cfg.mcpConfig, readyFile);
		let debugFile = cfg.debugFile;
		if (!debugFile && env.CLAUDE_BRIDGE_CLAUDE_DEBUG_FILE !== "0") {
			const diagnosticsDir = opts.diagnosticsDir ?? dirname(invocationDir);
			mkdirSync(diagnosticsDir, { recursive: true, mode: 0o700 });
			debugFile = join(diagnosticsDir, `claude-print-debug-${sessionId.slice(0, 8)}-${Date.now()}-${randomUUID()}.log`);
		}
		if (debugFile) assertBridgeOwnedPath(debugFile, "debug file");
		args = buildClaudePrintArgs(cfg, { systemPrompt, mcpConfig, debugFile });
	} catch (error) {
		if (invocationDir) rmSync(invocationDir, { recursive: true, force: true });
		return failedHandle(opts, sessionId, `claude-print setup failed: ${errorMessage(error)}`);
	}

	const spawnImpl = opts.spawnImpl ?? spawn;
	const bin = opts.binPath ?? DEFAULT_CLAUDE_PRINT_BIN;
	const graceMs = opts.graceMs ?? CLAUDE_PRINT_ABORT_GRACE_MS;
	const killProcessGroup = opts.killProcessGroup ?? ((pid: number, signal: NodeJS.Signals) => process.kill(-pid, signal));
	const spawnedAt = Date.now();
	let child: ChildProcess;
	try {
		child = spawnImpl(bin, args, { detached: true, stdio: ["pipe", "pipe", "pipe"], env });
	} catch (error) {
		rmSync(invocationDir, { recursive: true, force: true });
		return failedHandle(opts, sessionId, `claude-print spawn failed: ${errorMessage(error)}`);
	}

	let aborted = false;
	let settled = false;
	let submitted = false;
	let startupError: string | undefined;
	let streamError = false;
	let terminating = false;
	let lastSignalSent: NodeJS.Signals | undefined;
	let pollTimer: NodeJS.Timeout | undefined;
	let deadlineTimer: NodeJS.Timeout | undefined;
	let killTimer: NodeJS.Timeout | undefined;
	let resolveDone!: (result: ClaudePDoneResult) => void;
	const done = new Promise<ClaudePDoneResult>((resolveDoneValue) => { resolveDone = resolveDoneValue; });
	const stderrTail: string[] = [];
	let stderrFile: string | undefined;
	let stderrFileFailed = false;

	const clearTimers = () => {
		if (pollTimer) clearTimeout(pollTimer);
		if (deadlineTimer) clearTimeout(deadlineTimer);
		if (killTimer) clearTimeout(killTimer);
		pollTimer = deadlineTimer = killTimer = undefined;
	};

	const signalGroup = (signal: NodeJS.Signals) => {
		if (child.pid === undefined) return;
		lastSignalSent = signal;
		try {
			killProcessGroup(child.pid, signal);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
				logger.warn?.({ event: "claudePrint.lifecycle.signalFailed", signal, error: errorMessage(error) }, "claude-print process-group signal failed");
			}
		}
	};

	const terminate = () => {
		if (terminating || settled) return;
		terminating = true;
		(child.stdin as Writable | null)?.destroy();
		signalGroup("SIGINT");
		killTimer = setTimeout(() => {
			if (!settled) signalGroup("SIGKILL");
		}, graceMs);
		killTimer.unref?.();
	};

	const emitStartupError = (message: string) => {
		if (startupError || aborted || settled) return;
		startupError = message;
		opts.onEvent({ kind: "error", errorMessage: message });
		logger.error?.({ event: "claudePrint.lifecycle.preSubmitError", message }, message);
		terminate();
	};

	const parser = new ClaudePrintStreamParser({
		onEvent: (event) => {
			if (event.kind === "error" && !aborted) {
				streamError = true;
				queueMicrotask(terminate);
			}
			opts.onEvent(event);
		},
		logger,
		onToolUseBatch: opts.onToolUseBatch,
		onTurnAccepted: () => opts.onPhase?.("turnAccepted"),
		onTerminalRecord: () => {
			(child.stdin as Writable | null)?.end();
		},
	});

	child.stdout?.on("data", (chunk: Buffer | string) => {
		if (!aborted && !startupError) parser.write(chunk);
	});
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", (chunk: string) => {
		for (const line of chunk.split("\n")) if (line) stderrTail.push(line);
		while (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
		if (opts.diagnosticsDir && !stderrFileFailed) {
			try {
				mkdirSync(opts.diagnosticsDir, { recursive: true, mode: 0o700 });
				stderrFile ??= join(opts.diagnosticsDir, `claude-print-stderr-${sessionId.slice(0, 8)}-${child.pid ?? "x"}-${Date.now()}.log`);
				appendFileSync(stderrFile, chunk);
			} catch (error) {
				stderrFileFailed = true;
				logger.warn?.({ event: "claudePrint.lifecycle.stderrFileFailed", error: errorMessage(error) }, "claude-print stderr diagnostics write failed");
			}
		}
	});

	const settle = (code: number | null, signal: NodeJS.Signals | null) => {
		if (settled) return;
		settled = true;
		clearTimers();
		let stopReason: ClaudePDoneResult["stopReason"];
		if (aborted) {
			parser.endOfStream({ aborted: true, exitInfo: { code, signal } });
			stopReason = "aborted";
		} else if (startupError) {
			stopReason = "error";
		} else if (!submitted) {
			const message = `claude-print process exited before MCP readiness and prompt submission (exit=${code ?? "null"}, signal=${signal ?? "null"})`;
			opts.onEvent({ kind: "error", errorMessage: message });
			stopReason = "error";
		} else {
			const outcome = parser.endOfStream({
				exitInfo: { code, signal },
				stderrTail: stderrTail.length > 0 ? stderrTail.join("\n") : undefined,
			});
			stopReason = outcome.kind === "result" && !streamError ? "result" : "error";
		}
		// Process leader may exit before its MCP shim descendants. Final group reap
		// closes that orphan window on success, startup failure, and caller abort.
		if (lastSignalSent !== "SIGKILL") signalGroup("SIGKILL");
		try { rmSync(invocationDir!, { recursive: true, force: true }); }
		catch (error) { logger.warn?.({ event: "claudePrint.lifecycle.cleanupFailed", error: errorMessage(error) }, "claude-print private artifact cleanup failed"); }
		opts.onPhase?.("terminal");
		resolveDone({ stopReason, sessionId, exitCode: code, signal });
	};

	child.on("error", (error: NodeJS.ErrnoException) => {
		if (!aborted) {
			const message = error.code === "ENOENT"
				? `claude-print binary not found: "${bin}" (ENOENT)`
				: `claude-print spawn failed: ${errorMessage(error)}`;
			if (!startupError) opts.onEvent({ kind: "error", errorMessage: message });
			startupError ??= message;
		}
		settle(null, null);
	});
	child.on("close", settle);

	const submitPrompt = async () => {
		if (settled || aborted || startupError || submitted) return;
		const stdin = child.stdin;
		if (!stdin || stdin.destroyed || !stdin.writable) {
			emitStartupError("claude-print stdin closed before prompt submission");
			return;
		}
		try {
			await new Promise<void>((resolveWrite, rejectWrite) => {
				let callbackDone = false;
				let drainDone = true;
				const finish = () => { if (callbackDone && drainDone) resolveWrite(); };
				const accepted = stdin.write(userFrame(prompt!), (error) => {
					if (error) rejectWrite(error);
					else { callbackDone = true; finish(); }
				});
				// Once write() accepts bytes, attempt crossed persistence-safety
				// submission boundary even if kernel backpressure is still draining.
				submitted = true;
				opts.onPhase?.("promptSubmitted");
				if (!accepted) {
					drainDone = false;
					stdin.once("drain", () => { drainDone = true; finish(); });
				}
			});
			if (settled || aborted || startupError) return;
			logger.debug?.({ event: "claudePrint.lifecycle.promptSubmitted", sessionId: sessionId.slice(0, 8) }, "claude-print user frame submitted after MCP readiness");
		} catch (error) {
			emitStartupError(`claude-print user frame submission failed: ${errorMessage(error)}`);
		}
	};

	const pollReady = () => {
		if (settled || aborted || startupError || submitted) return;
		try {
			if (sentinelIsExactlyReady(readyFile!)) {
				if (deadlineTimer) clearTimeout(deadlineTimer);
				deadlineTimer = undefined;
				opts.onPhase?.("ready");
				void submitPrompt();
				return;
			}
		} catch (error) {
			emitStartupError(`claude-print readiness sentinel invalid: ${errorMessage(error)}`);
			return;
		}
		pollTimer = setTimeout(pollReady, READY_POLL_MS);
		pollTimer.unref?.();
	};

	const remaining = Math.max(0, timeoutMs! - (Date.now() - spawnedAt));
	deadlineTimer = setTimeout(() => {
		emitStartupError(`claude-print MCP readiness timed out after ${timeoutMs}ms before prompt submission`);
	}, remaining);
	deadlineTimer.unref?.();
	pollReady();

	const abort = () => {
		if (aborted || settled) return;
		aborted = true;
		parser.markLocalAbort();
		logger.info?.({ event: "claudePrint.lifecycle.abort", pid: child.pid }, "aborting claude-print (SIGINT to group)");
		terminate();
	};
	if (opts.signal) {
		if (opts.signal.aborted) queueMicrotask(abort);
		else opts.signal.addEventListener("abort", abort, { once: true });
	}

	return {
		get pid() { return child.pid; },
		abort,
		done,
	};
}
