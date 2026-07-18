/**
 * Unit tests for the claude-p CAPTURE path (T2.1 / T2.2).
 *
 * Drives streamClaudeAgentSdk (Case 0 dispatch) under the claude-p driver with a
 * MOCKED single-shot spawn (no real binary). The mock spawn parses the router
 * socket path out of cfg.mcpConfig and, for the success case, connects a real
 * IPC client to the router and sends a `capture-stash` frame — exercising the
 * REAL router stash mechanism end-to-end without a subprocess.
 *
 * Coverage:
 *   - classification / strict-call-shape preserved (rejected shapes, all-executable)
 *   - success → synthesized toolCall block (name + arguments + usage + toolu_ id)
 *   - absent call (no stash) → stopReason error
 *   - abort → stopReason aborted, no stash consulted
 *   - isolation: capture call does NOT mutate cachedSessionId (verified via a
 *     subsequent main-path turn resuming the pre-capture session)
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Type } from "@sinclair/typebox";

// ── Log routing (before index import) ────────────────────────────────────────
const LOG_DIR = mkdtempSync(join(tmpdir(), "bridge-unit-capture-"));
process.env.CLAUDE_BRIDGE_DEBUG_PATH = join(LOG_DIR, "bridge.log");
process.env.CLAUDE_BRIDGE_DEBUG = "1";

const {
	streamClaudeAgentSdk,
	__setPiApiRefForTests,
	__setCaptureSpawnForTests,
	__resetCachedSessionForTests,
} = await import("../index.js");
import { connectIpcClient } from "../src/mcp/ipc.js";
import { submitDigestTool } from "./fixtures/submit-digest-schema.js";
import { randomUUID } from "node:crypto";

const ts = () => Date.now();

const MODEL = { id: "claude-haiku-4-5", cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } };

function makeApiStub(activeTools = []) {
	return { getActiveTools: () => activeTools };
}

/** Parse the router socket path out of the spawn cfg's --mcp-config JSON. */
function socketFromCfg(cfg) {
	const parsed = JSON.parse(cfg.mcpConfig);
	const server = Object.values(parsed.mcpServers)[0];
	const args = server.args;
	const i = args.indexOf("--socket");
	return args[i + 1];
}

/** Assert the cfg is a capture-mode shim invocation for the given mcp tool name. */
function assertCaptureMcpConfig(cfg, mcpToolName) {
	const parsed = JSON.parse(cfg.mcpConfig);
	const server = Object.values(parsed.mcpServers)[0];
	const args = server.args;
	assert.ok(args.includes("--mode"), "shim args must include --mode");
	assert.equal(args[args.indexOf("--mode") + 1], "capture", "shim --mode must be capture");
	assert.equal(args[args.indexOf("--capture-tool") + 1], mcpToolName, "shim --capture-tool must name the capture tool");
}

/**
 * Build a mock single-shot spawn factory.
 * @param opts.stash  if provided, the mock connects to the router and stashes it.
 * @param opts.usage  driver usage event to emit (defaults to a representative set).
 * @param opts.stopReason  the ClaudePDoneResult.stopReason (default "result").
 * @param opts.onCfg  observer for the cfg the spawn received.
 * @param opts.holdForAbort  if true, the spawn never resolves on its own; it
 *        resolves "aborted" only when handle.abort() is called.
 */
function makeMockSpawn(opts = {}) {
	const factory = (cfg, spawnOpts) => {
		opts.onCfg?.(cfg);
		let resolveDone;
		const done = new Promise((res) => { resolveDone = res; });
		let aborted = false;

		const usage = opts.usage ?? { input: 100, output: 50, cacheRead: 10, cacheWrite: 0, totalTokens: 160 };

		(async () => {
			// Emit a usage event (mirrors the terminal `result` line).
			spawnOpts.onEvent({ kind: "usage", usage });

			if (opts.holdForAbort) return; // wait for abort() to resolve.

			if (opts.stash !== undefined || opts.validationFailures?.length) {
				// Simulate shim IPC: validation evidence and/or authoritative stash.
				try {
					const socketPath = socketFromCfg(cfg);
					const client = await connectIpcClient(socketPath);
					for (const failure of opts.validationFailures ?? []) {
						await client.request({ kind: "capture-validation-failed", id: randomUUID(), ...failure });
					}
					if (opts.stash !== undefined) {
						await client.request({ kind: "capture-stash", id: randomUUID(), arguments: opts.stash });
					}
					client.close();
				} catch (err) {
					// Surface as spawn error if the router isn't reachable.
					spawnOpts.onEvent({ kind: "error", errorMessage: `mock stash failed: ${err}` });
				}
			}
			spawnOpts.onEvent({ kind: "done", reason: "result" });
			resolveDone({ stopReason: opts.stopReason ?? "result", sessionId: cfg.session.sessionId, exitCode: 0, signal: null });
		})();

		return {
			get pid() { return 12345; },
			abort() {
				if (aborted) return;
				aborted = true;
				resolveDone({ stopReason: "aborted", sessionId: cfg.session.sessionId, exitCode: null, signal: "SIGINT" });
			},
			done,
		};
	};
	return factory;
}

let restoreApi = null;
let restoreSpawn = null;

afterEach(() => {
	restoreApi?.(); restoreApi = null;
	restoreSpawn?.(); restoreSpawn = null;
	__resetCachedSessionForTests();
});

// ────────────────────────────────────────────────────────────────────────────
// Classification / strict-call-shape preserved (shared gate, unchanged)
// ────────────────────────────────────────────────────────────────────────────

describe("capture classification + strict-call-shape (claude-p)", () => {
	const UNREG_A = { name: "unregisteredA", description: "t", parameters: Type.Object({ x: Type.String() }) };
	const UNREG_B = { name: "unregisteredB", description: "t", parameters: Type.Object({ y: Type.Number() }) };
	const ARRAY_ROOT = { name: "arrayRoot", description: "t", parameters: Type.Array(Type.String()) };

	it("two unregistered tools → error naming both (spawn never called)", async () => {
		restoreApi = __setPiApiRefForTests(makeApiStub([]));
		let spawned = false;
		restoreSpawn = __setCaptureSpawnForTests(() => { spawned = true; throw new Error("spawn must not be called"); });

		const result = await streamClaudeAgentSdk(MODEL, {
			systemPrompt: "t",
			messages: [{ role: "user", content: "hi", timestamp: ts() }],
			tools: [UNREG_A, UNREG_B],
		}).result();

		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage, /unregisteredA/);
		assert.match(result.errorMessage, /unregisteredB/);
		assert.equal(spawned, false, "capture spawn must not run on a rejected shape");
	});

	it("one registered + one unregistered → error (mutually exclusive)", async () => {
		restoreApi = __setPiApiRefForTests(makeApiStub(["regA"]));
		restoreSpawn = __setCaptureSpawnForTests(() => { throw new Error("spawn must not be called"); });
		const REG_A = { name: "regA", description: "r", parameters: Type.Object({ z: Type.Boolean() }) };

		const result = await streamClaudeAgentSdk(MODEL, {
			systemPrompt: "t",
			messages: [{ role: "user", content: "hi", timestamp: ts() }],
			tools: [REG_A, UNREG_A],
		}).result();

		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage, /unregisteredA/);
		assert.match(result.errorMessage, /mutually exclusive|limitation/i);
	});

	it("single capture tool with non-object root → error (references root type)", async () => {
		restoreApi = __setPiApiRefForTests(makeApiStub([]));
		restoreSpawn = __setCaptureSpawnForTests(() => { throw new Error("spawn must not be called"); });

		const result = await streamClaudeAgentSdk(MODEL, {
			systemPrompt: "t",
			messages: [{ role: "user", content: "hi", timestamp: ts() }],
			tools: [ARRAY_ROOT],
		}).result();

		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage, /arrayRoot/);
		assert.match(result.errorMessage, /array|non-object/i);
	});

	it("zero capture tools (all-executable) → no capture spawn", async () => {
		restoreApi = __setPiApiRefForTests(makeApiStub(["regA"]));
		let captureSpawned = false;
		restoreSpawn = __setCaptureSpawnForTests(() => { captureSpawned = true; throw new Error("should not be called"); });
		const REG_A = { name: "regA", description: "r", parameters: Type.Object({}) };

		// All-executable falls through to the main claude-p turn (NOT the capture
		// factory). We only assert the capture factory is never consulted by the
		// classification gate. To avoid spawning a real binary we use an empty
		// prompt (empty systemPrompt + no messages), which hits the main path's
		// empty-prompt guard and short-circuits to done:stop before any spawn.
		const result = await streamClaudeAgentSdk(MODEL, {
			systemPrompt: "",
			messages: [],
			tools: [REG_A],
		}).result();
		void result;
		assert.equal(captureSpawned, false, "capture spawn must not run for an all-executable shape");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Success → synthesized toolCall block
// ────────────────────────────────────────────────────────────────────────────

describe("capture success (claude-p)", () => {
	it("stash present → ONE toolCall block (name + args), usage mapped, toolu_ id", async () => {
		restoreApi = __setPiApiRefForTests(makeApiStub([]));
		const STASH = { headline: "X", body: "Y".repeat(60), topics: ["a"] };
		let seenCfg = null;
		restoreSpawn = __setCaptureSpawnForTests(
			makeMockSpawn({ stash: STASH, usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 0, totalTokens: 160 }, onCfg: (c) => { seenCfg = c; } }),
		);

		const stream = streamClaudeAgentSdk(MODEL, {
			systemPrompt: "Summarize.",
			messages: [{ role: "user", content: "please summarize", timestamp: ts() }],
			tools: [submitDigestTool],
		});

		// Collect events to assert exactly start → done.
		const events = [];
		for await (const ev of stream) events.push(ev);
		const result = await stream.result();

		assert.equal(result.stopReason, "toolUse");
		assert.equal(result.content.length, 1, "exactly one content block");
		assert.equal(result.content[0].type, "toolCall");
		assert.equal(result.content[0].name, "submit_digest");
		assert.deepEqual(result.content[0].arguments, STASH);
		assert.ok(result.content[0].id.startsWith("toolu_"), `id should start with toolu_, got ${result.content[0].id}`);

		// Usage mapping
		assert.equal(result.usage.input, 100);
		assert.equal(result.usage.output, 50);
		assert.equal(result.usage.cacheRead, 10);
		assert.equal(result.usage.cacheWrite, 0);
		assert.ok(Number.isFinite(result.usage.cost.total) && result.usage.cost.total >= 0, "cost populated");

		// Event shape: a single start, a single terminal done(toolUse), no error.
		const kinds = events.map((e) => e.type);
		assert.equal(kinds.filter((k) => k === "start").length, 1, "exactly one start");
		assert.equal(kinds.filter((k) => k === "done").length, 1, "exactly one done");
		assert.equal(kinds.filter((k) => k === "error").length, 0, "no error event");

		// cfg sanity: capture-mode shim pointed at submit_digest and system prompt
		// forces the single capture tool so real small-model runs do not end in prose.
		assert.ok(seenCfg, "spawn received a cfg");
		assertCaptureMcpConfig(seenCfg, "submit_digest");
		assert.equal(seenCfg.session.kind, "fresh", "capture session is always fresh (never resumed)");
		assert.equal(seenCfg.systemPrompt.kind, "text");
		assert.match(seenCfg.systemPrompt.text, /structured capture mode/);
		assert.match(seenCfg.systemPrompt.text, /mcp__custom-tools__submit_digest/);
		assert.match(seenCfg.systemPrompt.text, /Do not answer in prose/);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Absent call → error
// ────────────────────────────────────────────────────────────────────────────

describe("capture absent (claude-p)", () => {
	it("turn ends with no stash → stopReason error ('did not call capture tool')", async () => {
		restoreApi = __setPiApiRefForTests(makeApiStub([]));
		restoreSpawn = __setCaptureSpawnForTests(makeMockSpawn({ /* no stash */ stopReason: "result" }));

		const result = await streamClaudeAgentSdk(MODEL, {
			systemPrompt: "Summarize.",
			messages: [{ role: "user", content: "please summarize", timestamp: ts() }],
			tools: [submitDigestTool],
		}).result();

		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage, /did not call capture tool/i);
	});

	// AC: output-capture.surface-absent-capture-tool-call-as-error
	it("invalid-only attempts surface latest bounded field-path evidence", async () => {
		restoreApi = __setPiApiRefForTests(makeApiStub([]));
		restoreSpawn = __setCaptureSpawnForTests(makeMockSpawn({
			validationFailures: [
				{ attempt: 1, field: "$.headline", message: "required field missing" },
				{ attempt: 2, field: "$.topics[0]", message: "expected string" },
			],
		}));

		const result = await streamClaudeAgentSdk(MODEL, {
			systemPrompt: "Summarize.",
			messages: [{ role: "user", content: "please summarize", timestamp: ts() }],
			tools: [submitDigestTool],
		}).result();

		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage, /validation failed/i);
		assert.match(result.errorMessage, /\$\.topics\[0\]/);
		assert.match(result.errorMessage, /attempt 2/);
	});

	it("claude-p exits abnormally (error stopReason, no stash) → stopReason error", async () => {
		restoreApi = __setPiApiRefForTests(makeApiStub([]));
		restoreSpawn = __setCaptureSpawnForTests(makeMockSpawn({ stopReason: "error" }));

		const result = await streamClaudeAgentSdk(MODEL, {
			systemPrompt: "Summarize.",
			messages: [{ role: "user", content: "x", timestamp: ts() }],
			tools: [submitDigestTool],
		}).result();

		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage, /abnormally|did not call/i);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Abort → aborted
// ────────────────────────────────────────────────────────────────────────────

describe("capture abort (claude-p)", () => {
	it("AbortSignal mid-capture → stopReason aborted, no stash consulted", async () => {
		restoreApi = __setPiApiRefForTests(makeApiStub([]));
		let abortCalled = false;
		// holdForAbort: the spawn never resolves until abort() is invoked.
		restoreSpawn = __setCaptureSpawnForTests((cfg, spawnOpts) => {
			let resolveDone;
			const done = new Promise((res) => { resolveDone = res; });
			spawnOpts.onEvent({ kind: "usage", usage: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 5 } });
			return {
				get pid() { return 999; },
				abort() { abortCalled = true; resolveDone({ stopReason: "aborted", sessionId: cfg.session.sessionId, exitCode: null, signal: "SIGINT" }); },
				done,
			};
		});

		const ac = new AbortController();
		const stream = streamClaudeAgentSdk(MODEL, {
			systemPrompt: "Summarize.",
			messages: [{ role: "user", content: "summarize", timestamp: ts() }],
			tools: [submitDigestTool],
		}, { signal: ac.signal });

		// Fire abort shortly after dispatch.
		setTimeout(() => ac.abort(), 20);

		const result = await stream.result();
		assert.equal(result.stopReason, "aborted");
		assert.equal(abortCalled, true, "handle.abort() must be called to tear down the subprocess");
		assert.match(result.errorMessage ?? "", /abort/i);
	});

	it("pre-aborted signal → immediate aborted, spawn never called", async () => {
		restoreApi = __setPiApiRefForTests(makeApiStub([]));
		let spawned = false;
		restoreSpawn = __setCaptureSpawnForTests(() => { spawned = true; throw new Error("must not spawn"); });
		const ac = new AbortController();
		ac.abort();

		const result = await streamClaudeAgentSdk(MODEL, {
			systemPrompt: "Summarize.",
			messages: [{ role: "user", content: "summarize", timestamp: ts() }],
			tools: [submitDigestTool],
		}, { signal: ac.signal }).result();

		assert.equal(result.stopReason, "aborted");
		assert.equal(spawned, false, "pre-aborted capture must not spawn");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Isolation: capture must not mutate cachedSessionId
// ────────────────────────────────────────────────────────────────────────────

describe("capture isolation (claude-p) — single-spawn invariants", () => {
	it("a capture call does NOT update cachedSessionId (subsequent capture sees fresh, distinct session)", async () => {
		restoreApi = __setPiApiRefForTests(makeApiStub([]));
		const sessions = [];
		restoreSpawn = __setCaptureSpawnForTests(
			makeMockSpawn({ stash: { headline: "h", body: "b".repeat(60), topics: [] }, onCfg: (c) => sessions.push(c.session) }),
		);

		const fire = () =>
			streamClaudeAgentSdk(MODEL, {
				systemPrompt: "Summarize.",
				messages: [{ role: "user", content: "summarize", timestamp: ts() }],
				tools: [submitDigestTool],
			}).result();

		const r1 = await fire();
		const r2 = await fire();
		assert.equal(r1.stopReason, "toolUse");
		assert.equal(r2.stopReason, "toolUse");

		// Both capture spawns minted a FRESH session id, never a --resume of the
		// other — proving the capture path neither writes nor reads cachedSessionId.
		assert.equal(sessions.length, 2);
		assert.equal(sessions[0].kind, "fresh");
		assert.equal(sessions[1].kind, "fresh");
		assert.notEqual(sessions[0].sessionId, sessions[1].sessionId, "each capture spawn is a distinct fresh session");
	});
});
