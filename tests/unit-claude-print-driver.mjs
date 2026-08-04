#!/usr/bin/env node
// Covers, for the direct `claude-print` driver:
// - invocation uses the bidirectional stream-json protocol
// - prompt submission waits for exact MCP readiness
// - the native tool surface is closed (tenet T4)
// - no filesystem coupling to the driver's mutable state (tenet T3)

import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	CLAUDE_PRINT_ABORT_GRACE_MS,
	CLAUDE_PRINT_DEFAULT_READY_TIMEOUT_MS,
	buildClaudePrintArgs,
	resolveClaudePrintReadyTimeoutMs,
	spawnClaudePrint,
} from "../src/driver/claudePrint.js";
import {
	CLAUDE_PRINT_DRIVER,
	__resetClaudePrintVersionProbeForTests,
	__setClaudePrintPreflightForTests,
	__setSpawnClaudePrintForTests,
	getInferenceDriverAdapter,
} from "../index.js";

const SESSION = "11111111-1111-4111-8111-111111111111";
const RESUME = "22222222-2222-4222-8222-222222222222";
const QUIET = { debug() {}, info() {}, warn() {}, error() {} };

function valueAfter(args, flag) {
	const index = args.indexOf(flag);
	return index < 0 ? undefined : args[index + 1];
}

function baseConfig(overrides = {}) {
	return {
		model: "claude-sonnet-4-6",
		systemPrompt: { kind: "text", text: "SYSTEM" },
		prompt: { kind: "positional", text: "USER" },
		mcpConfig: JSON.stringify({
			mcpServers: {
				"custom-tools": {
					command: process.execPath,
					args: ["shim.js", "--socket", "/tmp/owned.sock", "--mode", "main", "--tools", "W10=", "--ready-file", "/tmp/stale.ready"],
				},
			},
		}),
		session: { kind: "fresh", sessionId: SESSION },
		...overrides,
	};
}

function terminalRecords(sessionId = SESSION) {
	const usage = {
		input_tokens: 2,
		output_tokens: 3,
		cache_read_input_tokens: 0,
		cache_creation_input_tokens: 0,
	};
	const records = [
		{ type: "system", subtype: "init", session_id: sessionId },
		{ type: "stream_event", session_id: sessionId, parent_tool_use_id: null, event: { type: "message_start", message: { id: "m1", role: "assistant" } } },
		{ type: "stream_event", session_id: sessionId, parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
		{ type: "stream_event", session_id: sessionId, parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } } },
		{ type: "stream_event", session_id: sessionId, parent_tool_use_id: null, event: { type: "content_block_stop", index: 0 } },
		{ type: "stream_event", session_id: sessionId, parent_tool_use_id: null, event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } } },
		{ type: "stream_event", session_id: sessionId, parent_tool_use_id: null, event: { type: "message_stop" } },
		{ type: "assistant", session_id: sessionId, parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage } },
		{ type: "result", subtype: "success", is_error: false, result: "ok", stop_reason: "end_turn", terminal_reason: "completed", session_id: sessionId, total_cost_usd: 0.01, usage },
	];
	return records.map((record) => `${JSON.stringify(record)}\n`).join("");
}

class RecordingStdin extends Writable {
	chunks = [];
	finishedByDriver = false;
	constructor() {
		// One-byte high-water mark forces write() backpressure for every NDJSON
		// frame; adapter must await callback + drain without ending stdin.
		super({ highWaterMark: 1 });
	}
	_write(chunk, _encoding, callback) {
		this.chunks.push(Buffer.from(chunk));
		setImmediate(callback);
	}
	_final(callback) {
		this.finishedByDriver = true;
		callback();
	}
	text() {
		return Buffer.concat(this.chunks).toString("utf8");
	}
}

class FakeChild extends EventEmitter {
	pid = 424242;
	stdin = new RecordingStdin();
	stdout = new PassThrough();
	stderr = new PassThrough();
	close(code = 0, signal = null) {
		this.stdout.end();
		this.stderr.end();
		this.emit("close", code, signal);
	}
}

function fakeSpawnHarness() {
	const child = new FakeChild();
	let command;
	let args;
	let options;
	return {
		child,
		spawn(commandValue, argsValue, optionsValue) {
			command = commandValue;
			args = argsValue;
			options = optionsValue;
			return child;
		},
		get command() { return command; },
		get args() { return args; },
		get options() { return options; },
	};
}

async function waitFor(predicate, timeoutMs = 1000) {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("timed out waiting for predicate");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function readyPathFromArgs(args) {
	const mcp = JSON.parse(valueAfter(args, "--mcp-config"));
	const shimArgs = mcp.mcpServers["custom-tools"].args;
	return valueAfter(shimArgs, "--ready-file");
}

describe("buildClaudePrintArgs — exact direct closure", () => {
	it("uses exact print/stream flags, closes native/settings surfaces, and selects fresh XOR resume", () => {
		const fresh = buildClaudePrintArgs(baseConfig(), {
			systemPrompt: { kind: "text", text: "SYSTEM" },
			mcpConfig: baseConfig().mcpConfig,
			debugFile: "/bridge/claude-print-debug.log",
		});
		for (const flag of ["-p", "--input-format", "--output-format", "--verbose", "--include-partial-messages", "--strict-mcp-config", "--setting-sources", "--permission-mode", "--tools", "--disallowedTools", "--session-id", "--debug-file"]) {
			assert.ok(fresh.includes(flag), `missing ${flag}`);
		}
		assert.equal(valueAfter(fresh, "--input-format"), "stream-json");
		assert.equal(valueAfter(fresh, "--output-format"), "stream-json");
		assert.equal(valueAfter(fresh, "--setting-sources"), "");
		assert.equal(valueAfter(fresh, "--tools"), "");
		assert.equal(valueAfter(fresh, "--permission-mode"), "bypassPermissions");
		assert.equal(valueAfter(fresh, "--session-id"), SESSION);
		assert.equal(fresh.includes("--resume"), false);
		assert.equal(fresh.includes("--bare"), false);

		const resumed = buildClaudePrintArgs(baseConfig({ session: { kind: "resume", sessionId: RESUME } }), {
			systemPrompt: { kind: "text", text: "SYSTEM" },
			mcpConfig: baseConfig().mcpConfig,
		});
		assert.equal(valueAfter(resumed, "--resume"), RESUME);
		assert.equal(resumed.includes("--session-id"), false);
	});
});

describe("spawnClaudePrint — readiness, artifacts, stdin, cleanup", () => {
	it("waits for exact private sentinel, submits one user frame with backpressure, and keeps stdin open through result", async () => {
		const root = mkdtempSync(join(tmpdir(), "pcb-print-test-"));
		const harness = fakeSpawnHarness();
		const phases = [];
		try {
			const handle = spawnClaudePrint(baseConfig({ systemPrompt: { kind: "text", text: "line one\nline two" } }), {
				onEvent() {},
				onPhase: (phase) => phases.push(phase),
				logger: QUIET,
				binPath: "/usr/local/bin/claude",
				diagnosticsDir: root,
				tmpDir: root,
				spawnImpl: harness.spawn.bind(harness),
				env: { CLAUDE_BRIDGE_MCP_READY_TIMEOUT_MS: "1000" },
				killProcessGroup() {},
			});

			assert.equal(harness.command, "/usr/local/bin/claude");
			assert.equal(harness.options.detached, true);
			assert.deepEqual(harness.options.stdio, ["pipe", "pipe", "pipe"]);
			assert.equal(harness.options.env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT, "0");
			assert.equal(harness.args.includes("USER"), false, "user prompt must never ride argv");
			assert.equal(harness.child.stdin.text(), "", "prompt must not precede readiness");

			const readyFile = readyPathFromArgs(harness.args);
			const invocationDir = join(readyFile, "..");
			assert.equal(lstatSync(invocationDir).mode & 0o777, 0o700);
			const systemFile = valueAfter(harness.args, "--system-prompt-file");
			assert.ok(systemFile?.startsWith(invocationDir));
			assert.equal(lstatSync(systemFile).mode & 0o777, 0o600);
			assert.equal(valueAfter(harness.args, "--system-prompt"), undefined);
			assert.match(valueAfter(harness.args, "--debug-file"), /claude-print-debug-/);

			writeFileSync(readyFile, "ready\n", { flag: "wx", mode: 0o600 });
			await waitFor(() => harness.child.stdin.chunks.length === 1);
			assert.equal(lstatSync(readyFile).mode & 0o777, 0o600);
			assert.deepEqual(JSON.parse(harness.child.stdin.text()), {
				type: "user",
				message: { role: "user", content: "USER" },
				parent_tool_use_id: null,
				session_id: "",
			});
			assert.equal(harness.child.stdin.finishedByDriver, false, "stdin must remain open before terminal result");

			harness.child.stdout.write(terminalRecords());
			await waitFor(() => harness.child.stdin.finishedByDriver);
			harness.child.close(0, null);
			assert.deepEqual(await handle.done, { stopReason: "result", sessionId: SESSION, exitCode: 0, signal: null });
			assert.deepEqual(phases, ["ready", "promptSubmitted", "turnAccepted", "terminal"]);
			assert.equal(existsSync(invocationDir), false, "private invocation artifacts must be removed");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("times out pre-submit, emits explicit error, reaps group, and cleans artifacts", async () => {
		const root = mkdtempSync(join(tmpdir(), "pcb-print-timeout-"));
		const harness = fakeSpawnHarness();
		const events = [];
		const signals = [];
		try {
			const handle = spawnClaudePrint(baseConfig(), {
				onEvent: (event) => events.push(event),
				logger: QUIET,
				tmpDir: root,
				diagnosticsDir: root,
				spawnImpl: harness.spawn.bind(harness),
				env: { CLAUDE_BRIDGE_MCP_READY_TIMEOUT_MS: "15" },
				graceMs: 5,
				killProcessGroup: (_pid, signal) => {
					signals.push(signal);
					if (signal === "SIGKILL") harness.child.close(null, "SIGKILL");
				},
			});
			const invocationDir = join(readyPathFromArgs(harness.args), "..");
			const result = await handle.done;
			assert.equal(result.stopReason, "error");
			assert.equal(harness.child.stdin.text(), "");
			assert.match(events.find((event) => event.kind === "error")?.errorMessage ?? "", /readiness timed out after 15ms/);
			assert.deepEqual(signals, ["SIGINT", "SIGKILL"]);
			assert.equal(existsSync(invocationDir), false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("caller abort before readiness writes no frame and escalates detached process-group termination", async () => {
		const root = mkdtempSync(join(tmpdir(), "pcb-print-abort-"));
		const harness = fakeSpawnHarness();
		const signals = [];
		try {
			const handle = spawnClaudePrint(baseConfig(), {
				onEvent() {},
				logger: QUIET,
				tmpDir: root,
				diagnosticsDir: root,
				spawnImpl: harness.spawn.bind(harness),
				env: { CLAUDE_BRIDGE_MCP_READY_TIMEOUT_MS: "1000" },
				graceMs: 5,
				killProcessGroup: (_pid, signal) => {
					signals.push(signal);
					if (signal === "SIGKILL") harness.child.close(null, "SIGKILL");
				},
			});
			const invocationDir = join(readyPathFromArgs(harness.args), "..");
			handle.abort();
			const result = await handle.done;
			assert.equal(result.stopReason, "aborted");
			assert.equal(harness.child.stdin.text(), "");
			assert.deepEqual(signals, ["SIGINT", "SIGKILL"]);
			assert.equal(existsSync(invocationDir), false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("surfaces process exit before readiness and cleans without submitting", async () => {
		const root = mkdtempSync(join(tmpdir(), "pcb-print-early-exit-"));
		const harness = fakeSpawnHarness();
		const events = [];
		const signals = [];
		try {
			const handle = spawnClaudePrint(baseConfig(), {
				onEvent: (event) => events.push(event),
				logger: QUIET,
				tmpDir: root,
				diagnosticsDir: root,
				spawnImpl: harness.spawn.bind(harness),
				env: { CLAUDE_BRIDGE_MCP_READY_TIMEOUT_MS: "1000" },
				killProcessGroup: (_pid, signal) => signals.push(signal),
			});
			harness.child.close(9, null);
			assert.equal((await handle.done).stopReason, "error");
			assert.equal(harness.child.stdin.text(), "");
			assert.match(events.find((event) => event.kind === "error")?.errorMessage ?? "", /before MCP readiness and prompt submission/);
			assert.deepEqual(signals, ["SIGKILL"], "early leader exit must reap shim descendants");
			assert.deepEqual(readdirSync(root), []);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses driver-neutral stderr identity and emits direct abnormal state dump", async () => {
		const root = mkdtempSync(join(tmpdir(), "pcb-print-diagnostics-"));
		const harness = fakeSpawnHarness();
		const records = [];
		const logger = {
			debug() {},
			info: (record) => records.push(record),
			warn: (record) => records.push(record),
			error: (record) => records.push(record),
		};
		try {
			const handle = spawnClaudePrint(baseConfig(), {
				onEvent() {},
				logger,
				tmpDir: root,
				diagnosticsDir: root,
				spawnImpl: harness.spawn.bind(harness),
				env: { CLAUDE_BRIDGE_MCP_READY_TIMEOUT_MS: "1000" },
				killProcessGroup() {},
				isHeldRound: () => true,
			});
			harness.child.stderr.write("DIRECT_STDERR_MARKER\n");
			harness.child.close(9, null);
			assert.equal((await handle.done).stopReason, "error");

			const stderrRecord = records.find((record) => record?.event === "driver.lifecycle.stderrFile");
			assert.equal(stderrRecord?.driver, "claude-print");
			assert.match(stderrRecord?.file ?? "", /driver-claude-print-stderr-/);
			assert.match(readFileSync(stderrRecord.file, "utf8"), /DIRECT_STDERR_MARKER/);

			const dump = records.find((record) => record?.event === "driver.lifecycle.stateDump");
			assert.equal(dump?.driver, "claude-print");
			assert.equal(dump?.heldRound, true);
			assert.equal(dump?.submitted, false);
			assert.deepEqual(dump?.stderrTail, ["DIRECT_STDERR_MARKER"]);
			assert.equal(typeof dump?.pendingBufferBytes, "number");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("cleans private artifacts when spawn throws synchronously", async () => {
		const root = mkdtempSync(join(tmpdir(), "pcb-print-spawn-fail-"));
		const events = [];
		try {
			const handle = spawnClaudePrint(baseConfig(), {
				onEvent: (event) => events.push(event),
				logger: QUIET,
				tmpDir: root,
				diagnosticsDir: root,
				spawnImpl() { throw new Error("injected spawn failure"); },
			});
			assert.equal((await handle.done).stopReason, "error");
			assert.match(events[0]?.errorMessage ?? "", /injected spawn failure/);
			assert.deepEqual(readdirSync(root), []);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("resolveClaudePrintReadyTimeoutMs", () => {
	it("defaults to 30 seconds and accepts only bounded positive integers", () => {
		assert.equal(resolveClaudePrintReadyTimeoutMs({}), CLAUDE_PRINT_DEFAULT_READY_TIMEOUT_MS);
		assert.equal(resolveClaudePrintReadyTimeoutMs({ CLAUDE_BRIDGE_MCP_READY_TIMEOUT_MS: "42" }), 42);
		for (const value of ["0", "-1", "1.5", "x", "2147483648", " 42 "]) {
			assert.throws(() => resolveClaudePrintReadyTimeoutMs({ CLAUDE_BRIDGE_MCP_READY_TIMEOUT_MS: value }), /positive integer.*2147483647/);
		}
	});
	assert.equal(CLAUDE_PRINT_ABORT_GRACE_MS, 2000);
});

describe("CLAUDE_PRINT_DRIVER adapter integration", () => {
	it("submitted warm failure retries on same driver with fresh session and canonical cold config", async () => {
		// claude-print-driver.direct-failure-and-retry-preserve-side-effect-safety
		// bridge-driver-selection.driver-failures-never-trigger-cross-driver-fallback
		const calls = [];
		const lifecycle = [];
		const restorePreflight = __setClaudePrintPreflightForTests(() => {});
		const restoreSpawn = __setSpawnClaudePrintForTests((cfg, options) => {
			calls.push(cfg);
			const attempt = calls.length;
			queueMicrotask(() => {
				options.onPhase?.("ready");
				options.onPhase?.("promptSubmitted");
				if (attempt === 1) options.onEvent({ kind: "error", errorMessage: "submitted attempt failed" });
			});
			return {
				pid: 80 + attempt,
				abort() {},
				done: Promise.resolve({
					stopReason: attempt === 1 ? "error" : "result",
					sessionId: cfg.session.sessionId,
					exitCode: attempt === 1 ? 2 : 0,
					signal: null,
				}),
			};
		});
		try {
			const warm = baseConfig({
				prompt: { kind: "positional", text: "WARM DELTA ONLY" },
				session: { kind: "resume", sessionId: RESUME },
			});
			const handle = CLAUDE_PRINT_DRIVER.spawnMainTurn({
				config: warm,
				options: {
					onEvent() {},
					onLifecycleEvent: (event) => lifecycle.push(event),
					logger: QUIET,
					executable: "claude",
					suppressResumeReplay: true,
					diagnosticsDir: "/tmp",
					isHeldRound: () => false,
				},
				resilience: {
					maxRetries: 2,
					shouldRetry: () => true,
					freshSessionId: () => "fresh-retry-session",
					coldRetryConfig: (sessionId) => baseConfig({
						prompt: { kind: "positional", text: "FULL CANONICAL COLD HISTORY" },
						session: { kind: "fresh", sessionId },
					}),
				},
			});
			const result = await handle.done;
			assert.equal(result.stopReason, "result");
			assert.equal(calls.length, 2, "one same-driver retry");
			assert.deepEqual(calls[0].session, { kind: "resume", sessionId: RESUME });
			assert.deepEqual(calls[1].session, { kind: "fresh", sessionId: "fresh-retry-session" });
			assert.equal(calls[1].prompt.text, "FULL CANONICAL COLD HISTORY");
			assert.ok(!calls[1].prompt.text.includes("WARM DELTA ONLY"));
			assert.equal(lifecycle.filter((event) => event.kind === "retrying").length, 1);
			assert.equal(lifecycle.filter((event) => event.kind === "spawned").length, 2);
		} finally {
			restoreSpawn();
			restorePreflight();
		}
	});

	it("visible direct delta closes retry gate", async () => {
		// claude-print-driver.direct-failure-and-retry-preserve-side-effect-safety
		let spawns = 0;
		const surfaced = [];
		const restorePreflight = __setClaudePrintPreflightForTests(() => {});
		const restoreSpawn = __setSpawnClaudePrintForTests((cfg, options) => {
			spawns++;
			options.onEvent({ kind: "text-delta", text: "visible" });
			options.onEvent({ kind: "error", errorMessage: "failed after visible output" });
			return {
				pid: 90,
				abort() {},
				done: Promise.resolve({ stopReason: "error", sessionId: cfg.session.sessionId, exitCode: 2, signal: null }),
			};
		});
		try {
			const handle = CLAUDE_PRINT_DRIVER.spawnMainTurn({
				config: baseConfig(),
				options: {
					onEvent: (event) => surfaced.push(event),
					logger: QUIET,
					executable: "claude",
					suppressResumeReplay: false,
					diagnosticsDir: "/tmp",
					isHeldRound: () => false,
				},
				resilience: { maxRetries: 2, shouldRetry: () => true, freshSessionId: () => "must-not-spawn" },
			});
			assert.equal((await handle.done).stopReason, "error");
			assert.equal(spawns, 1);
			assert.ok(surfaced.some((event) => event.kind === "error"));
		} finally {
			restoreSpawn();
			restorePreflight();
		}
	});

	it("keeps concurrent direct handles' abort/session/event state isolated", async () => {
		// claude-print-driver.direct-concurrent-invocations-are-isolated
		const attempts = new Map();
		const restorePreflight = __setClaudePrintPreflightForTests(() => {});
		const restoreSpawn = __setSpawnClaudePrintForTests((cfg, options) => {
			let resolveDone;
			const done = new Promise((resolve) => { resolveDone = resolve; });
			attempts.set(cfg.session.sessionId, { cfg, options, resolveDone, aborted: false });
			return {
				pid: cfg.session.sessionId === "isolation-a" ? 501 : 502,
				abort() {
					const attempt = attempts.get(cfg.session.sessionId);
					attempt.aborted = true;
					resolveDone({ stopReason: "aborted", sessionId: cfg.session.sessionId, exitCode: null, signal: "SIGINT" });
				},
				done,
			};
		});
		try {
			const spawn = (sessionId, events) => CLAUDE_PRINT_DRIVER.spawnMainTurn({
				config: baseConfig({ session: { kind: "fresh", sessionId } }),
				options: {
					onEvent: (event) => events.push(event),
					logger: QUIET,
					executable: "claude",
					suppressResumeReplay: false,
					diagnosticsDir: "/tmp",
					isHeldRound: () => false,
				},
				resilience: { shouldRetry: () => false },
			});
			const eventsA = [];
			const eventsB = [];
			const handleA = spawn("isolation-a", eventsA);
			const handleB = spawn("isolation-b", eventsB);
			handleA.abort();
			attempts.get("isolation-b").options.onEvent({ kind: "text-delta", text: "only-b" });
			attempts.get("isolation-b").resolveDone({ stopReason: "result", sessionId: "isolation-b", exitCode: 0, signal: null });
			assert.equal((await handleA.done).stopReason, "aborted");
			assert.equal((await handleB.done).stopReason, "result");
			assert.equal(attempts.get("isolation-a").aborted, true);
			assert.equal(attempts.get("isolation-b").aborted, false);
			assert.deepEqual(eventsA, []);
			assert.deepEqual(eventsB, [{ kind: "text-delta", text: "only-b" }]);
		} finally {
			restoreSpawn();
			restorePreflight();
		}
	});

	it("selects direct adapter, runs version preflight before spawn, and returns normalized lifecycle handle", async () => {
		const calls = [];
		const restorePreflight = __setClaudePrintPreflightForTests(() => calls.push("preflight"));
		const restoreSpawn = __setSpawnClaudePrintForTests((cfg, options) => {
			calls.push(["spawn", cfg, options]);
			return {
				pid: 88,
				abort() { calls.push("abort"); },
				done: Promise.resolve({ stopReason: "result", sessionId: cfg.session.sessionId, exitCode: 0, signal: null }),
			};
		});
		try {
			__resetClaudePrintVersionProbeForTests();
			assert.equal(getInferenceDriverAdapter("claude-print"), CLAUDE_PRINT_DRIVER);
			const lifecycle = [];
			const handle = CLAUDE_PRINT_DRIVER.spawnMainTurn({
				config: baseConfig(),
				options: {
					onEvent() {},
					onLifecycleEvent: (event) => lifecycle.push(event),
					logger: QUIET,
					executable: "claude",
					suppressResumeReplay: false,
					diagnosticsDir: "/tmp",
					isHeldRound: () => false,
				},
				resilience: { shouldRetry: () => false },
			});
			assert.equal(calls[0], "preflight");
			assert.equal(calls[1][0], "spawn");
			assert.equal(handle.driverKind, "claude-print");
			assert.equal(handle.pid, 88);
			await handle.done;
			assert.deepEqual(lifecycle.map((event) => event.kind), ["spawned", "settled"]);
		} finally {
			restoreSpawn();
			restorePreflight();
		}
	});
});
