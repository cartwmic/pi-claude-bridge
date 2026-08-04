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
//     `--settings` would ever be emitted — a defense of tenet T4 (no native
//     Claude tool may be routed, executed, or surfaced to pi).
//   - It does NOT implement bounded-retry / respawn (design D33 / task T1.9a).
//     The seam is deliberate: spawnClaudeP() is cleanly re-invokable, so a thin
//     resilience wrapper can detect a premature `error`-classified exit and call
//     spawnClaudeP() again with a fresh config. See "RESILIENCE SEAM" below.
//   - It NEVER opens any path under `~/.claude/` (tenet T3). It reads no
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

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { join as joinPath } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { DRIVER_DIAGNOSTIC_EVENTS, driverDiagnosticFileName } from "./diagnostics.js";
import type { ClaudeEffort } from "./effort.js";
import {
	ClaudePStreamParser,
	type DriverStreamEvent,
	type DriverToolUseBatch,
	type ResumeDiag,
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
 * This is a DENYLIST; tenet T4 is allowlist-shaped. design D28(ii) flags
 * `--allowedTools mcp__custom-tools__*` as the preferred true-allowlist form IF
 * claude-p honors it (G2). Until G2 proves that, this denylist is the mechanism;
 * the runtime version-skew check (T4.7) must re-audit it against `claude --help`.
 */
export const CLAUDE_P_DISALLOWED_TOOLS: readonly string[] = [
	// Core file/shell/search/web natives.
	"Read",
	"Write",
	"Edit",
	"Bash",
	"Glob",
	"Grep",
	"WebFetch",
	"WebSearch",
	"NotebookEdit",
	// Subagent / planning / skills / tool-search / interaction natives.
	"Agent",
	"Task",
	"Skill",
	"ToolSearch",
	"AskUserQuestion",
	"ReportFindings",
	"SendMessage",
	"EnterPlanMode",
	"ExitPlanMode",
	"EnterWorktree",
	"ExitWorktree",
	// Background-task / scheduling / workflow / cron / notification natives.
	"TodoWrite",
	"TaskCreate",
	"TaskGet",
	"TaskList",
	"TaskUpdate",
	"TaskOutput",
	"TaskStop",
	"BashOutput",
	"Monitor",
	"Workflow",
	"ScheduleWakeup",
	"CronCreate",
	"CronDelete",
	"CronList",
	"PushNotification",
	"RemoteTrigger",
];
// NOTE (G2, 2026-06-01): this set was completed empirically against claude
// 2.1.159 — the prior list leaked 11 natives (Cron*, *Worktree, NotebookEdit,
// Task{Create,Get,List,Update}, Workflow) into the model-facing `system/init`
// roster, plus PushNotification/RemoteTrigger in some environments. With the
// full set the roster closes to EXACTLY `mcp__custom-tools__*` (proven via raw
// `claude -p` introspection; claude-p does not surface a roster line). The exact
// native set is version- AND environment-dependent, so this denylist is
// structurally fragile: T4.7 MUST re-audit it against `claude --help` /
// `system/init` at runtime and warn on drift. An allowlist (`--allowedTools
// mcp__custom-tools__*`) was tested and does NOT close the 2.1.159 roster, so a
// denylist remains the mechanism (design D28). Still subject to the no-`Mcp`
// invariant below — no entry may match the bridged namespace.

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
	/** Pi reasoning level translated to Claude CLI effort. Omitted when thinking is off. → --effort */
	effort?: ClaudeEffort;
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
	 * Optional path for the child `claude`'s own debug log. When set, the driver
	 * forwards `--debug-file <path>` through claude-p's verbatim unknown-flag
	 * passthrough so the child `claude` writes its debug log to this bridge-owned
	 * path (NEVER under `~/.claude/`; tenet T3). Omitted → no flag. This is
	 * the no-liveness-timeouts visibility surface (decision D7). → --debug-file
	 */
	debugFile?: string;
	/**
	 * Optional MCP-readiness sentinel path. The shim creates it once it has served
	 * `tools/list`; claude-p holds the submit Enter until it exists, so the turn
	 * never generates before the bridged tool surface is live. The bridge pairs it
	 * to the router socket (`${socketPath}.ready`). Unlinked per-attempt at spawn
	 * so a stale sentinel from a killed attempt can't let a retry submit early.
	 * → --mcp-ready-file
	 */
	mcpReadyFile?: string;
	/**
	 * Optional write-only PTY-output mirror path (raw bytes, pure tee inside
	 * claude-p). Set by the bridge for MAIN-PROVIDER spawns only, to feed the
	 * read-only peek overlay; capture-path spawns never set it. Strictly
	 * observational — claude-p consumes the flag (never forwarded to claude)
	 * and mirror failures are non-fatal inside the driver.
	 * → --mirror-file
	 */
	mirrorFile?: string;
}

/** Flags this module must NEVER emit (tenet T4 + "never nominal claude -p"). */
const FORBIDDEN_FLAGS: readonly string[] = ["--settings", "-p", "--print"];

/**
 * Assemble the claude-p argument vector from a spawn config. PURE: no I/O, no
 * subprocess, deterministic. Throws if any forbidden flag (`--settings`, `-p`,
 * `--print`) or any `Mcp`/`mcp__*` disallow token would be emitted.
 */
export function buildClaudePArgs(cfg: ClaudePSpawnConfig): string[] {
	const args: string[] = [];

	// --model / --effort
	args.push("--model", cfg.model);
	if (cfg.effort) args.push("--effort", cfg.effort);

	// --system-prompt <text> | --system-prompt-file <path>
	if (cfg.systemPrompt.kind === "text") {
		args.push("--system-prompt", cfg.systemPrompt.text);
	} else {
		args.push("--system-prompt-file", cfg.systemPrompt.path);
	}

	// --mcp-config <inline-json-or-path>
	args.push("--mcp-config", cfg.mcpConfig);

	// --mcp-ready-file <path>: hold the submit Enter until the shim has served
	// tools/list (the tool surface is live). Optional; only the bridge's shim
	// spawns set it. claude-p consumes it (never forwarded to claude).
	if (cfg.mcpReadyFile) {
		args.push("--mcp-ready-file", cfg.mcpReadyFile);
	}

	// --mirror-file <path>: write-only raw PTY output tee for the peek overlay.
	// Optional; main-provider spawns only. claude-p consumes it (never forwarded
	// to claude); open/write failures are non-fatal inside claude-p.
	if (cfg.mirrorFile) {
		args.push("--mirror-file", cfg.mirrorFile);
	}

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

	// --debug-file <path>: forward the child `claude`'s own debug log to a
	// bridge-owned path (claude-p passes unrecognized flags verbatim to claude).
	// No `--timeout` is ever emitted: claude-p runs unlimited (no wall-time
	// ceiling) per the no-liveness-timeouts principle; recovery is caller-driven
	// abort, and a premature exit classifies `error` for the D33 retry gate.
	if (cfg.debugFile) {
		args.push("--debug-file", cfg.debugFile);
	}

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
					`(tenet T4; the bridge never drives nominal claude -p / --print, ` +
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
// Runtime version-skew check (task T4.7)
// ---------------------------------------------------------------------------
//
// On the FIRST spawn (cached per process), read the `claude` CLI version AND the
// claude-p package version and warn — once, via the structured logger — if either
// is outside the README-pinned tested range. This is an OBSERVABILITY guard, not a
// gate: a skew warning never blocks a spawn. The disallow-list closure
// (CLAUDE_P_DISALLOWED_TOOLS) is the *.159-specific empirical native set, so a
// `claude` version drift is the signal to re-audit it (README "Maintenance").
//
// HARD CONSTRAINT (spec "MUST NOT fail to load if either binary is absent"): the
// version readers NEVER throw — they return null on any failure (binary missing,
// non-zero exit, parse miss). A missing binary surfaces as a real error at the
// first TURN (via the child `error` ENOENT path in spawnClaudeP), never here and
// never at module import. The check is therefore safe to run unconditionally on
// the first spawn.

/** The `claude` CLI version this bridge's disallow-list + flag set was tested against. */
export const TESTED_CLAUDE_VERSION = "2.1.159";
/** The `claude-p` package version this bridge's driver/stream parsing was tested against. */
export const TESTED_CLAUDE_P_VERSION = "0.1.0";
/**
 * The patch-identity marker the bridge REQUIRES on its `claude-p` dependency
 * (the `cartwmic/claude-p` fork's package.json `claudePPatch`). Its absence means
 * the resolved binary is stock upstream `claude-p` — the echo-confirm input fix
 * is NOT present and the StopTimeout/"hang" under concurrent-boot contention is
 * re-exposed. See change `fork-claude-p-echo-confirm-input`.
 */
export const EXPECTED_CLAUDE_P_PATCH = "echo-confirm-input";

/**
 * Pluggable version readers (injected by tests; default to the real probes). Each
 * returns the parsed semver-ish string, or `null` if it could not be read for ANY
 * reason. Readers MUST NOT throw — a missing/broken binary is a `null`, surfaced as
 * a real spawn error at first turn, not a load-time crash.
 */
export interface VersionReaders {
	/** Read the `claude` CLI version (e.g. "2.1.159") or null. */
	readClaudeVersion(): string | null;
	/** Read the `claude-p` package version (e.g. "0.1.0") or null. */
	readClaudePVersion(): string | null;
	/** Read the fork's patch-identity marker (package.json `claudePPatch`) or null. */
	readClaudePPatch(): string | null;
}

/** Default real reader: `claude --version` → "2.1.159 (Claude Code)" → "2.1.159". */
function defaultReadClaudeVersion(): string | null {
	try {
		const out = execFileSync("claude", ["--version"], {
			encoding: "utf8",
			timeout: 15_000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		return parseSemverPrefix(out);
	} catch {
		// ENOENT (missing), non-zero exit, timeout — all collapse to "unknown".
		return null;
	}
}

/**
 * Process-cached installed `claude` version (read once, lazily) for the
 * warm-pi-resume sidecar's version gate. Returns the MAJOR.MINOR.PATCH string or
 * null if unreadable. Cached because it is consulted on every persist/resume and
 * the installed version is stable within a process (a `claude` upgrade is a
 * cross-restart event, which the version gate is designed to catch).
 */
let _installedClaudeVersion: string | null | undefined;
export function getInstalledClaudeVersion(): string | null {
	if (_installedClaudeVersion === undefined) _installedClaudeVersion = defaultReadClaudeVersion();
	return _installedClaudeVersion;
}

/** TEST-ONLY: clear the cached installed-claude-version. */
export function __resetInstalledClaudeVersionForTests(): void {
	_installedClaudeVersion = undefined;
}

/** Default real reader: claude-p package version from its package.json (no spawn). */
function defaultReadClaudePVersion(): string | null {
	try {
		const req = createRequire(import.meta.url);
		const pkg = req("claude-p/package.json") as { version?: unknown };
		return typeof pkg.version === "string" ? parseSemverPrefix(pkg.version) : null;
	} catch {
		return null;
	}
}

/** Default real reader: the fork's patch marker from claude-p/package.json (no spawn). */
function defaultReadClaudePPatch(): string | null {
	try {
		const req = createRequire(import.meta.url);
		const pkg = req("claude-p/package.json") as { claudePPatch?: unknown };
		return typeof pkg.claudePPatch === "string" ? pkg.claudePPatch : null;
	} catch {
		return null;
	}
}

const DEFAULT_VERSION_READERS: VersionReaders = {
	readClaudeVersion: defaultReadClaudeVersion,
	readClaudePVersion: defaultReadClaudePVersion,
	readClaudePPatch: defaultReadClaudePPatch,
};

/** Extract the leading `MAJOR.MINOR.PATCH` from arbitrary version output, or null. */
function parseSemverPrefix(s: string): string | null {
	const m = /\b(\d+\.\d+\.\d+)\b/.exec(s);
	return m ? m[1] : null;
}

/** Process-wide cache: the version check runs exactly once per process (cached-once). */
let _versionCheckDone = false;

/** TEST-ONLY: reset the cached-once guard so a unit test can re-exercise the check. */
export function __resetVersionCheckForTests(): void {
	_versionCheckDone = false;
}

/**
 * Read both versions and warn (once, structured) on skew from the pinned tested
 * range. Idempotent across the process: only the FIRST call does any work; later
 * calls are no-ops (cached-once). Never throws. Readers are injectable for tests;
 * the default readers probe the real `claude` CLI and the `claude-p` package.
 *
 * @returns the versions it observed on the first call (`{claude, claudeP}`, each
 *   possibly null), or `null` on every subsequent call (already ran this process).
 */
export function checkClaudePVersionsOnce(
	logger: ClaudePLogger | undefined,
	readers: VersionReaders = DEFAULT_VERSION_READERS,
): { claude: string | null; claudeP: string | null; claudePPatch: string | null } | null {
	if (_versionCheckDone) return null;
	_versionCheckDone = true;

	const log = logger ?? NOOP;
	const claude = readers.readClaudeVersion();
	const claudeP = readers.readClaudePVersion();
	const claudePPatch = readers.readClaudePPatch();

	// Patch-identity check: the bridge depends on the cartwmic/claude-p fork whose
	// echo-confirm input patch fixes the StopTimeout "hang". An absent/wrong marker
	// means we resolved STOCK upstream claude-p and the fix is inactive — warn loudly
	// rather than silently re-expose the wedge under concurrent-boot contention.
	if (claudePPatch !== EXPECTED_CLAUDE_P_PATCH) {
		log.warn(
			{
				event: "claudeP.patch.missing",
				expected: EXPECTED_CLAUDE_P_PATCH,
				observed: claudePPatch,
			},
			`claude-p is NOT the expected patched fork (claudePPatch observed=` +
				`${claudePPatch ?? "absent"} expected=${EXPECTED_CLAUDE_P_PATCH}). The echo-confirm ` +
				`input fix is INACTIVE — the StopTimeout/"hang" under concurrent-boot contention ` +
				`is re-exposed. Reinstall the fork (github:cartwmic/claude-p) with Zig 0.15.2 ` +
				`available. This is a warning, not a failure.`,
		);
	}

	// A null version means "couldn't read it" — NOT a skew. We don't warn on null
	// here: a genuinely missing binary becomes a real error at the first turn (the
	// spawn's ENOENT path), and a transient probe miss shouldn't cry wolf. We DO
	// warn when we read a version that differs from the pinned tested one.
	const claudeSkew = claude !== null && claude !== TESTED_CLAUDE_VERSION;
	const claudePSkew = claudeP !== null && claudeP !== TESTED_CLAUDE_P_VERSION;

	if (claudeSkew || claudePSkew) {
		log.warn(
			{
				event: "claudeP.version.skew",
				claude: { observed: claude, tested: TESTED_CLAUDE_VERSION, skew: claudeSkew },
				claudeP: { observed: claudeP, tested: TESTED_CLAUDE_P_VERSION, skew: claudePSkew },
			},
			`claude-p driver running outside its tested version range ` +
				`(claude observed=${claude ?? "unknown"} tested=${TESTED_CLAUDE_VERSION}; ` +
				`claude-p observed=${claudeP ?? "unknown"} tested=${TESTED_CLAUDE_P_VERSION}). ` +
				`Re-audit CLAUDE_P_DISALLOWED_TOOLS + flag set against \`claude --help\` ` +
				`(see README "Maintenance"). This is a warning, not a failure.`,
		);
	}

	return { claude, claudeP, claudePPatch };
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
	/** Completed bridged observation batch for D32 correlation. */
	onToolUseBatch?: (batch: DriverToolUseBatch) => void;
	/** Logger. Needs warn (parser) + info/error (lifecycle); all optional. */
	logger?: ClaudePLogger;
	/** Override the binary path (tests point this at a node stand-in). */
	binPath?: string;
	/** Child working directory. Capture passes isolated os.tmpdir(); main inherits. */
	cwd?: string;
	/** Optional external abort signal; aborting it is equivalent to handle.abort(). */
	signal?: AbortSignal;
	/** Override the abort grace window (ms) — tests use a tight value. */
	graceMs?: number;
	/**
	 * Warm-resume RE-ECHO suppression (G5). When true, the parser emits ONLY the
	 * live turn (final segment after the last user-prompt line), discarding the
	 * replayed transcript prefix claude-p drains on `--resume`. Default/false → no
	 * suppression (fresh turns unaffected). See
	 * ClaudePStreamParserOptions.suppressResumeReplay. Only set on warm-resume turns.
	 */
	suppressResumeReplay?: boolean;
	/**
	 * The prompt text the bridge sent for this turn (warm-resume only). Detection-only:
	 * forwarded to the parser for the stale-turn diagnostic (does the live prompt
	 * actually appear in the resumed stream?). Never affects delivery. See ResumeDiag.
	 */
	livePromptText?: string;
	/**
	 * Diagnostics directory (driver-diagnostics). WHERE set, the driver writes the
	 * child's stderr to a per-spawn file `claude-p-stderr-<sid8>-<pid>-<ts>.log`
	 * under this dir (bridge-owned; NEVER under `~/.claude/`). Unset → stderr is
	 * kept only in a bounded in-memory tail (used for the premature error message),
	 * no file is written. Best-effort: a write failure never crashes the turn.
	 */
	diagnosticsDir?: string;
	/**
	 * Held-round predicate for the in-flight state dump (driver-diagnostics). The
	 * bridge wires this to `frame.pendingResolvers.size > 0`; the capture path
	 * leaves it unset (never held). Consulted once at terminal settle on an
	 * abnormal exit. Detection-only; never affects control flow.
	 */
	isHeldRound?: () => boolean;
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
 * Detection-only (2026-06-04): when a warm-resume turn looks stale (claude-p replayed
 * but no live prompt followed — the live turn never ran and the terminal `result`
 * reflects the replayed state), dump the spawn's raw stdout + the diagnostic so the
 * exact stale stream can be inspected and the fix validated. Dir override:
 * CLAUDE_P_STALE_DIAG_DIR (default <tmpdir>/claude-p-stale-diag). Never throws.
 */
function writeStaleDiag(
	logger: ClaudePLogger,
	sessionId: string,
	pid: number | undefined,
	diag: ResumeDiag,
	raw: string,
): void {
	try {
		const dir = process.env.CLAUDE_P_STALE_DIAG_DIR || joinPath(homedir(), ".pi", "agent", "claude-p-stale-diag");
		mkdirSync(dir, { recursive: true });
		const file = joinPath(dir, `stale-resume-${sessionId}-${pid ?? "x"}-${Date.now()}.txt`);
		writeFileSync(file, JSON.stringify({ sessionId, pid, ...diag }) + "\n" + raw);
		logger.warn?.(
			{ event: "claudeP.resume.staleDiagWritten", file, ...diag },
			`resume-diag: STALE warm-resume suspected — raw stream dumped to ${file}`,
		);
	} catch (err) {
		logger.warn?.(
			{ event: "claudeP.resume.staleDiagWriteFailed", err: errMessage(err) },
			"resume-diag: failed to write stale diag (ignored)",
		);
	}
}

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

	// Per-attempt: clear any stale MCP-readiness sentinel so a retry can't submit
	// against the PREVIOUS (killed) attempt's file. This spawn's shim re-creates
	// it once it serves tools/list. Best-effort; never throws.
	if (cfg.mcpReadyFile) {
		try {
			rmSync(cfg.mcpReadyFile, { force: true });
		} catch {
			/* ignore — claude-p just waits the full budget if a stale file lingers */
		}
	}

	// First-spawn-only version-skew check (T4.7). Cached per process; never throws;
	// a missing binary is surfaced as a real error below (child `error`), not here.
	checkClaudePVersionsOnce(logger);

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
	// Detection-only (2026-06-04): buffer raw stdout so a stale warm-resume turn's
	// exact stream can be dumped for RCA. Capped; never parsed from here.
	let rawBuf = "";
	const RAW_CAP = 2_000_000;

	// ── Visibility: in-flight state + child stderr capture (driver-diagnostics) ──
	// `lastDeltaAt` = epoch ms of the last forwarded stream event (sign of life),
	// for the abnormal-termination state dump. Bounded stderr ring feeds the
	// premature error message; the full stderr is teed to a per-spawn file.
	let lastDeltaAt = Date.now();
	const STDERR_TAIL_LINES = 20;
	const stderrTail: string[] = [];
	let stderrFile: string | undefined;
	let stderrFileFailed = false;

	const parser = new ClaudePStreamParser({
		onEvent: (event: DriverStreamEvent) => {
			lastDeltaAt = Date.now();
			if (event.kind === "done" && event.reason === "result") sawResult = true;
			opts.onEvent(event);
		},
		logger,
		onToolUseBatch: opts.onToolUseBatch,
		suppressResumeReplay: opts.suppressResumeReplay,
		livePromptText: opts.livePromptText,
		onResumeDiag: (diag: ResumeDiag) => {
			logger.info?.(
				{ event: "claudeP.resume.diag", sessionId: sessionId.slice(0, 8), ...diag },
				`resume-diag: numTurns=${diag.numTurns} promptLines=${diag.promptLineCount} ` +
					`livePromptAfterBoundary=${diag.livePromptAfterBoundary} textMatched=${diag.livePromptTextMatched} ` +
					`staleSuspected=${diag.staleSuspected}`,
			);
			if (diag.staleSuspected || process.env.CLAUDE_P_RAW_DUMP) {
				writeStaleDiag(logger, sessionId, child?.pid, diag, rawBuf);
			}
		},
	});

	// If binPath points at a JS launcher (claude-p ships its bin as bin/claude-p.js),
	// spawn it via the current node executable so resolution does NOT depend on the
	// claude-p bin being on PATH (it lives in node_modules/.bin, which the pi runtime
	// may strip). A bare name or an OS executable is spawned directly. This mirrors how
	// the bridge spawns the shim (node + resolved dist/.../shim.js).
	const isJsLauncher = /\.[cm]?js$/.test(bin);
	const command = isJsLauncher ? process.execPath : bin;
	const spawnArgs = isJsLauncher ? [bin, ...args] : args;

	// detached:true → child becomes a process-group leader (pgid === pid), so a
	// signal to -pid reaches claude-p AND its descendant claude/zmux PTY group.
	const child: ChildProcess = spawn(command, spawnArgs, {
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
		cwd: opts.cwd,
		// Held MCP rounds may legitimately wait indefinitely for caller work.
		env: { ...process.env, CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: "0" },
	});

	const pgid = child.pid; // pgid === pid because detached.

	// ── stdout → parser ───────────────────────────────────────────────────────
	if (child.stdout) {
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			if (rawBuf.length < RAW_CAP) rawBuf += chunk; // detection-only buffer (capped)
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

	// stderr is captured for VISIBILITY (driver-diagnostics), NOT parsed: claude-p's
	// real events come on stdout (NDJSON). We (a) append every chunk to a per-spawn
	// debug file under the bridge diagnostics dir (best-effort; a write failure logs
	// once and never crashes the turn), and (b) keep a bounded tail of the last
	// STDERR_TAIL_LINES lines for the premature-exit error message. We never write
	// stderr onto the child's stdout.
	if (child.stderr) {
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			// (b) bounded tail ring.
			const lines = chunk.split("\n");
			for (const line of lines) {
				if (line.length === 0) continue;
				stderrTail.push(line);
			}
			while (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();

			// (a) per-spawn debug file (lazy-open under diagnosticsDir).
			if (opts.diagnosticsDir && !stderrFileFailed) {
				try {
					if (!stderrFile) {
						mkdirSync(opts.diagnosticsDir, { recursive: true });
						stderrFile = joinPath(
							opts.diagnosticsDir,
							driverDiagnosticFileName("claude-p", "stderr", sessionId, child.pid),
						);
						logger.info?.(
							{ event: DRIVER_DIAGNOSTIC_EVENTS.stderrFile, driver: "claude-p", file: stderrFile },
							`claude-p stderr captured to ${stderrFile}`,
						);
					}
					appendFileSync(stderrFile, chunk);
				} catch (err) {
					stderrFileFailed = true;
					logger.warn?.(
						{ event: DRIVER_DIAGNOSTIC_EVENTS.stderrFileFailed, driver: "claude-p", err: errMessage(err) },
						"claude-p stderr file write failed (ignored; turn continues)",
					);
				}
			}
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

		// VISIBILITY (driver-diagnostics): on abnormal termination (abort or a
		// premature exit with no terminal `result`), emit a single structured
		// in-flight state dump so a future hang is self-diagnosing. A clean `result`
		// exit does not dump. Emitted before endOfStream so the partial buffer length
		// reflects what was still unparsed at termination.
		if (aborted || !sawResult) {
			const now = Date.now();
			logger.warn?.(
				{
					event: DRIVER_DIAGNOSTIC_EVENTS.stateDump,
					driver: "claude-p",
					sessionId: sessionId.slice(0, 8),
					pid: child.pid,
					aborted,
					sawResult,
					lastDeltaEpochMs: lastDeltaAt,
					lastDeltaAgeMs: now - lastDeltaAt,
					heldRound: opts.isHeldRound?.() ?? false,
					partialBufferLen: parser.pendingBufferLength,
					stderrTailLines: stderrTail.length,
				},
				`claude-p in-flight state dump (${aborted ? "abort" : "premature exit"}): ` +
					`lastDeltaAge=${now - lastDeltaAt}ms heldRound=${opts.isHeldRound?.() ?? false} ` +
					`partialBuffer=${parser.pendingBufferLength}B`,
			);
		}

		// Feed the parser the exit context exactly once. When aborted, this
		// suppresses the parser's premature-`error` emission. When NOT aborted and
		// no terminal `result` was seen, the parser emits the `error` event itself.
		// The captured stderr tail is threaded into the premature error message.
		parser.endOfStream({
			aborted,
			exitInfo: { code: exitCode ?? null, signal },
			stderrTail: stderrTail.length > 0 ? stderrTail.join("\n") : undefined,
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
	 * must not be reused). A `resume` id stays stable unless coldRetryConfig
	 * explicitly repacks failed warm input as a fresh canonical replay.
	 */
	freshSessionId?: () => string;
	/**
	 * Repack a failed warm attempt as canonical cold input. When absent, warm
	 * retries retain legacy stable-`--resume` behavior.
	 */
	coldRetryConfig?: (sessionId: string) => ClaudePSpawnConfig;
	/**
	 * Re-mint the peek mirror path for a retry spawn (per-spawn file naming —
	 * claude-peek-overlay.peek-follows-latest-main-turn-spawn-only). Called with
	 * the retry attempt's session id; returns the new mirror path (published as
	 * current by the minting side) or undefined to run the retry unmirrored.
	 * Absent → the retry keeps the previous config's mirrorFile untouched.
	 */
	remintMirrorFile?: (sessionId: string) => string | undefined;
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
		// A failed warm resume may be repacked into one canonical cold prompt.
		// That fresh child emits no resumed transcript, so replay suppression
		// would swallow its live answer.
		const repackedCold = cfg.session.kind === "resume" && spawnCfg.session.kind === "fresh";
		const attemptOpts = repackedCold
			? { ...innerOpts, suppressResumeReplay: false, livePromptText: undefined }
			: innerOpts;
		const handle = spawnClaudeP(spawnCfg, attemptOpts);
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
			// Fresh id on cold retry; warm stays stable unless caller repacks cold.
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

/** Build next attempt: rotate cold ids; optionally repack failed warm resume as cold. */
export function buildRetryConfig(cfg: ClaudePSpawnConfig, policy: ResiliencePolicy): ClaudePSpawnConfig {
	if (cfg.session.kind === "fresh") {
		const sessionId = policy.freshSessionId ? policy.freshSessionId() : cfg.session.sessionId;
		const mirrorFile = policy.remintMirrorFile ? policy.remintMirrorFile(sessionId) : cfg.mirrorFile;
		return { ...cfg, session: { kind: "fresh", sessionId }, mirrorFile };
	}
	if (policy.coldRetryConfig) {
		const sessionId = policy.freshSessionId ? policy.freshSessionId() : cfg.session.sessionId;
		const cold = policy.coldRetryConfig(sessionId);
		const mirrorFile = policy.remintMirrorFile ? policy.remintMirrorFile(sessionId) : cold.mirrorFile;
		return { ...cold, mirrorFile };
	}
	// Legacy caller behavior: stable --resume across retries.
	if (policy.remintMirrorFile) {
		return { ...cfg, mirrorFile: policy.remintMirrorFile(cfg.session.sessionId) };
	}
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
