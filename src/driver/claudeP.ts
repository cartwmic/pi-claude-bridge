// src/driver/claudeP.ts
//
// claude-p subprocess driver (T1.3).
//
// Owns: claude-p flag (argv) assembly, subprocess spawn (in its own process
// group), wiring claude-p stdout into the ClaudePStreamParser (src/driver/
// stream.ts), abort propagation to the process GROUP (SIGINT → grace → SIGKILL),
// orphan reaping, and exit classification (clean turn vs premature/error vs
// aborted).
//
// What this module DELIBERATELY does NOT do:
//   - It does NOT invoke the nominal `claude -p`/`--print` surface. The bridge
//     drives claude-p, which emulates `claude -p` by driving the interactive TUI
//     in its own PTY (design D26). buildClaudePArgs() throws if `-p`/`--print`/
//     `--settings` would ever be emitted (constitution IV defense).
//   - It does NOT implement bounded-retry / respawn (design D33 / task T1.9a).
//     The seam is deliberate: spawnClaudeP() is cleanly re-invokable, so a thin
//     resilience wrapper can detect a premature `error`-classified exit and call
//     spawnClaudeP() again with a fresh config. See "RESILIENCE SEAM" below.
//   - It NEVER opens any path under `~/.claude/` (constitution III). It reads no
//     settings, sessions, transcripts, skills, or plugins. All per-turn
//     observation flows through claude-p's stdout, parsed by ClaudePStreamParser.
//     There is nothing to implement for this guarantee except NOT doing it — this
//     comment is the assertion. (The only filesystem touch this module performs
//     is via the caller-supplied `--input-file`/`--system-prompt-file` paths,
//     which the shim builds under os.tmpdir(), never under ~/.claude/.)
//
// Design anchors: D26 (claude-p driver), D27 (stdout event source), D28
// (--disallowedTools native block), D31 (abort = SIGINT to the process group,
// SIGKILL after grace, orphan reap), D33 (resilience layer — seam only here).

import { spawn, type ChildProcess } from "node:child_process";
import {
	ClaudePStreamParser,
	type DriverStreamEvent,
	type StreamLogger,
} from "./stream.js";

// ---------------------------------------------------------------------------
// Native-tool disallow set (design D28; spec "Native tool emission is blocked")
// ---------------------------------------------------------------------------

/**
 * The native-tool disallow list passed to `claude` via `--disallowedTools`
 * (claude-p forwards it). Every `claude` built-in the bridge must block so the
 * only callable tool surface is the bridged `mcp__custom-tools__*` namespace.
 *
 * CRITICAL — the no-`Mcp` invariant (spec scenario "Disallow list is non-empty"):
 * this list MUST NOT contain any bare `Mcp` / `mcp__*` token. claude matches
 * `--disallowedTools` entries by name prefix, so a bare `Mcp` entry would also
 * match the bridge's OWN `mcp__custom-tools__*` surface and suppress it — which
 * would deadlock every tool round (the model has no callable tools left). The
 * held-open MCP surface MUST survive the disallow set. The legacy SDK-era
 * `DISALLOWED_BUILTIN_TOOLS` in index.ts DOES include "Mcp" (it was safe there
 * because the SDK allow-listed the bridged server separately); for the claude-p
 * path we deliberately drop it. A test asserts the absence of any mcp token.
 *
 * This is a DENYLIST; constitution IV is allowlist-shaped. design D28(ii) flags
 * `--allowedTools mcp__custom-tools__*` as the preferred true-allowlist form IF
 * claude-p honors it (G2). Until G2 proves that, this denylist is the mechanism;
 * the runtime version-skew check (T4.7) must re-audit it against `claude --help`.
 */
export const CLAUDE_P_DISALLOWED_TOOLS: readonly string[] = [
	"Read",
	"Write",
	"Edit",
	"Bash",
	"Glob",
	"Grep",
	"Agent",
	"WebFetch",
	"WebSearch",
	"TodoWrite",
	"EnterPlanMode",
	"ExitPlanMode",
	"Skill",
	"ToolSearch",
	"AskUserQuestion",
	"ScheduleWakeup",
	"TaskOutput",
	"TaskStop",
	"BashOutput",
	"Monitor",
];

/**
 * The exact `--disallowedTools` VALUE format.
 *
 * `claude --help` documents: `--disallowedTools <tools...>` — "Comma or
 * space-separated list of tool names to deny (e.g. \"Bash(git *) Edit\")". The
 * documented example is a SINGLE space-separated argv token, so we join the
 * disallow set with a single space and pass it as ONE argv element. This avoids
 * any ambiguity about whether claude-p forwards a variadic correctly.
 *
 * G2-VERIFICATION ITEM: this format is taken from raw `claude --help`; it is NOT
 * yet proven that claude-p forwards a space-joined single-token `--disallowedTools`
 * value to `claude` and that `claude` honors it through claude-p. Gate G2 must
 * confirm (a) the format is accepted end-to-end and (b) emission is actually
 * refused (not merely absent from `tools/list`). If the space-joined form is not
 * honored, the alternatives are comma-joined or repeated `--disallowedTools`
 * flags — both also documented; switch the format here and re-run G2.
 */
export const DISALLOWED_TOOLS_VALUE: string = CLAUDE_P_DISALLOWED_TOOLS.join(" ");

// ---------------------------------------------------------------------------
// Argv assembly config + builder (PURE)
// ---------------------------------------------------------------------------

/** System-prompt delivery: inline text XOR a file path. */
export type SystemPromptSource =
	| { kind: "text"; text: string }
	| { kind: "file"; path: string };

/** User-prompt delivery: positional argv arg XOR an --input-file path. */
export type PromptSource =
	| { kind: "positional"; text: string }
	| { kind: "file"; path: string };

/** Session identity: fresh turn (new uuid) XOR warm resume (cached id). NEVER both. */
export type SessionMode =
	| { kind: "fresh"; sessionId: string }
	| { kind: "resume"; sessionId: string };

/**
 * Everything buildClaudePArgs() needs to assemble the claude-p argv. Pure data;
 * the shim/caller resolves the tmpfile paths, the mcp-config pointer, and the
 * derived timeout BEFORE constructing this — argv assembly does no I/O.
 */
export interface ClaudePSpawnConfig {
	/** Resolved model id, e.g. "claude-sonnet-4-6". → --model */
	model: string;
	/** System prompt content (inline) or file path. → --system-prompt | --system-prompt-file */
	systemPrompt: SystemPromptSource;
	/** User prompt content (positional) or file path. → positional arg | --input-file */
	prompt: PromptSource;
	/**
	 * The `--mcp-config` value: inline JSON string OR a path to a JSON file. The
	 * bridge builds the stdio-MCP-shim pointer at the shim layer; argv assembly
	 * just places it verbatim. → --mcp-config
	 */
	mcpConfig: string;
	/** Session identity (fresh XOR resume). → --session-id | --resume */
	session: SessionMode;
	/**
	 * Per-spawn wall-clock timeout in SECONDS (the bridge derives it large enough
	 * to survive the longest held tool round; see spec "--timeout must not trip on
	 * a held tool round"). → --timeout
	 */
	timeoutSeconds: number;
}

/** Flags this module must NEVER emit (constitution IV + "never nominal claude -p"). */
const FORBIDDEN_FLAGS: readonly string[] = ["--settings", "-p", "--print"];

/**
 * Assemble the claude-p argument vector from a spawn config. PURE: no I/O, no
 * subprocess, deterministic. Throws if any forbidden flag (`--settings`, `-p`,
 * `--print`) or any `Mcp`/`mcp__*` disallow token would be emitted.
 */
export function buildClaudePArgs(cfg: ClaudePSpawnConfig): string[] {
	const args: string[] = [];

	// --model
	args.push("--model", cfg.model);

	// --system-prompt <text> | --system-prompt-file <path>
	if (cfg.systemPrompt.kind === "text") {
		args.push("--system-prompt", cfg.systemPrompt.text);
	} else {
		args.push("--system-prompt-file", cfg.systemPrompt.path);
	}

	// --mcp-config <inline-json-or-path>
	args.push("--mcp-config", cfg.mcpConfig);

	// --disallowedTools <space-joined native list> (single argv token; see format note)
	args.push("--disallowedTools", DISALLOWED_TOOLS_VALUE);

	// Isolation: block user-global MCP servers + ignore user/project/local settings.
	args.push("--strict-mcp-config");
	args.push("--setting-sources", ""); // empty-string "load nothing" form (D28; G2/T0.7)

	// No interactive permission dialogs (a PTY-driven session can't answer them).
	args.push("--permission-mode", "bypassPermissions");

	// --session-id <uuid> (fresh) XOR --resume <id> (warm) — never both.
	if (cfg.session.kind === "fresh") {
		args.push("--session-id", cfg.session.sessionId);
	} else {
		args.push("--resume", cfg.session.sessionId);
	}

	// Streaming: newline-delimited stream-json on stdout (requires --verbose).
	args.push("--output-format", "stream-json");
	args.push("--verbose");

	// --timeout <seconds>
	args.push("--timeout", String(cfg.timeoutSeconds));

	// User prompt: positional arg XOR --input-file <path>. Positional goes LAST so
	// it cannot be mistaken for a flag value.
	if (cfg.prompt.kind === "file") {
		args.push("--input-file", cfg.prompt.path);
	}

	// ── Guards (defense, not flow control) ──────────────────────────────────────
	// 1. Never emit --settings / -p / --print.
	for (const forbidden of FORBIDDEN_FLAGS) {
		if (args.includes(forbidden)) {
			throw new Error(
				`buildClaudePArgs: refusing to emit forbidden flag "${forbidden}" ` +
					`(constitution IV; the bridge never drives nominal claude -p / --print, ` +
					`and claude-p reserves --settings)`,
			);
		}
	}
	// 2. The --disallowedTools value must not contain any Mcp / mcp__ token that
	//    would suppress the bridge's own mcp__custom-tools__* surface.
	if (/\bmcp(__|\b)/i.test(DISALLOWED_TOOLS_VALUE)) {
		throw new Error(
			`buildClaudePArgs: --disallowedTools must not contain any "Mcp"/"mcp__" ` +
				`token — it would suppress the bridged mcp__custom-tools__* surface and ` +
				`deadlock every tool round`,
		);
	}

	// Append the positional prompt AFTER the guards (it is user content, not a flag,
	// and must not be scanned by the forbidden-flag guard).
	if (cfg.prompt.kind === "positional") {
		args.push(cfg.prompt.text);
	}

	return args;
}

// ---------------------------------------------------------------------------
// Spawn lifecycle
// ---------------------------------------------------------------------------

/** Default binary the driver spawns (overridable via opts.binPath for tests). */
export const DEFAULT_CLAUDE_P_BIN = "claude-p";

/**
 * Grace window (ms) between SIGINT and the escalation SIGKILL to the process
 * group on abort (design D31). Implementation-defined; generous enough for
 * claude-p to tear down its own PTY + child `claude` after SIGINT, short enough
 * that the next turn isn't delayed. Exported so the resilience layer / tests can
 * reference it.
 */
export const ABORT_SIGKILL_GRACE_MS = 2000;

/** Why a spawn's `done` promise resolved. */
export type ClaudePStopReason = "result" | "aborted" | "error";

export interface ClaudePDoneResult {
	/**
	 *  - "result"  : clean turn-end — parser saw the terminal `result` line.
	 *  - "aborted" : abort() / AbortSignal fired; exit classification suppressed.
	 *  - "error"   : premature/unexpected exit (incl. ENOENT missing binary).
	 */
	stopReason: ClaudePStopReason;
	/** The session id this spawn ran with (fresh or resumed) — for cache bookkeeping. */
	sessionId: string;
	/** Subprocess exit code, if it exited normally. */
	exitCode?: number | null;
	/** Subprocess terminating signal, if any. */
	signal?: NodeJS.Signals | null;
}

export interface SpawnClaudePOptions {
	/** Sink for parsed driver-internal stream events (forwarded from the parser). */
	onEvent: (event: DriverStreamEvent) => void;
	/** Logger. Needs warn (parser) + info/error (lifecycle); all optional. */
	logger?: ClaudePLogger;
	/** Override the binary path (tests point this at a node stand-in). */
	binPath?: string;
	/** Optional external abort signal; aborting it is equivalent to handle.abort(). */
	signal?: AbortSignal;
	/** Override the abort grace window (ms) — tests use a tight value. */
	graceMs?: number;
}

export interface ClaudePLogger extends StreamLogger {
	info?(...args: unknown[]): void;
	error?(...args: unknown[]): void;
}

/** The driver handle index.ts (T1.9) drives per turn. */
export interface ClaudePHandle {
	/** OS pid of the spawned claude-p process (also the process-GROUP id, since detached). */
	readonly pid: number | undefined;
	/**
	 * Abort the in-flight turn: SIGINT the process GROUP, mark aborted (so exit
	 * classification treats termination as expected), stop reading stdout, and
	 * escalate to SIGKILL of the group after the grace window if it has not exited.
	 * Idempotent. Per the spec's "Abort lifecycle decoupled" requirement the
	 * `done` promise resolves with stopReason "aborted" promptly — it does NOT wait
	 * for a terminal `result`, and any late stdout is ignored.
	 */
	abort(): void;
	/** Resolves once when the turn terminates (clean / aborted / error). Never rejects. */
	readonly done: Promise<ClaudePDoneResult>;
}

const NOOP: ClaudePLogger = { warn() {}, info() {}, error() {} };

/**
 * Spawn claude-p for one pi turn and return a handle. The subprocess runs in its
 * OWN process group (`detached: true`) so abort can SIGINT/SIGKILL the whole
 * group, reaping claude-p's child `claude`/zmux PTY (design D31; orphan invariant
 * S8). stdout is piped into a ClaudePStreamParser; its events are forwarded via
 * opts.onEvent. On child exit/close the parser's endOfStream() is called exactly
 * once and the `done` promise resolves.
 *
 * RESILIENCE SEAM (design D33 / task T1.9a): this function is cleanly
 * re-invokable. A bounded-retry wrapper detects a `done` whose stopReason is
 * "error" (and for which no `tools/call` was routed to pi — that gate lives in
 * the wrapper, not here) and simply calls spawnClaudeP() again with a fresh
 * config (fresh --session-id on cold, --resume on warm). This module intentionally
 * implements NO retry so the wrapper owns the side-effect-aware idempotency gate.
 */
export function spawnClaudeP(cfg: ClaudePSpawnConfig, opts: SpawnClaudePOptions): ClaudePHandle {
	const logger: ClaudePLogger = opts.logger ?? NOOP;
	const bin = opts.binPath ?? DEFAULT_CLAUDE_P_BIN;
	const graceMs = opts.graceMs ?? ABORT_SIGKILL_GRACE_MS;
	const sessionId = cfg.session.sessionId;

	let args: string[];
	try {
		args = buildClaudePArgs(cfg);
	} catch (err) {
		// Argv-assembly guard tripped (forbidden flag / mcp token). Surface as an
		// error event + resolved done, mirroring a spawn failure (never throw to
		// the caller — keep the lifecycle uniform).
		return makeFailedHandle(opts, sessionId, errMessage(err));
	}

	// ── State ───────────────────────────────────────────────────────────────────
	let aborted = false;
	let settled = false;
	let killTimer: NodeJS.Timeout | undefined;
	let resolveDone!: (r: ClaudePDoneResult) => void;
	const done = new Promise<ClaudePDoneResult>((res) => {
		resolveDone = res;
	});

	// Track terminal classification from the event stream itself rather than
	// reaching into the parser's internals: the parser emits exactly one
	// `done`(reason "result") on a clean turn-end and an `error` on premature
	// exit, so wrapping onEvent gives us the parser's observable verdict.
	let sawResult = false;
	const parser = new ClaudePStreamParser({
		onEvent: (event: DriverStreamEvent) => {
			if (event.kind === "done" && event.reason === "result") sawResult = true;
			opts.onEvent(event);
		},
		logger,
	});

	// detached:true → child becomes a process-group leader (pgid === pid), so a
	// signal to -pid reaches claude-p AND its descendant claude/zmux PTY group.
	const child: ChildProcess = spawn(bin, args, {
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
	});

	const pgid = child.pid; // pgid === pid because detached.

	// ── stdout → parser ───────────────────────────────────────────────────────
	if (child.stdout) {
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			if (aborted) {
				// Abort lifecycle is decoupled: ignore late stdout (log at info).
				logger.info?.(
					{ event: "claudeP.lifecycle.lateStdout", bytes: chunk.length },
					"claude-p stdout after abort — ignored",
				);
				return;
			}
			parser.write(chunk);
		});
	}

	// stderr is captured at debug-ish (info) granularity only; claude-p's real
	// events come on stdout. We do NOT parse stderr.
	if (child.stderr) {
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			logger.info?.(
				{ event: "claudeP.lifecycle.stderr", text: chunk.slice(0, 500) },
				"claude-p stderr",
			);
		});
	}

	// ── classify + settle ─────────────────────────────────────────────────────
	const settle = (exitCode: number | null | undefined, signal: NodeJS.Signals | null) => {
		if (settled) return;
		settled = true;
		if (killTimer) {
			clearTimeout(killTimer);
			killTimer = undefined;
		}

		// Feed the parser the exit context exactly once. When aborted, this
		// suppresses the parser's premature-`error` emission. When NOT aborted and
		// no terminal `result` was seen, the parser emits the `error` event itself.
		parser.endOfStream({
			aborted,
			exitInfo: { code: exitCode ?? null, signal },
		});

		// Best-effort orphan reap (D31 / S8): even though we signalled the GROUP,
		// claude-p's PTY child may briefly outlive it. Send a final SIGKILL to the
		// group; ESRCH (no such group) means it's already gone — the success case.
		reapGroup(pgid, logger);

		const stopReason: ClaudePStopReason = aborted
			? "aborted"
			: sawResult
				? "result"
				: "error";

		resolveDone({
			stopReason,
			sessionId,
			exitCode: exitCode ?? null,
			signal,
		});
	};

	// 'error' fires for spawn failures (ENOENT missing binary, EACCES, …). The
	// parser turns endOfStream(aborted=false, no result) into an `error` event; we
	// also push an explicit, binary-naming `error` event so the message references
	// the missing binary (spec scenario "Driver binary missing").
	child.on("error", (err: NodeJS.ErrnoException) => {
		if (!aborted) {
			const msg =
				err.code === "ENOENT"
					? `claude-p binary not found: "${bin}" (ENOENT) — is claude-p installed and on PATH?`
					: `claude-p spawn failed: ${errMessage(err)}`;
			opts.onEvent({ kind: "error", errorMessage: msg });
			logger.error?.({ event: "claudeP.lifecycle.spawnError", code: err.code }, msg);
		}
		// On a spawn error there is no exit; settle directly. Mark resultSeen-state
		// untouched; classification will be "error" (or "aborted").
		settle(null, null);
	});

	// 'close' fires after stdio is fully drained AND the process exited — this is
	// the right moment to finalize (vs 'exit', which may precede stdout drain).
	child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
		settle(code, signal);
	});

	// ── abort ─────────────────────────────────────────────────────────────────
	const abort = () => {
		if (aborted || settled) {
			aborted = aborted || true;
			return;
		}
		aborted = true;
		logger.info?.({ event: "claudeP.lifecycle.abort", pid: child.pid }, "aborting claude-p (SIGINT to group)");

		// Stop reading stdout immediately (decoupled abort lifecycle).
		child.stdout?.removeAllListeners("data");
		child.stdout?.pause?.();

		// SIGINT the process GROUP (negative pgid). claude-p returns 130 and tears
		// down its own PTY + child claude.
		signalGroup(pgid, "SIGINT", logger);

		// Escalate to SIGKILL of the group after the grace window if still alive.
		killTimer = setTimeout(() => {
			if (!settled) {
				logger.info?.(
					{ event: "claudeP.lifecycle.sigkill", pid: child.pid },
					"claude-p did not exit within grace window — SIGKILL to group",
				);
				signalGroup(pgid, "SIGKILL", logger);
			}
		}, graceMs);
		// Don't let the kill timer keep the event loop alive.
		killTimer.unref?.();
	};

	if (opts.signal) {
		if (opts.signal.aborted) {
			// Already aborted before spawn fully wired — abort on next tick so the
			// child has a pid to signal.
			queueMicrotask(abort);
		} else {
			opts.signal.addEventListener("abort", abort, { once: true });
		}
	}

	return {
		get pid() {
			return child.pid;
		},
		abort,
		done,
	};
}

// ---------------------------------------------------------------------------
// Resilience layer (design D33 / task T1.9a)
// ---------------------------------------------------------------------------

/**
 * Policy the resilience wrapper consults; the bridge (index.ts) owns frame
 * state, so it supplies the side-effect-aware idempotency gate via shouldRetry.
 */
export interface ResiliencePolicy {
	/** Max bounded retries after the initial spawn (default 2). */
	maxRetries?: number;
	/**
	 * Whether a retry is permitted at the moment a spawn fails with
	 * stopReason "error". The bridge wires this to `!router.everRoutedToolCall`
	 * — once a tools/call routed to pi, a side-effecting tool may have run and a
	 * respawn+cold-replay would re-execute it (D33). Consulted per-attempt.
	 */
	shouldRetry: () => boolean;
	/** Notified before each retry spawn (attempt is 1-based: the Nth retry). */
	onRetry?: (attempt: number, res: ClaudePDoneResult) => void;
	/**
	 * Mint a fresh session id for a COLD retry. When the config's session is
	 * `fresh`, each retry gets a brand-new id from here (a stale partial session
	 * must not be reused). When the config's session is `resume`, the id is kept
	 * STABLE across retries (the warm transcript is the recovery anchor).
	 */
	freshSessionId?: () => string;
}

/** Backoff between retries: 250ms × attempt. Exported so tests can reason about timing. */
export const RESILIENCE_BACKOFF_MS = 250;

/**
 * Wrap spawnClaudeP() in a bounded-retry loop (design D33). Owns: the retry
 * loop, backoff, abort-during-backoff suppression, and fresh-session-id on a
 * cold retry. It does NOT own the idempotency gate — that is the bridge's
 * `policy.shouldRetry` (which reads `router.everRoutedToolCall`).
 *
 * Returns a ClaudePHandle whose `done` resolves once the (possibly retried)
 * spawn reaches a terminal state. `abort()` aborts the live inner spawn and
 * suppresses any scheduled retry. Events from a failed attempt that DID retry
 * are still forwarded (text streamed before a hook-timeout is harmless); the
 * retry only happens when no tools/call was routed, so no partial pi state is
 * double-committed.
 */
export function spawnClaudePWithResilience(
	cfg: ClaudePSpawnConfig,
	opts: SpawnClaudePOptions,
	policy: ResiliencePolicy,
): ClaudePHandle {
	const maxRetries = policy.maxRetries ?? 2;
	const logger: ClaudePLogger = opts.logger ?? NOOP;

	let aborted = false;
	let outerSettled = false;
	let current: ClaudePHandle | null = null;
	let backoffTimer: NodeJS.Timeout | undefined;
	let lastSessionId = cfg.session.sessionId;
	let resolveDoneRaw!: (r: ClaudePDoneResult) => void;
	const done = new Promise<ClaudePDoneResult>((res) => {
		resolveDoneRaw = res;
	});
	const resolveDone = (r: ClaudePDoneResult) => {
		if (outerSettled) return;
		outerSettled = true;
		resolveDoneRaw(r);
	};

	// External abort signal: fold into our abort() so it both suppresses a
	// scheduled retry AND forwards to the inner handle.
	const externalSignal = opts.signal;
	// We do NOT pass opts.signal down to the inner spawn; we forward aborts
	// ourselves via the inner handle so retry suppression is centralized.
	const innerOpts: SpawnClaudePOptions = { ...opts, signal: undefined };

	const abort = () => {
		if (aborted) return;
		aborted = true;
		if (backoffTimer) {
			// Abort fired while waiting in the backoff window: cancel the
			// scheduled retry and resolve `done` ourselves (no inner spawn is
			// live to drive resolution).
			clearTimeout(backoffTimer);
			backoffTimer = undefined;
			resolveDone({ stopReason: "aborted", sessionId: lastSessionId, exitCode: null, signal: null });
			return;
		}
		// Otherwise an inner spawn is live; aborting it drives `done` via its
		// own done handler (which sees `aborted` and resolves aborted).
		current?.abort();
	};

	if (externalSignal) {
		if (externalSignal.aborted) queueMicrotask(abort);
		else externalSignal.addEventListener("abort", abort, { once: true });
	}

	const launch = (spawnCfg: ClaudePSpawnConfig, attempt: number) => {
		lastSessionId = spawnCfg.session.sessionId;
		const handle = spawnClaudeP(spawnCfg, innerOpts);
		current = handle;
		// If an abort arrived between scheduling and launch, propagate immediately.
		if (aborted) handle.abort();

		void handle.done.then((res) => {
			if (aborted) {
				// Abort wins regardless of how the inner spawn classified itself.
				resolveDone({ ...res, stopReason: "aborted" });
				return;
			}
			const canRetry =
				res.stopReason === "error" && attempt < maxRetries && policy.shouldRetry();
			if (!canRetry) {
				resolveDone(res);
				return;
			}
			const nextAttempt = attempt + 1;
			policy.onRetry?.(nextAttempt, res);
			logger.warn?.(
				{ event: "claudeP.resilience.retry", attempt: nextAttempt, maxRetries, prevStopReason: res.stopReason },
				`claude-p spawn failed (error); retrying (attempt ${nextAttempt}/${maxRetries})`,
			);
			// Fresh session id on cold retry; stable --resume on warm.
			const nextCfg = buildRetryConfig(spawnCfg, policy);
			backoffTimer = setTimeout(() => {
				backoffTimer = undefined;
				if (aborted) {
					// Abort fired during backoff — do NOT spawn a replacement.
					resolveDone({ stopReason: "aborted", sessionId: nextCfg.session.sessionId, exitCode: null, signal: null });
					return;
				}
				launch(nextCfg, nextAttempt);
			}, RESILIENCE_BACKOFF_MS * nextAttempt);
			backoffTimer.unref?.();
		});
	};

	launch(cfg, 0);

	return {
		get pid() {
			return current?.pid;
		},
		abort,
		done,
	};
}

/** Build the next attempt's config: fresh id on cold, stable id on warm. */
function buildRetryConfig(cfg: ClaudePSpawnConfig, policy: ResiliencePolicy): ClaudePSpawnConfig {
	if (cfg.session.kind === "fresh") {
		const sessionId = policy.freshSessionId ? policy.freshSessionId() : cfg.session.sessionId;
		return { ...cfg, session: { kind: "fresh", sessionId } };
	}
	// Warm resume: keep the same --resume id across retries.
	return cfg;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Send a signal to a process GROUP (negative pid). Swallows ESRCH (already gone). */
function signalGroup(pgid: number | undefined, sig: NodeJS.Signals, logger: ClaudePLogger): void {
	if (pgid === undefined) return;
	try {
		process.kill(-pgid, sig);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return; // group already gone — fine.
		// EPERM or other: log, but don't throw (abort must not crash the bridge).
		logger.error?.(
			{ event: "claudeP.lifecycle.signalFailed", sig, code },
			`failed to ${sig} claude-p process group`,
		);
	}
}

/**
 * Best-effort orphan reap (D31 / S8 "no orphan subprocesses"). After the child
 * has closed, deliver a final SIGKILL to the group: if the group is gone we get
 * ESRCH (the expected, healthy case — nothing orphaned). If it succeeds, a
 * descendant (claude/zmux PTY) outlived claude-p and we just reaped it. We log
 * the latter so it's visible. We do NOT poll `ps` here (that's the integration
 * test's job, S8); this is the in-process guarantee.
 */
function reapGroup(pgid: number | undefined, logger: ClaudePLogger): void {
	if (pgid === undefined) return;
	try {
		process.kill(-pgid, "SIGKILL");
		// Reached here → something in the group was still alive and we just killed it.
		logger.info?.(
			{ event: "claudeP.lifecycle.orphanReaped", pgid },
			"reaped surviving claude-p group descendant after exit",
		);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "ESRCH") {
			logger.error?.(
				{ event: "claudeP.lifecycle.reapFailed", pgid, code },
				"orphan reap signal failed",
			);
		}
		// ESRCH = group already fully gone = no orphan. Good.
	}
}

/** Build a handle that resolves immediately to an error (argv-guard failure). */
function makeFailedHandle(
	opts: SpawnClaudePOptions,
	sessionId: string,
	errorMessage: string,
): ClaudePHandle {
	opts.onEvent({ kind: "error", errorMessage });
	return {
		pid: undefined,
		abort() {},
		done: Promise.resolve({ stopReason: "error", sessionId, exitCode: null, signal: null }),
	};
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
