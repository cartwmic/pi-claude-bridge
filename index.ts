// pi-claude-bridge: claude-p driver, pi-canonical, inference-only.
//
// Architecture (see SCENARIOS.md for the full charter):
//   - pi owns conversation history. `claude-p` (an interactive-TUI driver for
//     the `claude` CLI) is the sole inference provider. The bridge NEVER shells
//     out to a nominal `claude -p`; it drives the interactive TUI so the model
//     behaves identically to a human-driven session.
//   - One claude-p spawn spans one pi user-turn (which may include many tool
//     rounds).
//   - Tool execution happens IN PI. Tools are declared to `claude` via a stdio
//     MCP server (the shim) that the bridge spawns; the in-process router holds
//     each `tools/call` open (parks it) until pi delivers the tool result via
//     the next streamSimple() call.
//   - Bridge holds the claude session_id in memory only as a cache hint. Never
//     reads or writes ~/.claude/sessions/.
//   - Aborts SIGINT the claude-p process group. No JSONL surgery, no UUID
//     rotation.
//   - Subagents work via a context stack: a child spawn nested inside a
//     parent's parked tool-handler slot.

import {
	calculateCost,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
	type Tool,
} from "@mariozechner/pi-ai";
import * as piAi from "@mariozechner/pi-ai";
import { keyHint, type ExtensionAPI, type ExtensionUIContext } from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import pino from "pino";
import { createStream } from "rotating-file-stream";
import { homedir, tmpdir } from "os";
import { randomBytes, randomUUID } from "crypto";
import { writeFileSync } from "fs";
import { createRequire } from "module";
import { dirname, join, resolve } from "path";
import { pascalCase } from "change-case";
import { PROVIDER_ID, messageContentToText } from "./convert.js";
import { buildModels, resolveModelId as _resolveModelId } from "./models.js";
import {
	spawnClaudePWithResilience as _realSpawnClaudeP,
	spawnClaudeP as _realSpawnClaudePSingle,
	getInstalledClaudeVersion,
	type ClaudePSpawnConfig,
	type ClaudePHandle,
	type ClaudePDoneResult,
	type SystemPromptSource,
	type PromptSource,
} from "./src/driver/claudeP.js";
import {
	readSidecar,
	writeSidecar,
	invalidateSidecar,
	validateWarmResume,
	computeSha256Chain,
} from "./src/resume-store.js";
import type { DriverStreamEvent } from "./src/driver/stream.js";
import { createRouter, type Router, type ParkedCallInfo, type ToolDef } from "./src/mcp/router.js";
import { runClaudePCapture, type CaptureDeps, type CaptureSpawnFactory } from "./src/capture.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MCP_SERVER_NAME = "custom-tools";
const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/**
 * claude-p MCP-startup-race guard (system-prompt preamble).
 *
 * ROOT CAUSE this addresses: on the claude-p path the bridge's bridged tools are
 * delivered by a stdio MCP server (`custom-tools`, the shim) that `claude` spawns
 * and connects ASYNCHRONOUSLY. claude-p drives the interactive TUI and the model's
 * first turn frequently begins BEFORE the shim has finished its MCP handshake, so
 * the model's initial tool roster contains only the native `WaitForMcpServers`
 * tool and NOT yet `mcp__custom-tools__*`. `claude` exposes `WaitForMcpServers`
 * precisely so the model can block until pending servers connect — but USING it is
 * left to the model's discretion, and smaller models (e.g. haiku) routinely
 * DECLINE: they answer "I don't have access to <tool>; my only tool is
 * WaitForMcpServers" and end the turn. That is the S14 (nested subagent) / S25
 * (capture-during-turn) blocker: no `tools/call` is ever emitted, so the bridge's
 * router never parks and the round never runs.
 *
 * The fix is deterministic and model-agnostic: tell the model, up front, that its
 * tools arrive via a server that may still be connecting and that it MUST call
 * `WaitForMcpServers` before ever concluding a bridged tool is unavailable. This
 * converts the nondeterministic "model might wait" behavior into "model always
 * waits", which is exactly what `WaitForMcpServers` is designed for. It is the
 * minimal correct fix: it changes no isolation flags (G2 closed-set is untouched —
 * the only tools that exist are still `mcp__custom-tools__*` + the native
 * `WaitForMcpServers`, which the bridge already filters out of the observable
 * tool-use stream) and adds no new subprocess plumbing.
 */
const CLAUDE_P_MCP_WAIT_PREAMBLE =
	`Your tools are provided by an MCP server named "${MCP_SERVER_NAME}" that may still ` +
	`be connecting when your turn begins. Tool names you can call therefore appear as ` +
	`\`${MCP_TOOL_PREFIX}<name>\`. If a tool you need or were asked to use is not yet in ` +
	`your available tools, you MUST first call the \`WaitForMcpServers\` tool and wait for ` +
	`the server to finish connecting, THEN use the tool. Never tell the user a bridged ` +
	`(\`${MCP_TOOL_PREFIX}*\`) tool is unavailable, and never decline a request, without ` +
	`first calling \`WaitForMcpServers\`.`;

/** Prepend the MCP-startup-race preamble to a claude-p system prompt (see CLAUDE_P_MCP_WAIT_PREAMBLE). */
function withClaudePMcpWaitPreamble(systemPrompt: string): string {
	const base = systemPrompt.trim();
	return base ? `${CLAUDE_P_MCP_WAIT_PREAMBLE}\n\n${base}` : CLAUDE_P_MCP_WAIT_PREAMBLE;
}

// Pi sends lowercase tool names; `claude` uses PascalCase for built-ins. The
// bridge advertises bridged pi tools under the `mcp__custom-tools__*` namespace,
// but the model may still name a built-in (read/write/edit/bash) — map those
// back to pi-native names. Used by mapToolName on the claude-p round-trip path.
const SDK_TO_PI_TOOL_NAME: Record<string, string> = {
	read: "read", write: "write", edit: "edit", bash: "bash",
};

// ---------------------------------------------------------------------------
// claude-p spawn factory — production/test seam. Production always uses
// _spawnClaudePFactory(...); tests inject a mock via __setSpawnClaudePForTests.
// ---------------------------------------------------------------------------

let _spawnClaudePFactory: typeof _realSpawnClaudeP = _realSpawnClaudeP;

/** Test-only: swap the claude-p spawn (resilience) factory and return a restorer. */
export function __setSpawnClaudePForTests(f: typeof _realSpawnClaudeP): () => void {
	const prev = _spawnClaudePFactory;
	_spawnClaudePFactory = f;
	return () => { _spawnClaudePFactory = prev; };
}

// ---------------------------------------------------------------------------
// claude-p CAPTURE spawn factory — separate test seam (T2.1/T2.2). The capture
// path uses the single-shot spawnClaudeP (NO resilience wrapper: a capture
// respawn could re-execute the model's turn). Tests inject a mock here.
// ---------------------------------------------------------------------------

let _captureSpawnFactory: CaptureSpawnFactory = _realSpawnClaudePSingle;

/** Test-only: swap the claude-p CAPTURE spawn factory and return a restorer. */
export function __setCaptureSpawnForTests(f: CaptureSpawnFactory): () => void {
	const prev = _captureSpawnFactory;
	_captureSpawnFactory = f;
	return () => { _captureSpawnFactory = prev; };
}

// ---------------------------------------------------------------------------
// Driver selection (T3 cut-over). `claude-p` is now the ONLY inference driver;
// the legacy in-process SDK path has been deleted. CLAUDE_BRIDGE_DRIVER defaults
// to `claude-p` and the only other accepted value is `claude-p` itself. Setting
// it to `sdk` is a removed configuration and surfaces a clear deprecation error
// at module load (NOT a silent fallback) so operators migrate explicitly.
// ---------------------------------------------------------------------------

const _rawDriver = (process.env.CLAUDE_BRIDGE_DRIVER ?? "claude-p").trim().toLowerCase();
if (_rawDriver === "sdk") {
	throw new Error(
		"CLAUDE_BRIDGE_DRIVER=sdk is no longer supported: the in-process Claude Agent SDK " +
		"inference path was removed in the claude-p cut-over. pi-claude-bridge now drives " +
		"the interactive `claude` TUI exclusively via the claude-p driver. Unset " +
		"CLAUDE_BRIDGE_DRIVER (or set it to `claude-p`) to continue.",
	);
}
if (_rawDriver !== "claude-p") {
	throw new Error(
		`CLAUDE_BRIDGE_DRIVER="${process.env.CLAUDE_BRIDGE_DRIVER}" is not a valid driver. ` +
		"The only supported value is `claude-p` (the default). Unset CLAUDE_BRIDGE_DRIVER to use it.",
	);
}

/** Test-only: swap piApiRef and return a restorer. Not part of the public API. */
export function __setPiApiRefForTests(ref: { getActiveTools(): string[] } | null): () => void {
	const prev = piApiRef;
	piApiRef = ref as any;
	return () => { piApiRef = prev as any; };
}

/** Test-only: return the current debug log path. Not part of the public API. */
export function __getDebugLogPathForTests(): string {
	return DEBUG_LOG_PATH;
}

/** Test-only: reset cross-call session cache. Not part of the public API. */
export function __resetCachedSessionForTests(): void {
	cachedSessionId = null;
	cachedSessionCwd = null;
	lastSentMessageHashes = null;
	// Drop any frames a test left on the stack (e.g. a retained errored/aborted
	// frame whose driver never popped) so the next test in the same file starts
	// clean. Best-effort stop their routers to release IPC sockets.
	while (stack.length > 0) {
		const f = stack.pop();
		void f?.router?.stop();
	}
}

// Pi tool arg key renames (pi names vs `claude` built-in names). Used by
// mapToolArgs on the claude-p round-trip path.
const SDK_KEY_RENAMES: Record<string, Record<string, string>> = {
	read:  { file_path: "path" },
	write: { file_path: "path" },
	edit:  { file_path: "path", old_string: "oldText", new_string: "newText", old_text: "oldText", new_text: "newText" },
};

// ---------------------------------------------------------------------------
// pi-ai compat shim
// ---------------------------------------------------------------------------

const _piAi = piAi as any;
const newAssistantMessageEventStream: () => AssistantMessageEventStream =
	typeof _piAi.createAssistantMessageEventStream === "function"
		? _piAi.createAssistantMessageEventStream
		: () => new _piAi.AssistantMessageEventStream();

// ---------------------------------------------------------------------------
// Logging (pino + pino-roll)
// ---------------------------------------------------------------------------
// On by default. Disable with CLAUDE_BRIDGE_DEBUG=0.
// Log path: ~/.pi/agent/claude-bridge.log (override CLAUDE_BRIDGE_DEBUG_PATH).
// Size-based rotation via pino-roll: 10 MB per file, keep 2 generations
// (override CLAUDE_BRIDGE_DEBUG_MAX_BYTES for size).
// Output is JSON-per-line; each record carries `level`, `time` (ISO),
// `msg`, plus any structured fields the call site attached.

const DEBUG = process.env.CLAUDE_BRIDGE_DEBUG !== "0";
const DEBUG_LOG_PATH = process.env.CLAUDE_BRIDGE_DEBUG_PATH || join(homedir(), ".pi", "agent", "claude-bridge.log");
const DEBUG_MAX_BYTES = Number(process.env.CLAUDE_BRIDGE_DEBUG_MAX_BYTES) || 10 * 1024 * 1024;

if (DEBUG) {
	try { mkdirSync(dirname(DEBUG_LOG_PATH), { recursive: true }); } catch { /* ignore */ }
}

// rotating-file-stream maintains the live file at DEBUG_LOG_PATH and moves
// rotated content to numbered backups (DEBUG_LOG_PATH.1, .2). Total disk
// bounded at ~3× DEBUG_MAX_BYTES (current + 2 backups).
const logStream = DEBUG
	? createStream(DEBUG_LOG_PATH, {
			size: `${DEBUG_MAX_BYTES}B`,
			maxFiles: 2,
		})
	: undefined;

const logger = DEBUG && logStream
	? pino(
			{ level: "debug", timestamp: pino.stdTimeFunctions.isoTime, base: undefined },
			logStream,
		)
	: pino({ level: "silent" });

// Back-compat shim: existing call sites use `debug(msg)`. Keep it as the
// debug-level entrypoint; new code can call log.info/warn/error directly.
const log = {
	debug: (objOrMsg: unknown, msg?: string) =>
		typeof objOrMsg === "string" ? logger.debug(objOrMsg) : logger.debug(objOrMsg as object, msg),
	info: (objOrMsg: unknown, msg?: string) =>
		typeof objOrMsg === "string" ? logger.info(objOrMsg) : logger.info(objOrMsg as object, msg),
	warn: (objOrMsg: unknown, msg?: string) =>
		typeof objOrMsg === "string" ? logger.warn(objOrMsg) : logger.warn(objOrMsg as object, msg),
	error: (objOrMsg: unknown, msg?: string) =>
		typeof objOrMsg === "string" ? logger.error(objOrMsg) : logger.error(objOrMsg as object, msg),
};

function debug(msg: string) { log.debug(msg); }

// ---------------------------------------------------------------------------
// Models — preserve legacy buildModels with safe fallback for diamond deps.
// ---------------------------------------------------------------------------

import { getModels } from "@mariozechner/pi-ai";
const ANTHROPIC_MODELS = (getModels as any)("anthropic") ?? [];
const MODELS = buildModels(ANTHROPIC_MODELS as any[]);

// ---------------------------------------------------------------------------
// Module state — pi extension singletons.
// ---------------------------------------------------------------------------

let piApiRef: ExtensionAPI | null = null;
let piUI: ExtensionUIContext | null = null;
// Latest pi extension context (captured on session_start). Used to read the
// current pi sessionId for log binding.
let piExtCtx: { sessionManager: { getSessionId(): string } } | null = null;

function getPiSessionId(): string | null {
	try {
		const id = piExtCtx?.sessionManager.getSessionId();
		return id ? id.slice(0, 8) : null;
	} catch { return null; }
}

/**
 * The FULL pi session id (NOT the 8-char getPiSessionId truncation). The
 * warm-resume sidecar key needs the untruncated id so two sessions sharing an
 * 8-char prefix do not collide (design D3 / C3b). Null if unavailable.
 */
function getFullPiSessionId(): string | null {
	try {
		return piExtCtx?.sessionManager.getSessionId() ?? null;
	} catch { return null; }
}

/**
 * In-memory session cache. The CC session_id is a hint for prompt cache
 * resume. We NEVER read or write ~/.claude/sessions/. On restart, on /fork,
 * on /tree, on /compact — anything that diverges history — this is dropped
 * and the next turn cold-starts.
 */
let cachedSessionId: string | null = null;
let cachedSessionCwd: string | null = null;

// Context-window total (totalTokens) last reported to pi for the MAIN turn. Used
// to SEED the in-progress assistant message's usage so pi's context bar holds at
// the prior window while a turn streams, instead of collapsing to ~0. pi anchors
// the bar on the last assistant message (getLastAssistantUsageInfo); during a
// turn that is the in-progress message, and a truthy all-zero usage yields
// calculateContextTokens()==0 — the "context resets mid-turn" symptom. We seed
// ONLY totalTokens (components stay 0, so getSessionStats — which sums the
// components, not totalTokens — is unaffected); the final round's real usage
// overwrites the seed at turn end. Reset to 0 on session change (clearSession)
// so a post-/compact turn shows "?" rather than a stale pre-compaction size.
let lastReportedContextTotal = 0;

/**
 * One-shot "attempt a validated warm-resume on the next turn" flag, set by the
 * `session_start:resume` handler (which carries no cwd, so it cannot read the
 * keyed sidecar itself — that happens at the first turn in startFreshQuery where
 * the literal `frame.cwd` is known; design D4). Consumed exactly once.
 */
let warmResumePending = false;

/**
 * Per-message fingerprints from the last context we sent. Used to detect
 * divergence: on a new turn, we expect each prior position's hash to be
 * unchanged; new messages append at the end. If any prior position's hash
 * differs, pi has /tree-navigated, /fork-ed, or /compact-ed — the claude
 * session's resumed transcript no longer matches and we must cold-start.
 *
 * Forward progress (T1: [u1] → T2: [u1, a1, u2]) is NOT divergence — the
 * new array is a prefix-extension of the old.
 */
let lastSentMessageHashes: string[] | null = null;

function hashMessage(m: Context["messages"][number]): string {
	const c = typeof m.content === "string" ? m.content : messageContentToText(m.content);
	const head = c.slice(0, 96);
	const tail = c.slice(-32);
	return `${m.role}:${c.length}:${head}|${tail}`;
}

function computeMessageHashes(messages: Context["messages"]): string[] {
	return messages.map(hashMessage);
}

/**
 * Flatten pi messages into { role, text } items for the resume-store's one-way
 * `sha256` fingerprint chain (computeSha256Chain) and the warm-resume gate. The
 * text is the same flattening hashMessage uses, but the resulting persisted
 * digest is opaque (no plaintext recoverable) — see src/resume-store.ts.
 */
function messagesToFingerprintItems(messages: Context["messages"]): { role: string; text: string }[] {
	return messages.map((m) => ({
		role: m.role,
		text: typeof m.content === "string" ? m.content : messageContentToText(m.content),
	}));
}

/**
 * Detect divergence: returns true if any common-prefix position differs
 * between the previously-sent message hashes and the current ones. False
 * (no divergence) when there's no prior or when current is a strict
 * prefix-extension of prior.
 */
function detectHistoryDivergence(
	prior: string[] | null,
	current: string[],
): boolean {
	if (!prior || prior.length === 0) return false;
	const commonLen = Math.min(prior.length, current.length);
	for (let i = 0; i < commonLen; i++) {
		if (prior[i] !== current[i]) return true;
	}
	// If current is shorter than prior, history was truncated → divergence.
	return current.length < prior.length;
}

// ---------------------------------------------------------------------------
// Held-round-aware idle watchdog (Layer 2 of the hung-turn fix).
//
// claude-p stays alive and IDLE across a held tool round: the model's MCP
// tool_use is an in-flight call, so claude-p blocks until pi returns the result.
// Its own --timeout counts that idle time, so --timeout must be a generous
// BACKSTOP (CLAUDE_P_TIMEOUT_SECONDS) that never trips a healthy subagent. The
// bridge is the only component that knows a tool is parked, so liveness is
// enforced here: a per-frame timer that declares a wedge after WATCHDOG_IDLE_MS
// of NO driver output — but ONLY when no tool is parked. While a tool is parked
// it defers entirely to the tool's own (pi-enforced) timeout and never fires. On
// a wedge it calls handle.killWedged() → the spawn classifies "error" → the
// resilience wrapper retries a boot-wedge (no tool routed) or surfaces a
// post-tool wedge via the Layer 1 safety net.
// ---------------------------------------------------------------------------

/** Idle window (ms) before a silent, NOT-parked claude-p is declared wedged.
 *  Env CLAUDE_BRIDGE_WATCHDOG_IDLE_MS overrides; 0 disables. Must exceed healthy
 *  slow-boot first-output latency (observed as high as ~65s). */
const WATCHDOG_IDLE_MS = (() => {
	const raw = process.env.CLAUDE_BRIDGE_WATCHDOG_IDLE_MS;
	if (raw === undefined || raw === "") return 180_000;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : 180_000;
})();

interface Watchdog {
	/** Reset the idle countdown — call on every sign of driver life. */
	poke(): void;
	/** Halt permanently (turn finalized or aborted). Idempotent. */
	stop(): void;
}

/**
 * Build a held-round-aware idle watchdog. `isHeldRound()` is consulted at fire
 * time: when true (a tool is parked) the watchdog re-arms WITHOUT firing —
 * claude-p is legitimately waiting on pi. Otherwise it calls `onWedge()` and
 * keeps watching (across a resilience retry) until stop().
 */
function makeWatchdog(opts: {
	idleMs: number;
	isHeldRound: () => boolean;
	onWedge: () => void;
	log: pino.Logger;
}): Watchdog {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;
	const arm = () => {
		if (stopped || opts.idleMs <= 0) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(tick, opts.idleMs);
		timer.unref?.();
	};
	const tick = () => {
		if (stopped) return;
		if (opts.isHeldRound()) {
			// A tool is parked → claude-p is correctly idle waiting for pi. Defer to
			// the tool's own (pi-enforced) timeout; keep watching. Debug-level so it
			// is observable (a scenario can assert the watchdog ticked + deferred
			// during a held round) without adding noise at the default log level.
			opts.log.debug({ idleMs: opts.idleMs }, "watchdog: tick during held round — deferring (claude-p legitimately idle on a held tool)");
			arm();
			return;
		}
		opts.log.warn({ idleMs: opts.idleMs }, `watchdog: claude-p silent for ${opts.idleMs}ms with no tool parked — declaring wedge (kill+retry)`);
		try { opts.onWedge(); } catch (err) {
			opts.log.warn({ err: err instanceof Error ? err.message : String(err) }, "watchdog: onWedge threw (ignored)");
		}
		arm(); // keep watching across the retry until finalize/abort stops us
	};
	return { poke: arm, stop: () => { stopped = true; if (timer) clearTimeout(timer); timer = undefined; } };
}

/** Test-only: expose the held-round-aware watchdog factory. */
export const __makeWatchdogForTests = makeWatchdog;

/**
 * Active in-flight query state. There is at most one *top-level* active query
 * per pi conversation, BUT subagents can nest a child query inside a parent's
 * blocked tool-handler slot. We use a stack to model this correctly.
 *
 * `top()` is the query that owns the next streamSimple() call (either a fresh
 * subagent turn or a tool-result delivery for the current frame's blocked
 * MCP handler).
 */
type QueryFrame = {
	/** claude-p driver handle for this spawn. */
	claudeHandle?: ClaudePHandle;
	/** Per-spawn MCP router; its onPark drives the pi round-trip. */
	router?: Router;
	currentPiStream: AssistantMessageEventStream | null;
	turnOutput: AssistantMessage | null;
	turnStarted: boolean;
	turnSawToolCall: boolean;
	turnBlocks: any[];
	customToolNameToPi: Map<string, string>;
	model: Model<any>;
	cwd: string;
	// Per-frame logger pre-bound with { piSessionId, model, cwd, driver }.
	log: pino.Logger;

	// Parked tool-call bookkeeping. These ARE the per-spawn router's maps (by
	// reference): the router parks each `tools/call` into pendingResolvers keyed
	// by its minted piId; Case 1 tool-result delivery resolves the matching
	// resolver. pendingResults handles the race where pi's result arrives before
	// the handler parks.
	pendingResolvers: Map<string, (result: { content: { type: "text"; text: string }[]; isError?: boolean }) => void>;
	pendingResults: Map<string, { content: { type: "text"; text: string }[]; isError?: boolean }>;

	wasAborted: boolean;
	// Set true when the driver terminated with an error (claude-p exited/crashed/
	// timed out, or a turn-level error) — as opposed to a clean stop or a user
	// abort. Used so a tool-result delivered into a dead frame closes pi's stream
	// with a terminal error instead of wiring into a corpse and hanging forever
	// (the error-path analogue of `wasAborted`). See finalizeClaudePFrame +
	// streamClaudeAgentSdk Case 1 (`willHangIfWired`).
	driverErrored: boolean;
	// Layer 2: held-round-aware idle watchdog for this spawn. Created in
	// startFreshQuery; stopped in finalizeClaudePFrame + abortFrame.
	watchdog?: Watchdog;
	donePromise: Promise<void>;
	// Warm-pi-resume: the one-way sha256 fingerprint chain of pi's history as it
	// stood at THIS turn's start (over context.messages). Stashed at turn-start so
	// finalizeClaudePFrame — which does not receive the messages — can persist the
	// content-free resume sidecar on a successful main-turn finalize (design D1).
	sha256Chain?: string[];
};

const stack: QueryFrame[] = [];
function top(): QueryFrame | null { return stack[stack.length - 1] ?? null; }

// ---------------------------------------------------------------------------
// Settings & system-prompt helpers (lightweight version of legacy)
// ---------------------------------------------------------------------------

const GLOBAL_AGENTS_PATH = join(homedir(), ".pi", "AGENTS.md");

function findAgentsMdInParents(startDir: string): string | undefined {
	let current = resolve(startDir);
	while (true) {
		const candidate = join(current, "AGENTS.md");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function resolveAgentsMdPath(): string | undefined {
	return findAgentsMdInParents(process.cwd()) ?? (existsSync(GLOBAL_AGENTS_PATH) ? GLOBAL_AGENTS_PATH : undefined);
}

function sanitizeAgentsContent(content: string): string {
	return content
		.replace(/~\/\.pi\b/gi, "~/.claude")
		.replace(/(^|[\s'"`])\.pi\//g, "$1.claude/")
		.replace(/\b\.pi\b/gi, ".claude")
		.replace(/\bpi\b/gi, "environment");
}

function extractAgentsAppend(): string | undefined {
	const p = resolveAgentsMdPath();
	if (!p) return undefined;
	try {
		const content = readFileSync(p, "utf-8").trim();
		if (!content) return undefined;
		const sanitized = sanitizeAgentsContent(content);
		return sanitized ? `# CLAUDE.md\n\n${sanitized}` : undefined;
	} catch { return undefined; }
}

// Pi's APPEND_SYSTEM.md (project override at <cwd>/.pi/APPEND_SYSTEM.md, else
// global at ~/.pi/agent/APPEND_SYSTEM.md). Forwarded verbatim plus a runtime
// note about the MCP tool-name prefix, since pi tools are exposed to Claude
// as `mcp__<MCP_SERVER_NAME>__<name>` rather than their bare pi names.
const PROJECT_APPEND_SYSTEM_PATH = join(".pi", "APPEND_SYSTEM.md");
const GLOBAL_APPEND_SYSTEM_PATH = join(homedir(), ".pi", "agent", "APPEND_SYSTEM.md");

function resolveAppendSystemPath(): string | undefined {
	const projectPath = join(process.cwd(), PROJECT_APPEND_SYSTEM_PATH);
	if (existsSync(projectPath)) return projectPath;
	if (existsSync(GLOBAL_APPEND_SYSTEM_PATH)) return GLOBAL_APPEND_SYSTEM_PATH;
	return undefined;
}

function extractAppendSystem(): string | undefined {
	const p = resolveAppendSystemPath();
	if (!p) return undefined;
	try {
		const content = readFileSync(p, "utf-8").trim();
		if (!content) return undefined;
		// Forward as-is and append a runtime note teaching Claude how to
		// invoke any tool the rules above might reference. Claude only sees
		// pi tools through the bridge's MCP server, so bare names like
		// `bash` / `subagent` won't resolve unless prefixed.
		const toolNotice = `\n\nNote: if the rules above reference tools by bare names (e.g. \`bash\`, \`read\`, \`write\`, \`edit\`, \`subagent\`), call them via the MCP-prefixed names \`mcp__${MCP_SERVER_NAME}__<name>\` (e.g. \`mcp__${MCP_SERVER_NAME}__bash\`). The bare names are not exposed.`;
		return `# Operator instructions\n\n${content}${toolNotice}`;
	} catch { return undefined; }
}

// Pi's system prompt has a skills block we want to forward to CC verbatim
// (with the read-tool reference rewritten to use our MCP-prefixed name).
function extractSkillsBlock(systemPrompt?: string): string | undefined {
	if (!systemPrompt) return undefined;
	const start = systemPrompt.indexOf("The following skills provide specialized instructions for specific tasks.");
	if (start < 0) return undefined;
	const end = systemPrompt.indexOf("</available_skills>", start);
	if (end < 0) return undefined;
	return systemPrompt.slice(start, end + "</available_skills>".length).trim()
		.replace("Use the read tool to load a skill's file", `Use the read tool (mcp__${MCP_SERVER_NAME}__read) to load a skill's file`);
}

// ---------------------------------------------------------------------------
// Tool-name & tool-arg mapping (claude-emitted names → pi-native names)
// ---------------------------------------------------------------------------

function mapToolName(name: string, customToolNameToPi: Map<string, string>): string {
	const normalized = name.toLowerCase();
	const builtin = SDK_TO_PI_TOOL_NAME[normalized];
	if (builtin) return builtin;
	const mapped = customToolNameToPi.get(name) ?? customToolNameToPi.get(normalized);
	if (mapped) return mapped;
	if (normalized.startsWith(MCP_TOOL_PREFIX)) return name.slice(MCP_TOOL_PREFIX.length);
	return name;
}

function mapToolArgs(toolName: string, args: Record<string, unknown> | undefined): Record<string, unknown> {
	const input = args ?? {};
	const renames = SDK_KEY_RENAMES[toolName.toLowerCase()];
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) {
		const piKey = renames?.[key] ?? key;
		if (!(piKey in result)) result[piKey] = value;
	}
	if (toolName.toLowerCase() === "bash" && result.timeout == null) result.timeout = 120;
	return result;
}

// ---------------------------------------------------------------------------
// Driver message → pi event-stream translation
// ---------------------------------------------------------------------------

function ensureTurnStarted(frame: QueryFrame) {
	if (!frame.turnStarted && frame.currentPiStream && frame.turnOutput) {
		frame.currentPiStream.push({ type: "start", partial: frame.turnOutput });
		frame.turnStarted = true;
	}
}

/**
 * Mirror frame.turnBlocks → frame.turnOutput.content. The partial message
 * is what pi-ai consumers read for the final assembled response. We sync on
 * every block-level mutation so the `done`/`error` event message is correct.
 */
function syncTurnContent(frame: QueryFrame) {
	if (!frame.turnOutput) return;
	const out: any[] = [];
	for (const b of frame.turnBlocks) {
		if (b.type === "text") out.push({ type: "text", text: b.text });
		else if (b.type === "thinking") out.push({ type: "thinking", thinking: b.thinking, thinkingSignature: b.thinkingSignature });
		else if (b.type === "toolCall") out.push({ type: "toolCall", id: b.id, name: b.name, arguments: b.arguments });
	}
	frame.turnOutput.content = out;
}

/**
 * T1.14a: commit the streamed partial into the frame's turnOutput as the
 * ABORTED message. Mirrors turnBlocks → content via syncTurnContent (preserving
 * streamed text + any prior tool_use blocks) and, when no text block exists,
 * appends a synthetic "[interrupted]" text block so the abandoned prefix always
 * survives into pi history for next-turn cold-replay (S7/S13 coherence). The
 * caller then sets stopReason/errorMessage. Returns the same turnOutput for
 * convenience; does NOT replace it with a fresh one.
 */
function commitAbortedPartial(frame: QueryFrame): AssistantMessage | null {
	if (!frame.turnOutput) return null;
	syncTurnContent(frame);
	const hasText = frame.turnBlocks.some((b) => b.type === "text");
	if (!hasText) {
		frame.turnBlocks.push({ type: "text", text: "[interrupted]" });
		syncTurnContent(frame);
	}
	return frame.turnOutput;
}

/**
 * Usage object for an IN-PROGRESS (not-yet-final) assistant message. `totalTokens`
 * is seeded with the prior context window so pi's context bar holds steady while
 * the turn streams; the component fields stay 0 so the message contributes nothing
 * to pi's session-stat sums until its real usage lands at turn end. Pure +
 * exported for the regression test (a revert to a 0 total would re-introduce the
 * mid-turn bar collapse).
 */
export function buildInProgressUsage(priorContextTotal: number) {
	return {
		input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
		totalTokens: priorContextTotal,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function newTurnOutput(model: Model<any>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages" as any,
		provider: PROVIDER_ID as any,
		model: model.id,
		usage: buildInProgressUsage(lastReportedContextTotal),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function resetTurnState(frame: QueryFrame) {
	frame.turnOutput = newTurnOutput(frame.model);
	frame.turnStarted = false;
	frame.turnSawToolCall = false;
	frame.turnBlocks = [];
}

// ---------------------------------------------------------------------------
// Prompt extraction (last user message)
// ---------------------------------------------------------------------------

function extractUserPrompt(messages: Context["messages"]): string | null {
	const last = messages[messages.length - 1];
	if (!last || last.role !== "user") return null;
	if (typeof last.content === "string") return last.content;
	return messageContentToText(last.content) || "";
}

/**
 * True when the last user message carries any image content block. The claude-p
 * path is text-only (it cannot inject images), so this is used purely to (a)
 * keep the empty-prompt guard correct when the last message is an image-only
 * user turn, and (b) drive the strip-and-warn log.
 */
function lastUserMessageHasImages(messages: Context["messages"]): boolean {
	const last = messages[messages.length - 1];
	if (!last || last.role !== "user" || !Array.isArray(last.content)) return false;
	return last.content.some((block) => (block as any).type === "image" && (block as any).data && (block as any).mimeType);
}

/**
 * Build a cold-start prompt that embeds pi's full prior conversation as text
 * context, followed by the new user message. Used when no `cachedSessionId`
 * is available (first turn after bridge restart, after fork/compact, etc.).
 *
 * A fresh claude-p spawn accepts only a single prompt at start time; there's no
 * way to seed a multi-turn transcript at spawn creation. So we pack the prior
 * conversation into a single user message that the model reads as background
 * context. Format is intentionally explicit so the model knows it's history,
 * not the current request.
 */
// Exported for unit testing. Replayed history is embedded VERBATIM — we do NOT
// rewrite what the model previously produced, even if a prior turn emitted tool
// calls as text. Faithful history is the invariant (decision 2026-06-03: "if the
// model returned it, it is part of the history even if wrong"). claude-p is a
// model completion endpoint: the bridge passes model output through to the
// response/terminal/history unchanged and never content-scrubs it (a leaked tool
// call and a legitimate discussion of the tool-call format are textually
// identical, so scrubbing would corrupt real conversations).
export function buildColdStartPrompt(messages: Context["messages"]): string {
	if (messages.length === 0) return "";
	if (messages.length === 1 && messages[0].role === "user") {
		// First-ever turn — no prior history to embed.
		return typeof messages[0].content === "string"
			? messages[0].content
			: messageContentToText(messages[0].content) || "";
	}

	const last = messages[messages.length - 1];
	const lastIsUser = last.role === "user";
	const priorMessages = lastIsUser ? messages.slice(0, -1) : messages;

	const priorLines: string[] = [];
	for (const m of priorMessages) {
		if (m.role === "user") {
			const text = typeof m.content === "string" ? m.content : messageContentToText(m.content);
			if (text) priorLines.push(`[user] ${text}`);
		} else if (m.role === "assistant") {
			const blocks = Array.isArray(m.content) ? m.content : [];
			const parts: string[] = [];
			for (const b of blocks) {
				if (b.type === "text" && b.text) parts.push(b.text);
				else if (b.type === "toolCall") parts.push(`[tool: ${b.name}(${JSON.stringify(b.arguments).slice(0, 200)})]`);
			}
			if (parts.length) priorLines.push(`[assistant] ${parts.join(" ")}`);
		} else if (m.role === "toolResult") {
			const text = typeof m.content === "string" ? m.content : messageContentToText(m.content);
			const tag = m.isError ? "tool-error" : "tool-result";
			priorLines.push(`[${tag} ${m.toolName}] ${text.slice(0, 500)}`);
		}
	}

	const lastUserText = lastIsUser
		? (typeof last.content === "string" ? last.content : messageContentToText(last.content))
		: "[continue]";

	if (priorLines.length === 0) return lastUserText || "[continue]";

	return [
		"<conversation_history>",
		"The following is our prior conversation in this session. Treat it as context.",
		...priorLines,
		"</conversation_history>",
		"",
		"User's current message:",
		lastUserText || "[continue]",
	].join("\n");
}

// ---------------------------------------------------------------------------
// Tool-result extraction (find tool_results appended since the last assistant)
// ---------------------------------------------------------------------------

function extractTrailingToolResults(messages: Context["messages"]): Array<{ id: string; content: string; isError: boolean }> {
	// Walk backwards, collect toolResult messages, stop at the first non-toolResult.
	const results: Array<{ id: string; content: string; isError: boolean }> = [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "toolResult") break;
		const content = typeof m.content === "string" ? m.content : messageContentToText(m.content);
		results.unshift({ id: m.toolCallId, content, isError: m.isError });
	}
	return results;
}

// ---------------------------------------------------------------------------
// MCP tool registry from pi's context
// ---------------------------------------------------------------------------

function resolveMcpTools(context: Context, excludeToolName: string): {
	mcpTools: Tool[];
	customToolNameToPi: Map<string, string>;
} {
	const mcpTools: Tool[] = [];
	const customToolNameToPi = new Map<string, string>();
	if (!context.tools) return { mcpTools, customToolNameToPi };
	for (const tool of context.tools) {
		if (tool.name === excludeToolName) continue;
		const sdkName = `${MCP_TOOL_PREFIX}${tool.name}`;
		mcpTools.push(tool);
		customToolNameToPi.set(sdkName, tool.name);
		customToolNameToPi.set(sdkName.toLowerCase(), tool.name);
	}
	return { mcpTools, customToolNameToPi };
}

// ---------------------------------------------------------------------------
// Output-capture classification helpers (Decision 2, 3, 6)
// ---------------------------------------------------------------------------

/**
 * Snapshot pi's active tool names once per call. Returns empty set when
 * piApiRef is null (bridge loaded outside pi extension lifecycle, e.g. tests)
 * or when getActiveTools() throws. With an empty set, every ctx.tools entry
 * is treated as a capture tool — the correct fallback for callers not bound
 * to the pi extension runtime (per spec "`piApiRef === null` fallback").
 * Uses getActiveTools() NOT getAllTools() so registered-but-inactive names
 * are correctly classified as capture-side (Decision 2).
 */
export function getActiveToolNameSet(): Set<string> {
	try {
		// getActiveTools() returns string[] (tool names) per ExtensionAPI type.
		const names = piApiRef?.getActiveTools() ?? [];
		return new Set(names);
	} catch {
		return new Set();
	}
}

/**
 * Partition context.tools into executable (pi-registered) and capture
 * (unregistered) tools. Skips excludeName when a built-in tool must be
 * filtered out of both partitions (pass "" to exclude nothing).
 */
export function classifyToolsForCapture(
	context: Context,
	activeNames: Set<string>,
	excludeName: string,
): { executable: Tool[]; capture: Tool[] } {
	const executable: Tool[] = [];
	const capture: Tool[] = [];
	if (!context.tools) return { executable, capture };
	for (const tool of context.tools) {
		if (tool.name === excludeName) continue;
		if (activeNames.has(tool.name)) {
			executable.push(tool);
		} else {
			capture.push(tool);
		}
	}
	return { executable, capture };
}

/**
 * Deep JSON-only clone of a schema: preserves every JSON-serializable keyword
 * at every depth (minLength, maxLength, minItems, maxItems, pattern, enum,
 * required, nested properties, items, etc.) and naturally drops TypeBox
 * symbol-keyed metadata (Symbol(Kind), Symbol(Modifier), etc.) which
 * JSON.stringify skips at every depth. Per design Decision 6.
 */
export function cleanSchemaForSdk(schema: unknown): Record<string, unknown> {
	return JSON.parse(JSON.stringify(schema));
}

type CaptureCallShape =
	| { kind: "all-executable" }
	| { kind: "single-capture"; captureTool: Tool; cleanedSchema: Record<string, unknown> }
	| { kind: "rejected"; reason: string };

/**
 * Enforce Decision 3: capture mode is mutually exclusive with executable
 * tools, and requires exactly one capture tool with an object-root schema.
 */
export function validateCaptureCallShape({
	executable,
	capture,
}: { executable: Tool[]; capture: Tool[] }): CaptureCallShape {
	if (capture.length === 0) {
		return { kind: "all-executable" };
	}
	if (capture.length === 1 && executable.length === 0) {
		const captureTool = capture[0];
		const cleanedSchema = cleanSchemaForSdk(captureTool.parameters);
		if (cleanedSchema.type !== "object") {
			return {
				kind: "rejected",
				reason: `capture tool "${captureTool.name}" has non-object root schema type "${String(cleanedSchema.type)}" — capture mode requires an object root schema (Type.Object(...)). v1 limitation.`,
			};
		}
		return { kind: "single-capture", captureTool, cleanedSchema };
	}
	if (capture.length > 1 && executable.length === 0) {
		return {
			kind: "rejected",
			reason: `bridge output-capture v1 supports exactly one capture tool per call; ${capture.length} unregistered tools found: [${capture.map((t) => t.name).join(", ")}]. Split into separate calls or use exactly one capture tool.`,
		};
	}
	// Mixed: at least one capture tool alongside executable tools
	return {
		kind: "rejected",
		reason: `capture mode (unregistered: [${capture.map((t) => t.name).join(", ")}]) is mutually exclusive with executable tools (registered: [${executable.map((t) => t.name).join(", ")}]) in v1. A call must use either all executable tools or exactly one capture tool. v1 limitation.`,
	};
}

// ---------------------------------------------------------------------------
// Provider entry point: streamSimple
// ---------------------------------------------------------------------------

export function streamClaudeAgentSdk(
	model: Model<any>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = newAssistantMessageEventStream();
	const lastMsg = context.messages[context.messages.length - 1];

	// ---- Case 1: tool-result delivery for the active query frame ----
	const active = top();
	if (active && lastMsg?.role === "toolResult") {
		const trailing = extractTrailingToolResults(context.messages);
		active.log.debug({ results: trailing.length, resolvers: active.pendingResolvers.size }, `streamSimple: tool-result delivery, ${trailing.length} results, ${active.pendingResolvers.size} resolvers waiting`);

		// Option H: pre-scan to find which (if any) frame the trailing
		// tool_result(s) belong to, so we can decide whether to wire the
		// stream into the active frame (normal flow) or close it with
		// aborted-error (the matched frame is post-abort, SDK won't generate
		// further content).
		let matchedFrame: QueryFrame | null = null;
		for (const r of trailing) {
			for (let i = stack.length - 1; i >= 0; i--) {
				if (stack[i].pendingResolvers.has(r.id)) { matchedFrame = stack[i]; break; }
			}
			if (matchedFrame) break;
		}
		// A delivery hangs if it wires into a frame that will never generate more
		// content: it was aborted, OR its driver errored/exited (claude-p crashed
		// or hit its timeout while pi was running the held tool). Both are terminal.
		const terminalFrame = matchedFrame ?? active;
		const willHangIfWired = terminalFrame.wasAborted || terminalFrame.driverErrored;

		// Wire the stream BEFORE resolving — only if the matched frame is
		// still live. A live frame's SDK will continue generating into this
		// stream after the resolver fires.
		if (!willHangIfWired) {
			active.currentPiStream = stream;
			resetTurnState(active);
			// Handing control back to claude-p (it resumes once the resolver fires
			// below) — restart the idle clock so the post-delivery continuation has
			// a fresh window before the watchdog would consider it wedged.
			terminalFrame.watchdog?.poke();
		}

		// Deliver each result to the matching resolver across the stack.
		for (const r of trailing) {
			const result = { content: [{ type: "text" as const, text: r.content || "" }], isError: r.isError };
			let resolved = false;
			for (let i = stack.length - 1; i >= 0; i--) {
				const f = stack[i];
				const resolver = f.pendingResolvers.get(r.id);
				if (resolver) {
					f.pendingResolvers.delete(r.id);
					resolver(result);
					if (i !== stack.length - 1 || f.wasAborted) {
						f.log.info({ id: r.id, aborted: f.wasAborted }, `tool-result delivery: matched ${f.wasAborted ? "aborted-frame" : "buried-frame"} resolver (post-abort late delivery)`);
					}
					resolved = true;
					break;
				}
			}
			if (!resolved) {
				active.pendingResults.set(r.id, result);
			}
		}

		// If the matched frame is aborted, close the stream now — its SDK
		// won't write anything more. The resolver did still get the real
		// content; it lives in the SDK's session JSONL for next-turn resume.
		if (willHangIfWired) {
			// Aborted takes precedence over errored (a user abort that also tore
			// down the driver should read as "aborted by user"). Only a frame that
			// errored WITHOUT a user abort surfaces as a driver error.
			const erroredNotAborted = terminalFrame.driverErrored && !terminalFrame.wasAborted;
			queueMicrotask(() => {
				const out = newTurnOutput(model);
				if (erroredNotAborted) {
					out.stopReason = "error";
					out.errorMessage = "claude-p driver exited before returning the tool result — turn ended (the tool result was captured for next-turn resume)";
				} else {
					out.stopReason = "aborted";
					out.errorMessage = "Operation aborted by user (real tool result captured for next-turn resume)";
				}
				try {
					stream.push({ type: "start", partial: out });
					stream.push({ type: "error", reason: erroredNotAborted ? "error" : "aborted", error: out });
					stream.end();
				} catch { /* stream may have ended */ }
				terminalFrame.log.info(
					{ deliveredFor: erroredNotAborted ? "errored-frame" : "aborted-frame" },
					`tool-result delivery to ${erroredNotAborted ? "errored" : "aborted"} frame: closed pi stream with ${erroredNotAborted ? "error" : "aborted"}-error`,
				);
			});
		}
		return stream;
	}

	// ---- Case 2: orphaned tool result (no frame on the stack at all) ----
	// We've already scanned all frames for resolvers in Case 1 above. If we
	// reach here, the stack is genuinely empty — pi delivered a tool_result
	// for a frame we already cleaned up. Emit aborted so pi's TUI treats it
	// as the (already-fired) abort it represents, not a phantom completion.
	if (lastMsg?.role === "toolResult") {
		const orphanLog = logger.child({ piSessionId: getPiSessionId() });
		orphanLog.warn(`streamSimple: orphaned tool result, no active query — emitting end_turn`);
		queueMicrotask(() => {
			const out = newTurnOutput(model);
			out.stopReason = "aborted";
			out.errorMessage = "Operation aborted (tool result arrived after abort)";
			stream.push({ type: "start", partial: out });
			stream.push({ type: "error", reason: "aborted", error: out });
			stream.end();
			orphanLog.info("pushAbortedError: orphan tool result post-abort");
		});
		return stream;
	}

	// ---- Case 0: output-capture shape gate (Decision 10) ----
	// Classification runs only when lastMsg?.role !== "toolResult" (i.e. fresh-turn
	// path). Cases 1 and 2 above have already returned for tool-result delivery.
	// We check here — before touching the stack or shared state — so a capture
	// call never supersedes an active user frame (Decision 4).
	{
		const activeNames = getActiveToolNameSet();
		const { executable, capture } = classifyToolsForCapture(context, activeNames, "");
		const shape = validateCaptureCallShape({ executable, capture });

		if (shape.kind === "rejected") {
			log.warn({ captureTool: capture.map((t) => t.name), executable: executable.map((t) => t.name) }, `streamSimple: rejected capture-shape: ${shape.reason}`);
			queueMicrotask(() => {
				const out = newTurnOutput(model);
				out.stopReason = "error";
				out.errorMessage = shape.reason;
				stream.push({ type: "start", partial: out });
				stream.push({ type: "error", reason: "error", error: out });
				stream.end();
			});
			return stream;
		}

		if (shape.kind === "single-capture") {
			// Capture executor: the claude-p forced-toolcall capture path. The
			// classification + strict-call-shape gate above is driver-agnostic.
			void runClaudePCapture(model, shape.captureTool, shape.cleanedSchema, context, options, stream, buildCaptureDeps());
			return stream;
		}

		// shape.kind === "all-executable" — fall through to Case 3.
	}

	// ---- Case 3: fresh user turn (or subagent / steer-as-fresh) ----
	// If there's an active query that didn't resolve, the new user turn supersedes it:
	// interrupt and start fresh. This handles steering, rapid retype, and aborts that
	// arrived without a clean shutdown.
	//
	// Option H drain-on-supersede: if the superseded frame still has pending
	// MCP resolvers (an aborted tool_use whose real result never arrived from
	// pi), drain them here with the canonical synthetic text. By definition,
	// pi has now decided to move on (it's sending a new user turn instead of
	// delivering the tool_result), so it's safe to fabricate. Drain BEFORE
	// the pop so we don't lose the resolvers. Also drain any deeper buried
	// frames whose pending tool calls were also superseded by this turn.
	if (active) {
		active.log.info(`streamSimple: superseding active frame (top of stack), interrupting`);
		drainPendingResolversAsAborted(active, "superseded by new user turn");
		active.wasAborted = true;
		abortFrame(active);
		stack.pop();
		// Drain any deeper buried frames too — they're equally orphaned by
		// the steer. Without this, a parent_frame buried beneath a popped
		// child would keep its pending resolvers forever.
		while (stack.length > 0) {
			const buried = stack[stack.length - 1];
			if (buried.pendingResolvers.size === 0 && !buried.wasAborted) break;
			drainPendingResolversAsAborted(buried, "buried beneath superseded frame");
			buried.wasAborted = true;
			abortFrame(buried);
			stack.pop();
		}
	}

	void startFreshQuery(model, context, options, stream);
	return stream;
}

/** Drain a frame's pendingResolvers with the canonical interrupted-by-user
 * text. Used by Case 3 supersede and clearSession. The text is what lands in
 * the claude session JSONL as the tool_result content, so it must be
 * unambiguous about user attribution to keep resume coherence. */
const ABORTED_TOOL_RESULT_TEXT = "[Tool execution interrupted by user before completion]";

/**
 * Stop a frame's underlying claude-p driver: abort the driver handle (SIGINT to
 * the process group, decoupled abort lifecycle) and stop the per-spawn router.
 * Used by every abort/supersede/clearSession site.
 */
function abortFrame(frame: QueryFrame): void {
	frame.watchdog?.stop();
	frame.claudeHandle?.abort();
	void frame.router?.stop();
}

function drainPendingResolversAsAborted(frame: QueryFrame, reason: string) {
	const drained = frame.pendingResolvers.size;
	if (drained === 0) return;
	for (const resolver of frame.pendingResolvers.values()) {
		resolver({ content: [{ type: "text", text: ABORTED_TOOL_RESULT_TEXT }], isError: true });
	}
	frame.pendingResolvers.clear();
	frame.log.info({ drained, reason, text: ABORTED_TOOL_RESULT_TEXT }, `drainPendingResolversAsAborted: resolved ${drained} pending tool handler(s) with 'interrupted by user' text (${reason})`);
}

// ===========================================================================
// claude-p driver path — the sole inference path. Consumes the claude-p
// subprocess driver + in-process MCP router. `startFreshQuery` (below) is the
// single fresh-turn implementation; the dispatcher (streamClaudeAgentSdk Case 3)
// calls it directly.
// ===========================================================================

/**
 * claude-p's own --timeout (seconds). This is a BACKSTOP, not the primary
 * liveness control: it counts held-tool idle time, so it must be >= the longest
 * held tool round (a subagent / slow tool — itself bounded by the tool's OWN
 * pi-enforced timeout) or it will kill a healthy in-progress tool. The bridge's
 * held-round-aware idle watchdog (WATCHDOG_IDLE_MS) is the fast wedge detector;
 * this is only the last-resort ceiling. Env override:
 * CLAUDE_BRIDGE_CLAUDE_P_TIMEOUT_SECONDS (set very high, e.g. 86400, to make it
 * effectively inert and let the watchdog be the sole authority). Default 4h.
 */
const CLAUDE_P_TIMEOUT_SECONDS = (() => {
	const raw = process.env.CLAUDE_BRIDGE_CLAUDE_P_TIMEOUT_SECONDS;
	if (raw === undefined || raw === "") return 14_400; // 4h backstop
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : 14_400;
})();
const PROMPT_FILE_THRESHOLD_BYTES = 50 * 1024; // >50KB → tmpfile (argv-limit safety, constitution III)

/**
 * Resolve the absolute path to the built MCP shim. Prefers the published
 * dist entrypoint (`pi-claude-bridge/dist/src/mcp/shim.js`); falls back to the
 * in-repo TypeScript source under tsx for dev/test. NEVER touches ~/.claude.
 */
function resolveShimPath(): string {
	const req = createRequire(import.meta.url);
	try {
		return req.resolve("pi-claude-bridge/dist/src/mcp/shim.js");
	} catch {
		// Dev/test fallback: built dist next to this module, else TS source.
		const distLocal = join(dirname(new URL(import.meta.url).pathname), "dist", "src", "mcp", "shim.js");
		if (existsSync(distLocal)) return distLocal;
		// No built dist → the shim runs from TypeScript source under tsx (shimNodeArgs
		// adds `--import tsx`). Fail LOUD here if tsx is missing rather than letting
		// `node shim.ts` crash silently on every spawn and leave the model with zero
		// mcp__custom-tools__* tools (it would emit tool calls as text every turn —
		// the 2026-06-04 root cause, session 019e9011).
		try {
			req.resolve("tsx");
		} catch {
			throw new Error(
				"pi-claude-bridge: the MCP shim resolved to TypeScript source (no built dist) but 'tsx' is " +
					"not installed — the shim cannot run, so the model would receive NO mcp__custom-tools__* " +
					"tools and emit tool calls as raw text. Fix: run `npm install` (tsx is a runtime dependency) " +
					"or `npm run build` to produce dist/.",
			);
		}
		return join(dirname(new URL(import.meta.url).pathname), "src", "mcp", "shim.ts");
	}
}

/**
 * The `node` argv to spawn the shim. When the shim resolves to TypeScript SOURCE
 * (no built dist — the case for an installed copy that was never `npm run build`-ed,
 * which is how pi loads this extension via tsx), it MUST run under tsx: the shim's
 * ESM imports use the `.js` extension convention that only tsx remaps to the real
 * `.ts` files. Plain `node shim.ts` dies with ERR_MODULE_NOT_FOUND on `./ipc.js`,
 * which leaves `claude` with NO mcp__custom-tools__* tools — so the model emits tool
 * calls as TEXT every turn and never reaches a real tool. (Proven 2026-06-04,
 * session 019e9011: installed copy had no dist → shim crashed → 0 tools routed.)
 */
export function shimNodeArgs(shimPath: string): string[] {
	if (!shimPath.endsWith(".ts")) return [shimPath];
	// tsx MUST be an ABSOLUTE path here. `--import tsx` resolves the bare specifier
	// relative to the SHIM subprocess's cwd — which is the pi SESSION's cwd (e.g.
	// ~/.local/share/chezmoi), NOT the bridge. A bare `tsx` therefore fails with
	// ERR_MODULE_NOT_FOUND wherever the user actually runs, the shim never attaches,
	// and the model emits tool calls as TEXT. (Proven 2026-06-04, session 019e9039,
	// cwd=chezmoi: bare `--import tsx` crashed; `--import file://<abs tsx>` works.)
	// Resolve tsx from the bridge's OWN node_modules and pass a file:// URL so it is
	// cwd-independent.
	const tsxLoader = createRequire(import.meta.url).resolve("tsx");
	return ["--import", `file://${tsxLoader}`, shimPath];
}

/**
 * Resolve the claude-p binary the driver spawns. Returns the package's JS launcher
 * (`claude-p/bin/claude-p.js`) so resolution does NOT depend on `claude-p` being on
 * PATH — the pi runtime may strip `node_modules/.bin`. The driver spawns a `.js`
 * binPath via the current node executable. Falls back to the bare name `claude-p`
 * (PATH lookup) if the package can't be resolved (surfaces as a missing-binary error
 * at first turn, never at bridge load).
 */
function resolveClaudePBin(): string {
	const req = createRequire(import.meta.url);
	try {
		return req.resolve("claude-p/bin/claude-p.js");
	} catch {
		return "claude-p";
	}
}

/** Spill large/multiline content to a tmpfile under os.tmpdir() (NEVER ~/.claude). */
function writeOverflowTmp(prefix: string, content: string): string {
	const p = join(tmpdir(), `${prefix}-${randomBytes(8).toString("hex")}.txt`);
	writeFileSync(p, content, "utf-8");
	return p;
}

/**
 * Assemble the narrow, PURE dependency surface the claude-p capture path
 * (src/capture.ts) needs. The cross-call state variables (cachedSessionId,
 * cachedSessionCwd, lastSentMessageHashes) and the active-frame stack are
 * deliberately NOT included — the capture path is isolated and cannot touch
 * them. The spawn factory is the single-shot seam (`_captureSpawnFactory`).
 */
function buildCaptureDeps(): CaptureDeps {
	return {
		newTurnOutput,
		buildColdStartPrompt,
		cleanSchemaForSdk,
		calculateCost,
		resolveShimPath,
		shimNodeArgs,
		resolveClaudePBin,
		writeOverflowTmp,
		logger: logger.child({ piSessionId: getPiSessionId() }) as unknown as CaptureDeps["logger"],
		execPath: process.execPath,
		mcpServerName: MCP_SERVER_NAME,
		mcpWaitPreamble: withClaudePMcpWaitPreamble,
		promptFileThresholdBytes: PROMPT_FILE_THRESHOLD_BYTES,
		timeoutSeconds: CLAUDE_P_TIMEOUT_SECONDS,
		spawnClaudeP: (cfg, opts) => _captureSpawnFactory(cfg, opts),
	};
}

type DriverUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number };

/**
 * Update the frame's usage from a driver `usage` event.
 *
 * `context` is the CONTEXT-window usage (the final API call's input-side tokens
 * — the real window occupancy); `billing` is the CUMULATIVE turn usage (the sum
 * across every round, from claude-p's `result.usage`). They differ on
 * multi-round turns. We report the CONTEXT tokens to pi (so its context-window
 * indicator is accurate — claude-p's cumulative would read many× the window),
 * but compute COST and the turn's output-token count from BILLING (so $ spend
 * and total output stay accurate). pi sums each message's provider-supplied
 * `usage.cost`, so stuffing the cumulative cost here keeps session cost correct.
 */
/**
 * Compute the usage token fields the bridge reports to pi from the driver's
 * `context` (final-call, window-occupancy) and `billing` (cumulative turn) usage.
 *
 * `totalTokens` IS pi's context-window indicator — pi's `calculateContextTokens`
 * returns `usage.totalTokens` directly. So it MUST be the real window occupancy:
 * the final call's input-side tokens PLUS the final call's OUTPUT (`context.output`,
 * what was just appended to the context) — NOT `billing.output`, which is the
 * CUMULATIVE output summed across every tool round (126k–168k on heavy opus turns)
 * and would re-inflate the bar exactly like the pre-`ca7937d` cumulative-cacheRead
 * bug. The `output` FIELD stays CUMULATIVE: pi sums per-turn `usage.output` for the
 * session total, and cost is derived from it — both want the true turn total.
 */
export function computeReportedUsageFields(context: DriverUsage, billing?: DriverUsage): DriverUsage {
	const bill = billing ?? context;
	return {
		input: context.input,
		cacheRead: context.cacheRead,
		cacheWrite: context.cacheWrite,
		// Turn TOTAL output (cumulative) — cost basis + pi's session-output sum.
		output: bill.output,
		// Context-window occupancy = final call only (input-side + that call's output).
		totalTokens: context.input + context.cacheRead + context.cacheWrite + context.output,
	};
}

function updateUsageFromDriver(frame: QueryFrame, context: DriverUsage, billing?: DriverUsage) {
	const output = frame.turnOutput;
	if (!output) return;
	const bill = billing ?? context;
	const fields = computeReportedUsageFields(context, billing);
	output.usage.input = fields.input;
	output.usage.cacheRead = fields.cacheRead;
	output.usage.cacheWrite = fields.cacheWrite;
	output.usage.output = fields.output;
	output.usage.totalTokens = fields.totalTokens;
	// Remember the MAIN turn's window so the next turn's in-progress message seeds
	// its totalTokens (keeps pi's context bar steady mid-turn). Only the main turn
	// (stack bottom) drives the user-visible bar; subagent frames must not.
	if (stack[0] === frame) lastReportedContextTotal = fields.totalTokens;
	// Cost is the whole turn's spend → compute from the CUMULATIVE billing usage,
	// NOT from the (smaller) context tokens, then attach to the reported usage.
	const billingUsage = { input: bill.input, output: bill.output, cacheRead: bill.cacheRead, cacheWrite: bill.cacheWrite, totalTokens: bill.totalTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	output.usage.cost = calculateCost(frame.model, billingUsage as typeof output.usage);
	// Emit the canonical usage log line so observability + cache-shape assertions
	// have a stable structured record per turn. `ctx*` = reported context tokens;
	// `bill*` = cumulative (cost basis).
	frame.log.info(
		{ in: output.usage.input, out: output.usage.output, cacheRead: output.usage.cacheRead, cacheWrite: output.usage.cacheWrite, ctxTotal: output.usage.totalTokens, billCacheRead: bill.cacheRead, billTotal: bill.totalTokens },
		`usage: in=${output.usage.input} out=${output.usage.output} cacheRead=${output.usage.cacheRead} cacheWrite=${output.usage.cacheWrite} ctxTotal=${output.usage.totalTokens} model=${frame.model.id} (billCacheRead=${bill.cacheRead})`,
	);
}

/**
 * THE round-trip trigger (T1.9). Invoked synchronously by router.onPark the
 * instant a `tools/call` parks. Pushes a pi toolCall block keyed by the
 * router-minted `info.piId` (NOT the model `toolu_…`) and ends the pi stream so
 * pi executes the tool. pi later delivers `toolResult.id === piId` → Case 1
 * (unchanged) finds the resolver in frame.pendingResolvers (== router.pendingResolvers)
 * and resolves it, unblocking the shim. Mirrors the SDK message_stop path.
 */
function onRouterPark(frame: QueryFrame, info: ParkedCallInfo): void {
	if (!frame.currentPiStream || !frame.turnOutput) return;
	ensureTurnStarted(frame);
	closeOpenInlineBlocks(frame);
	frame.turnBlocks.push({
		type: "toolCall",
		id: info.piId, // router-minted pi id — the id pi echoes back as toolResult.id
		name: mapToolName(info.name, frame.customToolNameToPi),
		arguments: mapToolArgs(info.name, info.arguments),
	});
	const idx = frame.turnBlocks.length - 1;
	syncTurnContent(frame);
	frame.turnSawToolCall = true;
	frame.turnOutput.stopReason = "toolUse";
	frame.currentPiStream.push({ type: "toolcall_start", contentIndex: idx, partial: frame.turnOutput });
	frame.currentPiStream.push({ type: "toolcall_end", contentIndex: idx, toolCall: frame.turnBlocks[idx], partial: frame.turnOutput });
	frame.currentPiStream.push({ type: "done", reason: "toolUse", message: frame.turnOutput });
	frame.currentPiStream.end();
	frame.currentPiStream = null;
	frame.log.debug({ piId: info.piId, name: info.name }, `onRouterPark: routed tools/call to pi (piId=${info.piId})`);
}

/** Close any still-open inline (text/thinking) blocks before a tool call / turn end. */
function closeOpenInlineBlocks(frame: QueryFrame): void {
	if (!frame.currentPiStream) return;
	for (let i = 0; i < frame.turnBlocks.length; i++) {
		const b = frame.turnBlocks[i];
		if (b.index === undefined) continue;
		const wasOpen = b.index;
		delete b.index;
		if (b.type === "text") {
			frame.currentPiStream.push({ type: "text_end", contentIndex: i, content: b.text, partial: frame.turnOutput });
		} else if (b.type === "thinking") {
			frame.currentPiStream.push({ type: "thinking_end", contentIndex: i, content: b.thinking, partial: frame.turnOutput });
		}
		void wasOpen;
	}
}

/**
 * Translate one driver-internal stream event into pi event-stream pushes.
 * text/thinking deltas open+append inline blocks; tool-use is DISPLAY ONLY
 * (best-effort label of an already-parked block — does NOT push a new block,
 * does NOT route); usage updates token counts; done/error set the terminal
 * stopReason for finalizeClaudePFrame to push.
 */
function processDriverEvent(frame: QueryFrame, ev: DriverStreamEvent): void {
	if (!frame.turnOutput) return;

	switch (ev.kind) {
		case "text-delta": {
			if (!frame.currentPiStream) return;
			ensureTurnStarted(frame);
			let block = frame.turnBlocks.find((b) => b.type === "text" && b.index !== undefined);
			if (!block) {
				block = { type: "text", text: "", index: frame.turnBlocks.length };
				frame.turnBlocks.push(block);
				frame.currentPiStream.push({ type: "text_start", contentIndex: frame.turnBlocks.length - 1, partial: frame.turnOutput });
			}
			const idx = frame.turnBlocks.indexOf(block);
			block.text += ev.text;
			frame.currentPiStream.push({ type: "text_delta", contentIndex: idx, delta: ev.text, partial: frame.turnOutput });
			return;
		}
		case "thinking-delta": {
			if (!frame.currentPiStream) return;
			ensureTurnStarted(frame);
			let block = frame.turnBlocks.find((b) => b.type === "thinking" && b.index !== undefined);
			if (!block) {
				block = { type: "thinking", thinking: "", thinkingSignature: "", index: frame.turnBlocks.length };
				frame.turnBlocks.push(block);
				frame.currentPiStream.push({ type: "thinking_start", contentIndex: frame.turnBlocks.length - 1, partial: frame.turnOutput });
			}
			const idx = frame.turnBlocks.indexOf(block);
			block.thinking += ev.text;
			frame.currentPiStream.push({ type: "thinking_delta", contentIndex: idx, delta: ev.text, partial: frame.turnOutput });
			return;
		}
		case "tool-use": {
			// DISPLAY ONLY (D32). Best-effort: label an already-parked toolCall
			// block whose name+args match. Do NOT push a new block; do NOT route.
			const parked = frame.router?.listParkedCalls() ?? [];
			const match = parked.find((p) => p.name === ev.name);
			if (match) {
				frame.log.debug({ toolu: ev.toolUseId, piId: match.piId }, "processDriverEvent: tool-use observed (display-only correlation)");
			}
			return;
		}
		case "usage": {
			updateUsageFromDriver(frame, ev.usage, ev.billing);
			return;
		}
		case "done": {
			if (frame.currentPiStream) {
				closeOpenInlineBlocks(frame);
				syncTurnContent(frame);
			}
			frame.turnOutput.stopReason = frame.turnSawToolCall ? "toolUse" : "stop";
			return;
		}
		case "error": {
			frame.turnOutput.stopReason = "error";
			frame.turnOutput.errorMessage = ev.errorMessage;
			return;
		}
	}
}

/**
 * Finalize a claude-p frame once its (possibly retried) driver `done` resolves.
 * Caches the session id (even on abort) UNLESS stopReason==="error" (clear so
 * the next turn cold-starts); finalizes the current pi stream like the SDK
 * finalizer; pops the frame iff it's the top and has no pending resolvers.
 */
function finalizeClaudePFrame(frame: QueryFrame, res: ClaudePDoneResult): void {
	// The (possibly retried) spawn has reached a terminal state — stop the
	// liveness watchdog (idempotent; abortFrame may have stopped it already).
	frame.watchdog?.stop();
	// Best-effort: remove this turn's MCP-readiness sentinel (paired to the
	// router socket). Per-attempt spawns already clear stale copies; this drops
	// the final one so /tmp doesn't accumulate. Never throws.
	if (frame.router) {
		try {
			rmSync(`${frame.router.socketPath}.ready`, { force: true });
		} catch {
			/* ignore */
		}
	}
	const cwd = frame.cwd;
	// Warm-pi-resume sidecar persist/invalidate is for the MAIN-provider turn only,
	// never a subagent. The main turn is always the BOTTOM of the stack (stack[0]);
	// a subagent nests above and is `top()` at its own finalize — so `stack[0] ===
	// frame` (NOT `top() === frame`, which holds for a subagent too) is the correct
	// "this is the main turn" discriminator (design D1). Persisting a subagent frame
	// would make a later --resume reattach the wrong (subagent) transcript.
	const isMainTurn = stack[0] === frame;
	// Clear the cache on a spawn-level error OR a turn-level error so the next turn
	// cold-starts — giving the MCP attach a fresh try.
	if (res.stopReason === "error" || frame.turnOutput?.stopReason === "error") {
		// Mark the frame as driver-errored so a tool-result that pi delivers AFTER
		// the driver died (currentPiStream is null while pi executes a held tool)
		// closes pi's stream with a terminal error instead of wiring into a dead
		// driver and hanging forever. See streamClaudeAgentSdk Case 1
		// (`willHangIfWired`). This is the error-path analogue of the abort path.
		frame.driverErrored = true;
		// Clear cache so the next turn cold-starts (spec: "any cached driver
		// session id is cleared").
		if (cachedSessionId === res.sessionId || cachedSessionCwd === cwd) {
			cachedSessionId = null;
			cachedSessionCwd = null;
		}
		// D7: invalidate the persisted sidecar UNCONDITIONALLY by key (the in-memory
		// clear above is session-id-guarded, but a stale sidecar left on disk would
		// warm-resume on the next restart). Includes the McpNotReady fail-fast path
		// (a gated, never-submitted attempt persists no resumable sidecar).
		if (isMainTurn) {
			const fullSid = getFullPiSessionId();
			if (fullSid) invalidateSidecar(cwd, fullSid);
		}
		frame.log.warn({ stopReason: res.stopReason, turnStopReason: frame.turnOutput?.stopReason, exitCode: res.exitCode, signal: res.signal }, `finalizeClaudePFrame: error (exitCode=${res.exitCode ?? "null"} signal=${res.signal ?? "null"}) — cleared cached session`);
	} else if (res.sessionId) {
		// Cache the session id for next-turn warm resume — even on abort, so the
		// next turn can resume and the model sees the interrupted partial.
		cachedSessionId = res.sessionId;
		cachedSessionCwd = cwd;
		// D1: persist the content-free resume sidecar for cross-restart warm resume.
		// Main turn only (isMainTurn); abort is non-error and reaches here, so an
		// aborted-mid-tool session stays resumable (R7). Best-effort: a write
		// failure logs and the turn completes normally.
		if (isMainTurn && frame.sha256Chain) {
			const fullSid = getFullPiSessionId();
			if (fullSid) {
				try {
					writeSidecar(cwd, fullSid, {
						claudeSessionId: res.sessionId,
						piSessionId: fullSid,
						historyHashChain: frame.sha256Chain,
						claudeVersion: getInstalledClaudeVersion(),
					});
				} catch (err) {
					frame.log.warn({ err: err instanceof Error ? err.message : String(err) }, "finalizeClaudePFrame: resume sidecar write failed (ignored)");
				}
			}
		}
		frame.log.debug({ aborted: frame.wasAborted, session: res.sessionId.slice(0, 8) }, `finalizeClaudePFrame: caching session=${res.sessionId.slice(0, 8)}${frame.wasAborted ? " (aborted)" : ""}`);
	}

	// Finalize the most recent stream (mirrors SDK finalizer).
	if (frame.currentPiStream && frame.turnOutput) {
		if (frame.wasAborted || res.stopReason === "aborted") {
			commitAbortedPartial(frame);
			frame.turnOutput.stopReason = "aborted";
			frame.turnOutput.errorMessage = frame.turnOutput.errorMessage ?? "Operation aborted";
			frame.currentPiStream.push({ type: "error", reason: "aborted", error: frame.turnOutput });
		} else if (frame.turnOutput.stopReason === "error") {
			syncTurnContent(frame);
			frame.currentPiStream.push({ type: "error", reason: "error", error: frame.turnOutput });
		} else {
			syncTurnContent(frame);
			if (!frame.turnStarted) ensureTurnStarted(frame);
			frame.currentPiStream.push({ type: "done", reason: "stop", message: frame.turnOutput });
		}
		frame.currentPiStream.end();
		frame.currentPiStream = null;
	}

	if (top() === frame) {
		if (frame.pendingResolvers.size === 0) {
			void frame.router?.stop();
			stack.pop();
		} else {
			frame.log.info({ pending: frame.pendingResolvers.size }, "finalizeClaudePFrame: frame retained on stack (pending resolvers may receive late tool_results)");
		}
	}
}

/**
 * claude-p main-provider fresh turn — the sole inference path. Assembles the
 * prompt / session / system-prompt, then spawns the claude-p driver with a
 * per-spawn MCP router whose onPark drives the pi round-trip. Async (awaits
 * router.start()); the dispatcher calls it via `void startFreshQuery(...)`.
 */
async function startFreshQuery(
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	stream: AssistantMessageEventStream,
): Promise<void> {
	const cwd = (options as { cwd?: string } | undefined)?.cwd ?? process.cwd();
	const { mcpTools, customToolNameToPi } = resolveMcpTools(context, "");

	const promptText = extractUserPrompt(context.messages) ?? "";
	const hasImages = lastUserMessageHasImages(context.messages);

	if (!promptText && !hasImages) {
		logger.child({ piSessionId: getPiSessionId(), model: model.id }).warn(`streamSimple[claude-p]: empty prompt; last role=${context.messages[context.messages.length - 1]?.role}`);
		queueMicrotask(() => {
			const empty = newTurnOutput(model);
			stream.push({ type: "start", partial: empty });
			stream.push({ type: "done", reason: "stop", message: empty });
			stream.end();
		});
		return;
	}

	// Image handling: claude-p cannot inject images — strip + warn, deliver text-only.
	let imageCount = 0;
	for (const m of context.messages) {
		const content = Array.isArray(m.content) ? m.content : [];
		for (const b of content) if ((b as any).type === "image") imageCount++;
	}
	if (imageCount > 0) {
		logger.child({ piSessionId: getPiSessionId(), model: model.id }).warn({ imageCount }, `streamSimple[claude-p]: dropping ${imageCount} image block(s) — claude-p path is text-only (image-strip-on-main-path)`);
	}

	// Divergence detection: if any prior-position content changed (or pi's
	// history is shorter than what we last sent), pi has /tree-navigated,
	// /fork-ed, or /compact-ed — the resumed transcript no longer matches and we
	// must cold-start. Forward progress (history grew with new messages) is NOT
	// divergence.
	const newHashes = computeMessageHashes(context.messages);
	const diverged = detectHistoryDivergence(lastSentMessageHashes, newHashes);
	if (diverged) {
		logger.child({ piSessionId: getPiSessionId(), model: model.id }).info(
			{ priorLen: lastSentMessageHashes?.length ?? 0, newLen: newHashes.length, droppedSession: cachedSessionId?.slice(0, 8) ?? null },
			`startFreshQuery: history divergence detected — dropping cached session (was ${cachedSessionId?.slice(0, 8) ?? "none"})`,
		);
		cachedSessionId = null;
		cachedSessionCwd = null;
	}

	// Warm-pi-resume (design D4/D2): on the FIRST turn after a session_start:resume
	// (where the literal frame cwd is finally known), read the keyed sidecar and
	// run the pure validation gate. On a pass, set cachedSessionId/cachedSessionCwd
	// so `useResume` below takes the warm `--resume` branch instead of cold-packing
	// the full history. Any failure (no/invalid sidecar, divergence, version skew,
	// unseen intervening messages) leaves the cache empty -> normal cold-start, the
	// always-safe floor. A deleted transcript is NOT pre-checked here: it surfaces
	// as a `--resume` runtime error -> sidecar invalidated -> next turn cold (T0.1).
	const fingerprintItems = messagesToFingerprintItems(context.messages);
	if (warmResumePending) {
		warmResumePending = false; // one-shot, regardless of outcome
		const fullSid = getFullPiSessionId();
		if (cachedSessionId === null && fullSid) {
			const sidecar = readSidecar(cwd, fullSid);
			const decision = validateWarmResume({
				sidecar,
				currentMessages: fingerprintItems,
				currentClaudeVersion: getInstalledClaudeVersion(),
			});
			const wlog = logger.child({ piSessionId: getPiSessionId(), model: model.id, cwd });
			if (decision.warm && sidecar) {
				cachedSessionId = sidecar.claudeSessionId;
				cachedSessionCwd = cwd;
				wlog.info(
					{ resume: sidecar.claudeSessionId.slice(0, 8), reason: decision.reason },
					`startFreshQuery: warm-resume validated — resuming claude session ${sidecar.claudeSessionId.slice(0, 8)} (no cold re-pack)`,
				);
			} else {
				wlog.info(
					{ reason: decision.reason, hadSidecar: sidecar !== null },
					`startFreshQuery: warm-resume not applicable (${decision.reason}) — cold-starting`,
				);
			}
		}
	}

	// R6: set the in-memory divergence baseline by recomputing LOCALLY over pi's
	// loaded history (hashMessage format) — NOT from the sidecar's sha256 chain —
	// so subsequent in-process turns detect a fork after a warm resume.
	lastSentMessageHashes = newHashes;

	const useResume = cachedSessionId !== null && cachedSessionCwd === cwd;

	// Cold → embed full pi history; warm → only the new user message (text-only).
	const promptString = useResume
		? promptText
		: buildColdStartPrompt(context.messages);

	// System-prompt assembly.
	const skillsAppend = extractSkillsBlock(context.systemPrompt);
	const agentsAppend = extractAgentsAppend();
	const appendSystem = extractAppendSystem();
	const appendParts = [agentsAppend, appendSystem, skillsAppend].filter((p): p is string => Boolean(p));
	const systemPromptAppend = appendParts.length > 0 ? appendParts.join("\n\n") : undefined;
	// Prepend the MCP-startup-race guard so the model deterministically waits for
	// the `custom-tools` shim to connect before declaring a bridged tool missing
	// (root cause of S14/S25 on the claude-p path; see CLAUDE_P_MCP_WAIT_PREAMBLE).
	const staticSystemPrompt = withClaudePMcpWaitPreamble(systemPromptAppend ?? "You are a helpful coding assistant.");

	// Build the frame BEFORE the router (onPark closes over it).
	const frame: QueryFrame = {
		currentPiStream: stream,
		turnOutput: newTurnOutput(model),
		turnStarted: false,
		turnSawToolCall: false,
		turnBlocks: [],
		customToolNameToPi,
		model,
		cwd,
		log: logger.child({ piSessionId: getPiSessionId(), model: model.id, cwd, driver: "claude-p" }),
		pendingResolvers: new Map(),
		pendingResults: new Map(),
		wasAborted: false,
		driverErrored: false,
		donePromise: Promise.resolve(),
		// Content-free fingerprint of pi's history at this turn's start, for the
		// resume sidecar persisted on a successful main-turn finalize (design D1).
		sha256Chain: computeSha256Chain(fingerprintItems),
	};
	resetTurnState(frame);

	// Per-spawn router. Its pending maps ARE the frame's pending maps (by
	// reference) so Case 1 delivery + drainPendingResolversAsAborted work unchanged.
	const router = createRouter({
		logger: frame.log,
		onPark: (info) => onRouterPark(frame, info),
	});
	frame.router = router;
	frame.pendingResolvers = router.pendingResolvers as any;
	frame.pendingResults = router.pendingResults as any;

	// Advertise BARE pi tool names: claude namespaces every MCP tool as
	// `mcp__<server>__<advertisedName>` itself, so the model sees exactly
	// `mcp__custom-tools__<name>` (matching customToolNameToPi keys + the
	// system-prompt tool-notice). Advertising the already-prefixed name would
	// double-prefix to `mcp__custom-tools__mcp__custom-tools__<name>` (G1 finding
	// F1). The shim then receives `tools/call` with the bare name (MCP strips the
	// server prefix), which onRouterPark maps straight back to the pi name.
	const toolDefs: ToolDef[] = mcpTools.map((t) => ({
		name: t.name,
		description: t.description,
		inputSchema: cleanSchemaForSdk(t.parameters),
	}));
	router.declareTools(toolDefs);
	await router.start();

	// Build --mcp-config pointing at the stdio shim for this spawn.
	const shimPath = resolveShimPath();
	const toolsB64 = Buffer.from(JSON.stringify(toolDefs), "utf-8").toString("base64");
	// MCP-readiness sentinel, paired to this spawn's router socket. The shim
	// creates it once it has served tools/list (tool surface live in claude);
	// claude-p holds the submit Enter until it exists. Closes the boot race where
	// the prompt is submitted before mcp__custom-tools__* is registered.
	const mcpReadyFile = `${router.socketPath}.ready`;
	const mcpConfig = JSON.stringify({
		mcpServers: {
			[MCP_SERVER_NAME]: {
				command: process.execPath,
				args: [...shimNodeArgs(shimPath), "--socket", router.socketPath, "--mode", "main", "--tools", toolsB64, "--ready-file", mcpReadyFile],
			},
		},
	});

	// System prompt: inline text, or file when large.
	const systemPrompt: SystemPromptSource = staticSystemPrompt.length > PROMPT_FILE_THRESHOLD_BYTES
		? { kind: "file", path: writeOverflowTmp("pcb-sysprompt", staticSystemPrompt) }
		: { kind: "text", text: staticSystemPrompt };

	// Prompt: positional, or --input-file when large/multiline.
	const promptSrc: PromptSource = promptString.length > PROMPT_FILE_THRESHOLD_BYTES
		? { kind: "file", path: writeOverflowTmp("pcb-prompt", promptString) }
		: { kind: "positional", text: promptString };

	// Session identity: fresh (new uuid) XOR resume (cached id).
	const session = useResume && cachedSessionId
		? { kind: "resume" as const, sessionId: cachedSessionId }
		: { kind: "fresh" as const, sessionId: randomUUID() };

	const cfg: ClaudePSpawnConfig = {
		model: model.id,
		systemPrompt,
		prompt: promptSrc,
		mcpConfig,
		session,
		timeoutSeconds: CLAUDE_P_TIMEOUT_SECONDS,
		mcpReadyFile,
	};

	frame.log.debug(
		{ msgs: context.messages.length, tools: mcpTools.length, resume: useResume ? cachedSessionId?.slice(0, 8) : null },
		`streamSimple[claude-p]: fresh spawn model=${model.id} msgs=${context.messages.length} tools=${mcpTools.length} resume=${useResume ? cachedSessionId?.slice(0, 8) : "no"} prompt="${promptText.slice(0, 60)}"`,
	);

	stack.push(frame);

	// Wire abort. Mirror the SDK onAbort: deferred drain; surface aborted to the
	// pi stream when pi is awaiting a tool result (currentPiStream null). Does
	// NOT drop cachedSessionId here (finalizeClaudePFrame handles caching).
	const onAbort = () => {
		frame.log.info({ pendingResolvers: frame.pendingResolvers.size }, `onAbort[claude-p]: pendingResolvers=${frame.pendingResolvers.size} (deferred drain)`);
		frame.wasAborted = true;
		abortFrame(frame);
		if (!frame.currentPiStream) {
			try {
				const out = commitAbortedPartial(frame) ?? newTurnOutput(model);
				out.stopReason = "aborted";
				out.errorMessage = out.errorMessage ?? "Operation aborted by user";
				stream.push({ type: "error", reason: "aborted", error: out });
				stream.end();
				frame.log.info({ where: "tool-execution-window" }, "pushAbortedError[claude-p]: pi was awaiting tool result, surfacing aborted");
			} catch (err) {
				frame.log.warn({ err: err instanceof Error ? err.message : String(err) }, "pushAbortedError[claude-p]: stream may already be ended");
			}
		}
	};
	if (options?.signal) {
		if (options.signal.aborted) onAbort();
		else options.signal.addEventListener("abort", onAbort, { once: true });
	}

	// Spawn via the resilience wrapper. POLICY: retry only while no tools/call
	// has been routed to pi (router.everRoutedToolCall) — D33 idempotency gate.
	// G5 warm-resume RE-ECHO suppression: on a `--resume` spawn claude-p drains the
	// FULL replayed transcript to stdout before the live turn, so without this the
	// parser would re-emit every prior assistant block, prepending the whole prior
	// conversation to pi's new turn. The parser instead emits ONLY the live turn —
	// the final segment after the last user-prompt line. This "last segment" rule is
	// robust to (a) the resumed transcript holding a different prior-prompt count
	// than pi's history (e.g. after an aborted turn), and (b) identical prompt text
	// recurring across turns. Fresh (cold) turns pass false → no suppression.
	const suppressResumeReplay = useResume;

	// Layer 2: held-round-aware idle watchdog. Created BEFORE the spawn so the
	// onEvent poke always sees it. It never fires while a tool is parked
	// (pendingResolvers > 0) — a healthy long subagent is deferred to entirely —
	// and otherwise kills+retries a silent (wedged) claude-p via killWedged().
	frame.watchdog = makeWatchdog({
		idleMs: WATCHDOG_IDLE_MS,
		isHeldRound: () => frame.pendingResolvers.size > 0,
		onWedge: () => frame.claudeHandle?.killWedged?.(),
		log: frame.log,
	});

	const handle = _spawnClaudePFactory(
		cfg,
		{ onEvent: (ev: DriverStreamEvent) => { frame.watchdog?.poke(); processDriverEvent(frame, ev); }, logger: frame.log as any, binPath: resolveClaudePBin(), suppressResumeReplay, livePromptText: useResume ? promptText : undefined },
		{
			maxRetries: 2,
			shouldRetry: () => !router.everRoutedToolCall,
			freshSessionId: () => randomUUID(),
			onRetry: (attempt) => frame.log.warn({ attempt }, `startFreshQueryClaudeP: retrying claude-p spawn (attempt ${attempt})`),
		},
	);
	frame.claudeHandle = handle;
	frame.watchdog.poke(); // arm the boot-wedge window
	frame.donePromise = handle.done.then((res) => finalizeClaudePFrame(frame, res));
}

// ---------------------------------------------------------------------------
// Pi extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	piApiRef = pi;

	// Disable non-essential CC traffic.
	process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";

	// Reset session cache on pi lifecycle events that diverge history.
	const clearSession = (event: string) => {
		log.info({ event, droppedSession: cachedSessionId?.slice(0, 8) ?? null }, `${event}: dropping cached session ${cachedSessionId?.slice(0, 8) ?? "none"}`);
		cachedSessionId = null;
		cachedSessionCwd = null;
		lastSentMessageHashes = null;
		// Forget the seeded context window: a post-/compact (or /new, /fork, …) turn
		// must show "?" until its real usage lands, not a stale prior size.
		lastReportedContextTotal = 0;
		// Drain any leftover frames (subagents that didn't clean up). Also
		// drain pendingResolvers with synthetic text — Option H keeps frames
		// on the stack post-abort waiting for pi to deliver real
		// tool_results, but if the session is being cleared/replaced, those
		// resolvers will never see real content. Drain them so the SDK isn't
		// left with hung handler promises.
		while (stack.length > 0) {
			const frame = stack.pop()!;
			drainPendingResolversAsAborted(frame, `clearSession:${event}`);
			frame.wasAborted = true;
			abortFrame(frame);
		}
	};
	pi.on("session_start", (event, ctx) => {
		piUI = ctx.ui;
		piExtCtx = ctx as any;
		if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
			clearSession(`session_start:${event.reason}`);
		}
		// Warm-pi-resume: arm a validated warm-resume attempt on the next turn for any
		// session_start that (re)loads into a session which MAY have a prior driver
		// session to reattach. pi's reasons (verified against pi-coding-agent):
		//   - "startup": a fresh PROCESS launch — INCLUDING a restart that resumes a
		//     prior session via --session-id/--continue (the primary warm-resume case;
		//     the spec's "bare bridge restart"). This is NOT "resume".
		//   - "resume":  an in-session switch to another session (/resume).
		//   - "reload":  an in-process extension reload (/reload) — module state may
		//     have been recreated, leaving the in-memory cache empty.
		//   - "new"/"fork": a brand-new or forked session — MUST cold-start.
		// Arming broadly is safe: the gate validates (no/invalid sidecar, divergence,
		// version skew, unseen intervening messages all fall back to cold), and the
		// warm block only acts when the in-memory cache is empty (cachedSessionId ===
		// null), so it never overrides a live in-process session.
		if (event.reason === "new" || event.reason === "fork") {
			warmResumePending = false;
		} else {
			warmResumePending = true; // startup | resume | reload
			log.info({ reason: event.reason }, `session_start:${event.reason} — arming validated warm-resume attempt for the next turn`);
		}
	});
	pi.on("session_shutdown", (_event?: any) => {
		clearSession("session_shutdown");
		// Pi rebuilds a fresh ModelRegistry on EVERY session change — /new,
		// /resume, /fork, and /reload all flow through createAgentSessionServices
		// which builds a new registry then re-runs extensions to populate it.
		// /reload additionally calls resetApiProviders() in pi-ai. In all cases
		// the Symbol guard (which lives on globalThis) survives, and would skip
		// pi.registerProvider on the second module init — leaving the new
		// registry without claude-bridge models. Symptoms:
		//   - /reload: subsequent input "submitted" but never reaches inference
		//   - /new:    falls back to codex/gpt-5.4 instead of configured default
		// Drop the guard on every shutdown so the next module init re-registers.
		delete (globalThis as Record<symbol, any>)[Symbol.for("claude-bridge:active")];
	});

	// Provider registration. Subagent-loaded module instances don't re-register
	// because pi-ai's ModelRegistry is shared — first writer wins for the
	// claude-bridge provider. Subsequent calls for claude-bridge models go
	// through the parent's streamSimple via the stack (which we own).
	const ACTIVE_KEY = Symbol.for("claude-bridge:active");
	const g = globalThis as Record<symbol, any>;
	if (!g[ACTIVE_KEY]) {
		g[ACTIVE_KEY] = streamClaudeAgentSdk;
		pi.registerProvider(PROVIDER_ID, {
			baseUrl: "claude-bridge",
			apiKey: "not-used",
			api: "claude-bridge" as any,
			models: MODELS as any,
			streamSimple: streamClaudeAgentSdk as any,
		});
		log.info({ models: MODELS.length }, `provider: registered (models=${MODELS.length})`);
	} else {
		log.info(`provider: skipping re-registration (already active)`);
	}
}

// Suppress unused-import lints in TS strict mode
void _resolveModelId;
void keyHint;
void pascalCase;
